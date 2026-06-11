-- Phase 1b — Party Master linkage layer.
--
-- Adds:
--   * party_links — many-to-many between parties and dossiers, carrying
--     role (officer/psc/shareholder), status, dates, source_ref. Each row
--     answers: "what role does this party play on this dossier, and is it
--     still active?"
--   * party_link_status_history — immutable transition log. Append-only;
--     CLM audit grade.
--   * party_review_queue — pending dedup decisions. Created when the
--     resolver makes a new party but the name matcher returned HIGH/REVIEW
--     candidates pointing at an existing party. Resolved by a reviewer in
--     Phase 4's UI.
--
-- All linkage rows are written by the resolver service (Phase 1b dark mode)
-- and, from Phase 2 onwards, by the in-graph resolve_parties node. The
-- tables themselves are independent of where writes originate.

CREATE TABLE IF NOT EXISTS "party_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "party_id" uuid NOT NULL REFERENCES "parties"("id") ON DELETE CASCADE,
  "dossier_id" uuid NOT NULL REFERENCES "dossiers"("id") ON DELETE CASCADE,
  "role" text NOT NULL CHECK ("role" IN ('officer', 'psc', 'shareholder')),
  "role_detail" text,
  "status" text NOT NULL CHECK ("status" IN ('active', 'resigned', 'ceased', 'historical')),
  "natures_of_control" text[],
  "shares_count" numeric,
  "shares_percentage" numeric(5, 2),
  "share_class" text,
  "appointed_on" date,
  "resigned_on" date,
  "notified_on" date,
  "ceased_on" date,
  -- Sanitised CH item or extracted-shareholder snapshot. Source-of-truth for
  -- "why did the resolver create this link?" audit questions.
  "source_ref" jsonb,
  "first_seen_run_id" uuid REFERENCES "runs"("id") ON DELETE SET NULL,
  "last_seen_run_id" uuid REFERENCES "runs"("id") ON DELETE SET NULL,
  -- The match score that produced this link (1.0 for strong-key hits,
  -- 0.4–1.0 for name-matcher resolutions). NULL for legacy / manual links.
  "match_confidence" numeric(4, 3),
  -- Which signal drove dedup. Shape:
  --   { kind: 'appointment_id'|'registration_number'|'name_match'|'new',
  --     value?: string, score?: number, confidence?: string,
  --     matchedVia?: string }
  "match_evidence" jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- Idempotency: a re-run of the resolver must hit the SAME logical link.
-- COALESCE the nullable date columns so a NULL appointed_on still
-- participates in the uniqueness constraint (NULLs are otherwise distinct
-- in btree). Sentinel '0001-01-01' is far enough in the past to never
-- collide with a real date.
CREATE UNIQUE INDEX IF NOT EXISTS "party_links_uniq"
  ON "party_links" (
    "party_id",
    "dossier_id",
    "role",
    COALESCE("appointed_on", '0001-01-01'::date),
    COALESCE("notified_on", '0001-01-01'::date)
  );--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "party_links_party_idx" ON "party_links" ("party_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "party_links_dossier_idx" ON "party_links" ("dossier_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "party_links_status_idx" ON "party_links" ("party_id", "status");--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Status transition history (immutable, append-only)
-- ---------------------------------------------------------------------------
-- One row every time party_links.status changes. The "current" status lives
-- on the link itself; this table answers "when did it move, and which run
-- observed the change?" Mirrors the decision_fragments pattern — never
-- mutated after insert.
CREATE TABLE IF NOT EXISTS "party_link_status_history" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "link_id" uuid NOT NULL REFERENCES "party_links"("id") ON DELETE CASCADE,
  "from_status" text,
  "to_status" text NOT NULL,
  "changed_at" timestamptz NOT NULL DEFAULT now(),
  "run_id" uuid REFERENCES "runs"("id") ON DELETE SET NULL,
  "reason" text
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "party_link_status_history_link_idx"
  ON "party_link_status_history" ("link_id", "changed_at" DESC);--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Review queue
-- ---------------------------------------------------------------------------
-- Each row: "the resolver created party_id and noticed candidate_party_id
-- looks similar — reviewer should decide whether to merge them." status
-- starts 'open'; reviewer flips it to 'merged' or 'rejected'.
CREATE TABLE IF NOT EXISTS "party_review_queue" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "party_id" uuid NOT NULL REFERENCES "parties"("id") ON DELETE CASCADE,
  "candidate_party_id" uuid NOT NULL REFERENCES "parties"("id") ON DELETE CASCADE,
  "score" numeric(4, 3) NOT NULL,
  "confidence" text NOT NULL CHECK ("confidence" IN ('EXACT', 'HIGH', 'REVIEW')),
  "matched_via" text NOT NULL CHECK ("matched_via" IN ('token_set', 'trigram', 'phonetic')),
  "evidence" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "status" text NOT NULL DEFAULT 'open' CHECK ("status" IN ('open', 'merged', 'rejected')),
  "raised_by_run_id" uuid REFERENCES "runs"("id") ON DELETE SET NULL,
  "resolved_by" text,
  "resolved_at" timestamptz,
  "resolution_reason" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- At most one OPEN item per (new, candidate) pair — re-runs upsert into the
-- existing open item rather than spawning duplicates. Partial-unique on
-- status='open' so closed history can co-exist with a future re-open.
CREATE UNIQUE INDEX IF NOT EXISTS "party_review_queue_pair_open"
  ON "party_review_queue" ("party_id", "candidate_party_id")
  WHERE "status" = 'open';--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "party_review_queue_status_idx"
  ON "party_review_queue" ("status", "created_at" DESC);
