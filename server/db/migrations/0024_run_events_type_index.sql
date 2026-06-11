-- CODE_REVIEW §5.3 — run_events event-type lookups.
--
-- getThreadStreamState / listActiveRunsFromDb filter per thread on
-- payload->>'type' ('interrupt' / 'done' / 'cancelled'); without an index
-- each probe scans the thread's whole jsonb stream. Expression index keyed
-- (thread_id, type, seq DESC) serves both the latest-interrupt and
-- latest-terminal probes directly.
CREATE INDEX IF NOT EXISTS run_events_thread_type_seq_idx
  ON run_events (thread_id, (payload->>'type'), seq DESC);
