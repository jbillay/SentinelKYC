// P1 R4b — boot reconciler for owed decision resumes.
//
// applyDecision (route path) stamps runs.resume_owed_at inside its
// transaction; the resume that follows is in-process (inline) or a pg-boss
// enqueue (queue). If the process dies in between, the dossier is finalised
// but the run thread stays 'running' — previously only the 2h stale reaper
// would eventually close it. This reconciler drains those rows at boot:
//
//   * checkpoint still present → re-issue the resume through dispatchResume
//     (the same mode-aware path the live route uses), with the payload
//     rebuilt from the canonical human_action fragment.
//   * checkpoint gone → the graph can't be resumed; close the run cleanly
//     ('done' — the decision DID land) and clear the marker.
//
// It never touches case_status: that transaction already committed. It only
// closes or replays. Disable with RESUME_RECONCILE=off.
//
// Wired into index.js start() for BOTH modes: in queue mode dispatchResume
// just enqueues a durable job (the worker drives it), which is exactly right.

const repo = require('../db/repo');
const { compiledGraph, compiledScreeningOnlyGraph } = require('../graph/build');
const { dispatchResume } = require('./runDispatch');
const { log } = require('./log');

const ACTION_TO_CASE_STATUS = {
  approve: 'approved',
  reject: 'rejected',
  escalate: 'escalated',
  request_info: 'info_requested',
};

function enabled() {
  return String(process.env.RESUME_RECONCILE || 'on').toLowerCase() !== 'off';
}

async function hasCheckpoint(graph, threadId) {
  try {
    const snapshot = await graph.getState({ configurable: { thread_id: threadId } });
    // A thread with no checkpoint yields an empty snapshot (no values/config).
    return !!(snapshot && snapshot.values && Object.keys(snapshot.values).length > 0);
  } catch {
    return false;
  }
}

async function reconcileOwedResumes() {
  if (!enabled()) return { drained: 0, replayed: 0, closed: 0 };

  let owed;
  try {
    owed = await repo.getRunsOwedResume();
  } catch (err) {
    log.error(`[resumeReconciler] list failed: ${err.message}`);
    return { drained: 0, replayed: 0, closed: 0 };
  }
  let replayed = 0;
  let closed = 0;

  for (const r of owed) {
    try {
      const fragment = await repo.getLatestHumanActionFragment(r.runId);
      if (!fragment) {
        // Marker without a decision record — shouldn't happen (they're written
        // in the same txn). Clear the marker and leave the run to the stale
        // reaper rather than inventing a resume payload.
        log.warn(`[resumeReconciler] run ${r.runId} owed a resume but has no human_action fragment — clearing marker`);
        await repo.clearResumeOwed(r.runId);
        continue;
      }
      const action = fragment.inputs?.action;
      const resumePayload = {
        decisionApplied: true,
        action,
        caseStatus: ACTION_TO_CASE_STATUS[action] || null,
        userId: fragment.inputs?.userId || 'unknown',
        fragmentId: fragment.id,
      };
      const graphKey = r.trigger === 'rescreen' ? 'screening' : 'full';
      const graph = graphKey === 'screening' ? compiledScreeningOnlyGraph : compiledGraph;

      if (await hasCheckpoint(graph, r.threadId)) {
        log.warn(`[resumeReconciler] replaying owed resume run=${r.runId} thread=${r.threadId} action=${action}`);
        await dispatchResume({
          threadId: r.threadId,
          resume: resumePayload,
          graphKey,
          ctx: {
            runId: r.runId,
            dossierId: r.dossierId,
            companyNumber: r.companyNumber,
            trigger: r.trigger,
          },
        });
        replayed += 1;
        // Inline: the terminus clears the marker via closeRun. Queue: the job
        // is durable from here — clear now (same contract as the live route).
        const { isQueueMode } = require('./queue');
        if (isQueueMode()) await repo.clearResumeOwed(r.runId);
      } else {
        log.warn(`[resumeReconciler] checkpoint gone for run=${r.runId} — closing cleanly`);
        await repo.closeRun(r.runId, { status: 'done' }); // also clears the marker
        closed += 1;
      }
    } catch (err) {
      log.error(`[resumeReconciler] item run=${r.runId} failed: ${err.message}`);
    }
  }

  if (owed.length) {
    log.info(`[resumeReconciler] drained ${owed.length} owed resume(s): ${replayed} replayed, ${closed} closed`);
  }
  return { drained: owed.length, replayed, closed };
}

module.exports = { reconcileOwedResumes };
