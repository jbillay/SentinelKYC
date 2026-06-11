-- Phase 3 — Party-level screening overrides.
--
-- The existing `dossier_screening_overrides` table scoped overrides to a
-- single dossier — reviewer dismisses "John Smith vs OFAC entry XYZ" on
-- Dossier A and it doesn't apply to Dossier B where the same John Smith
-- also appears.
--
-- This table is the cross-dossier override: keyed by party_id, so the
-- dismissal applies wherever that party shows up. Created by:
--   * `PATCH /api/parties/:id/overrides` — direct write from the Party
--     Detail page.
--   * The existing `carry-overrides-forward` route — when the run has a
--     party-keyed hit, the override is written here instead of (or in
--     addition to) the dossier-level table.
--
-- The dossier-level table stays in place for backward compatibility with
-- pre-Phase-2 runs whose hits have no party_id.

CREATE TABLE IF NOT EXISTS "party_screening_overrides" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "party_id" uuid NOT NULL REFERENCES "parties"("id") ON DELETE CASCADE,
  "list_source" text NOT NULL,
  "list_entry_id" text,
  "evidence_url" text,
  "decision" text NOT NULL CHECK ("decision" IN ('confirmed', 'dismissed')),
  "reason" text,
  "applied_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  -- Same uniqueness shape as dossier_screening_overrides so the upsert
  -- semantics carry over: one decision per (party, list, entry, evidence).
  CONSTRAINT "party_screening_overrides_unique"
    UNIQUE ("party_id", "list_source", "list_entry_id", "evidence_url")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "party_screening_overrides_party_idx"
  ON "party_screening_overrides" ("party_id");--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "party_screening_overrides_list_idx"
  ON "party_screening_overrides" ("list_source", "list_entry_id");
