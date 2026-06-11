-- Phase 1a — Party Master matcher (name-based entity resolution).
--
-- Adds:
--   * Extensions: unaccent, pg_trgm, fuzzystrmatch.
--   * immutable_unaccent(text) — IMMUTABLE wrapper around the contrib unaccent
--     (so it can back a GENERATED STORED column / trigram GIN index).
--   * name_canonical(text) — IMMUTABLE PARALLEL SAFE canonical-form function.
--     Implements the 4-step spec: lower+unaccent → honorific strip →
--     punctuation rules → token sort. See docs/entity-resolution.md.
--   * parties — the Party Master table (full shape; columns beyond
--     id/full_name/name_canonical are dormant until Phase 1b lights up the
--     resolver / linkage tables).
--   * party_match_log — per-call audit log for the matcher (KYC replay-grade,
--     written even when zero candidates are returned).
--
-- Linkage tables (party_links, party_link_status_history, party_review_queue,
-- party_screening_overrides) and the in-graph resolve_parties node land in
-- Phase 1b/2/3 — explicitly out of scope for this migration.

CREATE EXTENSION IF NOT EXISTS unaccent;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm;--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch;--> statement-breakpoint

-- Contrib unaccent() is STABLE because it depends on the on-disk dictionary
-- file. Wrap it as IMMUTABLE so the canonical function can back a generated
-- column / functional index. Standard Postgres pattern — same trick used in
-- every pg_trgm-on-unaccented-text tutorial.
CREATE OR REPLACE FUNCTION immutable_unaccent(text)
RETURNS text
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
AS $$
  SELECT unaccent('unaccent', $1)
$$;--> statement-breakpoint

