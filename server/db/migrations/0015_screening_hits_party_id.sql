-- Phase 2 — Thread the resolver's party_id through the screening machinery.
--
-- Each screening_hits row already carries a synthetic subject_id (string,
-- per-run unique). Adding party_id lets us aggregate hits across runs and
-- across dossiers per party, and is the primary key the Phase 3 party-level
-- override path uses to match overrides to incoming hits.
--
-- Nullable + indexed-WHERE-not-null so pre-Phase-2 hits stay valid and the
-- index stays small.

ALTER TABLE "screening_hits"
  ADD COLUMN IF NOT EXISTS "party_id" uuid REFERENCES "parties"("id") ON DELETE SET NULL;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "screening_hits_party_idx"
  ON "screening_hits" ("party_id")
  WHERE "party_id" IS NOT NULL;
