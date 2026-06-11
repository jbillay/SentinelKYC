-- P1 R4b — apply-then-resume atomicity marker.
--
-- Set inside the applyDecision transaction when the decision is applied via
-- the /decision route (a graph resume is owed to close the paused thread).
-- Cleared when the resume is durably dispatched (queue mode), and
-- unconditionally at any run terminus (closeRun). The boot reconciler
-- (services/resumeReconciler.js) drains rows where it is still set — a crash
-- between the decision commit and the resume can no longer strand a run in
-- 'running' until the 2h stale reaper.
ALTER TABLE "runs" ADD COLUMN "resume_owed_at" timestamptz;
