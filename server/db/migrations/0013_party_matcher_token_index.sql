-- Phase 1a — Party matcher perf hardening.
--
-- The pg_trgm GIN index on name_canonical is selective enough for spelling
-- variants but lossy for multi-token names where individual tokens are
-- common (e.g. "Smith"). On a 100k-row dataset, an exact-corpus lookup
-- returns ~3400 candidate rows from the trigram bitmap, ~168 of which
-- actually pass the 0.4 similarity floor — the BitmapHeapScan recheck on
-- the other ~3200 dominates query time (~95ms p95).
--
-- Add a token-array generated column + GIN index so we can pre-filter by
-- "candidate shares at least one whole token with input" via the `&&`
-- (array-overlap) operator. For a multi-token input, this is dramatically
-- more selective than the trigram bitmap: "alexander james smith" overlaps
-- only with candidates carrying one of those exact tokens, of which there
-- are typically a few hundred in the dataset rather than thousands.
--
-- The token array is GENERATED ALWAYS AS — same pattern as name_canonical,
-- so it auto-updates whenever full_name changes.

ALTER TABLE "parties"
  ADD COLUMN "name_tokens" text[]
  GENERATED ALWAYS AS (
    string_to_array(name_canonical(full_name), ' ')
  ) STORED;--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "parties_name_tokens_gin"
  ON "parties" USING gin ("name_tokens");--> statement-breakpoint

-- Add a GIST trgm index alongside the GIN one. GIN is best for `%` filter
-- (used by spec-strict callers wanting to enumerate all matches above a
-- threshold) but only GIST supports K-NN ordering via the `<->` operator —
-- so the matcher's "top 20 by similarity DESC" can be satisfied directly
-- from the index without a Sort step or a wide BitmapHeapScan recheck.
--
-- Storage cost is meaningful (~20MB on a 100k-row dataset) but for the POC
-- well worth the ceiling drop in p95 latency.
CREATE INDEX IF NOT EXISTS "parties_name_canonical_gist"
  ON "parties" USING gist ("name_canonical" gist_trgm_ops);