-- Canonical-form for KYC name dedup. The full spec lives in
-- docs/entity-resolution.md; the four steps here are:
--
--   1. lower + unaccent
--   2. strip honorifics: mr, mrs, ms, mme, mlle, m, dr, prof, sir, sr, jr
--      (with or without trailing dot; case-insensitive after step 1).
--   3. Punctuation:
--        - apostrophes (ASCII '): REMOVED (so O'Hara → OHara, keeping the
--          two halves contiguous — matches "OHara" written without the
--          apostrophe). The spec table requires this.
--        - everything else non-alphanumeric: REPLACED with a single space
--          (hyphen → split, so Jean-Paul → Jean Paul → tokens split).
--      Collapse consecutive whitespace; trim.
--   4. Tokenise on space, sort tokens alphabetically, rejoin with a single
--      space. Token-set-sort handles "Jeremy Billay" vs "Billay Jeremy".
--
-- IMMUTABLE PARALLEL SAFE — required to back the generated column and the
-- gin_trgm_ops functional index. Deterministic: same input → same output
-- across processes, replicas, and restarts (modulo the unaccent dictionary,
-- which is treated as fixed; see immutable_unaccent above).
CREATE OR REPLACE FUNCTION name_canonical(input text)
RETURNS text
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
AS $func$
  WITH
    -- Step 1: lower + unaccent. Coalesce so a null input becomes ''.
    s1 AS (
      SELECT lower(immutable_unaccent(coalesce(input, ''))) AS v
    ),
    -- Step 2: strip honorifics. Alternation ordered longest-first to avoid
    -- a partial 'm' grab from 'mlle' / 'mme' under leftmost-match. The
    -- surrounding capture (^|[^a-z0-9]) preserves the leading separator;
    -- the lookahead requires a trailing non-alphanumeric or end-of-string,
    -- so 'mary' / 'morten' are safe — only stand-alone honorific tokens
    -- (with optional trailing dot) are removed.
    s2 AS (
      SELECT regexp_replace(
        v,
        '(^|[^a-z0-9])(prof|mlle|mme|mrs|sir|dr|jr|mr|ms|sr|m)\.?(?=[^a-z0-9]|$)',
        '\1 ',
        'g'
      ) AS v FROM s1
    ),
    -- Step 3: apostrophes removed (no space inserted); other punctuation
    -- replaced with a single space; whitespace collapsed; trimmed.
    s3 AS (
      SELECT trim(regexp_replace(
        regexp_replace(
          regexp_replace(v, '''', '', 'g'),
          '[^a-z0-9 ]+', ' ', 'g'
        ),
        '\s+', ' ', 'g'
      )) AS v FROM s2
    ),
    -- Step 4: tokenise, sort, rejoin.
    sorted AS (
      SELECT array_to_string(
        ARRAY(
          SELECT t
          FROM unnest(string_to_array(v, ' ')) AS t
          WHERE t <> ''
          ORDER BY t
        ),
        ' '
      ) AS v FROM s3
    )
  SELECT v FROM sorted
$func$;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Party Master
-- ---------------------------------------------------------------------------
-- Full shape per the Phase-1 design. Only id / full_name / name_canonical
-- are used by the matcher today; all other columns are dormant until the
-- resolver (Phase 1b) starts writing rows.
--
-- party_type is a CHECK constraint (not a pgenum) because adding values to
-- a pgenum later requires ALTER TYPE — and we may want a third type
-- ('trust' / 'partnership') without the migration friction.
CREATE TABLE IF NOT EXISTS "parties" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "party_type" text NOT NULL CHECK ("party_type" IN ('individual', 'organisation')),

  -- Display + canonical
  "full_name" text NOT NULL,
  "name_canonical" text GENERATED ALWAYS AS (name_canonical("full_name")) STORED,

  -- Structured individual fields (Phase 1b will populate)
  "forename" text,
  "middle_names" text,
  "surname" text,
  "title" text,
  "date_of_birth_year" integer,
  "date_of_birth_month" integer,
  "nationality" text[],
  "country_of_residence" text,

  -- Structured organisation fields (Phase 1b will populate)
  "registration_number" text,
  "registration_country" text,
  -- When the organisation is a CH-known UK company we already onboarded,
  -- this points at its dossier row. NULL otherwise (foreign entity, etc.).
  -- ON DELETE SET NULL so deleting the dossier doesn't wipe the party.
  "dossier_id" uuid REFERENCES "dossiers"("id") ON DELETE SET NULL,

  -- Strong cross-company key for individual officers (Phase 1b — appointment
  -- ID extracted from CH's links.officer.appointments URL).
  "ch_officer_appointment_id" text,

  -- Free-form alias / identifier slots used by the resolver in Phase 1b.
  "aliases" jsonb NOT NULL DEFAULT '[]'::jsonb,
  "identifiers" jsonb NOT NULL DEFAULT '{}'::jsonb,

  -- Provenance + dedup state
  "source_kind" text NOT NULL DEFAULT 'manual',
  "needs_review" boolean NOT NULL DEFAULT false,
  "review_reason" text,
  -- Soft-merge: a party can be redirected to another (e.g. after a reviewer
  -- decides two records are the same person). Kept around so historical
  -- references continue to resolve.
  "merged_into_party_id" uuid,

  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- Self-FK added after the table exists (forward-reference workaround).
ALTER TABLE "parties"
  ADD CONSTRAINT "parties_merged_into_fk"
  FOREIGN KEY ("merged_into_party_id") REFERENCES "parties"("id") ON DELETE SET NULL;--> statement-breakpoint

-- Indexes:
--   * btree on name_canonical — backs the Layer-1 exact-equality lookup.
--   * GIN trgm_ops on name_canonical — backs the Layer-2 % similarity query.
--   * UNIQUE NULLS-distinct on the two strong keys (Phase 1b enforces these
--     pre-insert; the index is the safety net).
--   * partial indexes on dossier_id / needs_review for the future Party
--     detail page and review-queue page.
CREATE INDEX IF NOT EXISTS "parties_name_canonical_btree" ON "parties" ("name_canonical");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "parties_name_canonical_trgm" ON "parties" USING gin ("name_canonical" gin_trgm_ops);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "parties_ch_officer_appointment_uniq"
  ON "parties" ("ch_officer_appointment_id")
  WHERE "ch_officer_appointment_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "parties_registration_uniq"
  ON "parties" ("registration_country", "registration_number")
  WHERE "registration_number" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "parties_dossier_idx"
  ON "parties" ("dossier_id")
  WHERE "dossier_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "parties_needs_review_idx"
  ON "parties" ("needs_review")
  WHERE "needs_review" = true;--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Per-call audit log
-- ---------------------------------------------------------------------------
-- Written every time PartyMatchService.findMatches is invoked — by the HTTP
-- endpoint (POST /api/parties/match) and, in Phase 1b, by the in-graph
-- resolve_parties node. Includes zero-match calls. Required for KYC audit
-- replay: a reviewer must be able to reconstruct exactly which candidates
-- a given query saw, in what order, with what scores.
--
-- The graph-step audit (one summary fragment per resolve_parties invocation)
-- lives in decision_fragments; this table is the per-input grain. See the
-- comment in server/services/party/auditLog.js for the rationale.
CREATE TABLE IF NOT EXISTS "party_match_log" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "input_name" text NOT NULL,
  "input_canonical" text NOT NULL,
  "candidates" jsonb NOT NULL,
  "match_count" integer NOT NULL DEFAULT 0,
  "top_score" numeric(4,3),
  "called_by" text NOT NULL,
  "source" text NOT NULL DEFAULT 'api',
  "called_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "party_match_log_called_at_desc"
  ON "party_match_log" ("called_at" DESC);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "party_match_log_called_by_idx"
  ON "party_match_log" ("called_by");
