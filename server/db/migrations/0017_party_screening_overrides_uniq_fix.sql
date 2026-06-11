-- Phase 3 fix — party_screening_overrides uniqueness.
--
-- The Phase 3 migration declared the uniqueness as a CONSTRAINT, which uses
-- the SQL-standard "NULL is distinct from NULL" semantics. In practice that
-- means two override rows with the same (party_id, list_source) but a
-- NULL list_entry_id (or NULL evidence_url) don't collide — so upsert
-- behaves as insert. Smoke run 1 caught this when the second
-- setPartyScreeningOverride call produced a fresh row instead of updating
-- the first.
--
-- Switch to a partial-unique INDEX with COALESCE on the nullable
-- discriminators. Same pattern as party_links_uniq in 0014 — a sentinel
-- date there, an empty string here.

ALTER TABLE "party_screening_overrides"
  DROP CONSTRAINT IF EXISTS "party_screening_overrides_unique";--> statement-breakpoint

CREATE UNIQUE INDEX IF NOT EXISTS "party_screening_overrides_unique"
  ON "party_screening_overrides" (
    "party_id",
    "list_source",
    COALESCE("list_entry_id", ''),
    COALESCE("evidence_url", '')
  );
