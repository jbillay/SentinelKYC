-- Party watchlist — reviewer-flagged parties tracked across dossiers.
--
-- One row per watched party (party_id unique). Carries who flagged it and
-- why so the watchlist view + audit can explain the entry. Membership is the
-- whole feature for the POC: no alerting, no scheduled re-screen.
--
-- Written by:
--   * POST   /api/parties/:id/watchlist  — flag a party (upsert, idempotent)
--   * DELETE /api/parties/:id/watchlist  — unflag
-- Read by:
--   * GET /api/parties/watchlist         — the Watchlist page's parties tab
--   * GET /api/parties/:id               — surfaces isWatched on the detail

CREATE TABLE IF NOT EXISTS "party_watchlist" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "party_id" uuid NOT NULL REFERENCES "parties"("id") ON DELETE CASCADE,
  "reason" text,
  "added_by" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "party_watchlist_party_unique" UNIQUE ("party_id")
);--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "party_watchlist_party_idx"
  ON "party_watchlist" ("party_id");
