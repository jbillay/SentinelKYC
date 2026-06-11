-- R2 — Durable run execution: cross-process SSE event transport.
--
-- When runs execute in a separate worker process (RUN_EXECUTION=queue) the web
-- process's SSE handler can no longer read the worker's in-memory event buffer.
-- `run_events` is the durable, replayable channel that crosses the process
-- boundary: the worker appends every SSE event here (in per-thread `seq` order)
-- and fires NOTIFY run_events '<thread_id>'; the web SSE handler LISTENs, then
-- replays the tail (seq > cursor) from this table. It also makes replay-on-
-- reconnect survive a web restart — the buffer no longer lives only in memory.
--
-- Written by: services/eventSink.js NotifySink (worker) + the queue enqueue
-- marker. Read by: services/runEventsBus.js (web SSE LISTEN/replay) and the
-- DB-backed /api/runs/active snapshot.
--
-- No FK to runs(thread_id): the enqueue marker event is written before the run
-- row exists (runs are created lazily on the first companyNumber). Rows are
-- reaped by age via repo.reapRunEvents() so the table can't grow unbounded.

CREATE TABLE IF NOT EXISTS "run_events" (
  "id" bigserial PRIMARY KEY,
  "thread_id" text NOT NULL,
  "seq" integer NOT NULL,
  "payload" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);--> statement-breakpoint

-- Primary read path: replay the tail for one thread in seq order
-- (services/runEventsBus.js: WHERE thread_id = $1 AND seq > $2 ORDER BY seq).
-- UNIQUE so a double-append racing the per-thread seq counter can't duplicate
-- the stream (the NotifySink serialises writes; this is defence in depth) — and
-- the unique index also serves the ordered tail scan.
CREATE UNIQUE INDEX IF NOT EXISTS "run_events_thread_seq_uniq"
  ON "run_events" ("thread_id", "seq");--> statement-breakpoint

-- Liveness / observability: which worker process is driving a run. Nullable —
-- inline-mode runs and pre-R2 rows leave it null.
ALTER TABLE "runs"
  ADD COLUMN IF NOT EXISTS "worker_id" text;
