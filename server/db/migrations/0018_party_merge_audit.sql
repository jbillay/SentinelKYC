-- Phase 4 — Merge audit columns on parties.
--
-- The soft-merge pointer (merged_into_party_id) already lived in 0012, but
-- it doesn't capture WHO merged the row, WHEN, or WHY. Adding three nullable
-- columns avoids a separate audit table — the merge action sets them all
-- together on the loser party row when the merge service commits.
--
-- An un-merge would just NULL these three columns and clear
-- merged_into_party_id. Phase 4's UI doesn't expose un-merge yet but the
-- data model supports it.

ALTER TABLE "parties"
  ADD COLUMN IF NOT EXISTS "merged_by" text,
  ADD COLUMN IF NOT EXISTS "merged_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "merge_reason" text;
