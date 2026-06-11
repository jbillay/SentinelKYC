// R2 — run dispatch: the one place that decides inline vs. queue execution.
//
// Routes call dispatch*(...) instead of `setImmediate(runGraph(...))`. In
// inline mode (default) dispatch runs the graph in-process exactly as before;
// in queue mode it writes a "queued" marker event (so the SSE stream is
// immediately valid + the browser sees progress) and enqueues a pg-boss job
// that server/worker.js drives via the SAME executeRunJob() below. Keeping the
// kind→runGraph mapping in one function means inline and worker execution can
// never drift.

const { Command } = require('@langchain/langgraph');
const { getGraph } = require('../graph/build');
const { registry, runGraph } = require('../sse/runtime');
const { isQueueMode, enqueueRun } = require('./queue');
const repo = require('../db/repo');
const { pool } = require('../db/client');
const { log } = require('./log');

const EVENT_CHANNEL = 'run_events';

// Per-run snapshot of disabled agents — written into state.agentStatus at
// dispatch from the SAME enabled map that selected the graph topology, so
// the two can't disagree. Consumers (QA engine, UI) read the state snapshot,
// never the live config.
function skippedAgentStatus(enabled) {
  const status = {};
  for (const [id, on] of Object.entries(enabled)) {
    if (!on) status[id] = 'skipped';
  }
  return status;
}

// Seed a worker's fresh registry thread-state from job context so the
// cross-process resume behaves like the same-process one: a known runId stops
// emitDelta from double-creating the run row, and a seeded fragment cursor
// stops it from re-persisting fragments that the first segment already wrote.
function seedThread(t, ctx) {
  if (!ctx) return;
  if (ctx.runId) {
    t.runId = ctx.runId;
    t.runClosed = false;
  }
  if (ctx.dossierId) t.dossierId = ctx.dossierId;
  if (ctx.companyNumber) t.companyNumber = ctx.companyNumber;
  if (ctx.companyName) t.companyName = ctx.companyName;
  if (ctx.trigger) t.trigger = ctx.trigger;
  if (typeof ctx.fragmentCount === 'number') t.lastFragmentLen = ctx.fragmentCount;
  if (ctx.resetCursors) {
    t.lastTraceLen = 0;
    t.lastErrorLen = 0;
    t.lastScreeningHitLen = 0;
    t.lastScreeningEvalLen = 0;
    t.pendingFragments = [];
  }
}

// The single execution mapping. Called inline (via setImmediate) in inline mode
// and by the worker's job handler in queue mode. Returns the runGraph promise.
async function executeRunJob(data, { workerId = null } = {}) {
  const { kind, threadId, ctx } = data;
  const t = registry.ensure(threadId);
  seedThread(t, ctx);

  switch (kind) {
    case 'start': {
      const { graph, enabled } = await getGraph('full');
      return runGraph(
        threadId,
        { input: data.input, agentStatus: skippedAgentStatus(enabled) },
        { graph, workerId },
      );
    }
    case 'refresh': {
      const { graph, enabled } = await getGraph('full');
      return runGraph(
        threadId,
        {
          input: { companyNumber: data.companyNumber },
          agentStatus: skippedAgentStatus(enabled),
        },
        {
          forceFresh: true,
          autoResume: { companyNumber: data.companyNumber },
          graph,
          workerId,
        },
      );
    }
    case 'rescreen': {
      const { graph, enabled } = await getGraph('screening');
      return runGraph(
        threadId,
        { ...data.seedInput, agentStatus: skippedAgentStatus(enabled) },
        { graph, workerId },
      );
    }
    case 'resume': {
      const { graph } = await getGraph(data.graphKey === 'screening' ? 'screening' : 'full');
      return runGraph(threadId, new Command({ resume: data.resume }), { graph, workerId });
    }
    case 'resumeFailed': {
      const { graph } = await getGraph(data.graphKey === 'screening' ? 'screening' : 'full');
      return runGraph(threadId, null, { graph, workerId });
    }
    default:
      throw new Error(`executeRunJob: unknown kind ${kind}`);
  }
}

// Write the seq-0 "queued" marker so a queue-mode SSE stream is valid the
// instant the browser connects (before the worker has emitted anything) and so
// the run shows as queued. Idempotent on (thread_id, seq). The worker's
// NotifySink seeds its seq from maxSeq+1, so this never collides.
async function emitMarker(threadId) {
  const payload = { type: 'progress', node: 'queue', ts: Date.now(), msg: 'queued' };
  try {
    await repo.appendRunEvent({ threadId, seq: 0, payload });
    await pool.query('SELECT pg_notify($1, $2)', [EVENT_CHANNEL, threadId]);
  } catch (err) {
    log.warn(`[dispatch] emitMarker failed: ${err.message}`);
  }
}

async function dispatch(data, { marker = false } = {}) {
  if (isQueueMode()) {
    if (marker) await emitMarker(data.threadId);
    await enqueueRun(data);
    return;
  }
  // Inline: same fire-and-forget shape as the original routes.
  setImmediate(() => executeRunJob(data));
}

async function dispatchStart({ threadId, input }) {
  return dispatch({ kind: 'start', threadId, input }, { marker: true });
}

async function dispatchRefresh({ threadId, companyNumber }) {
  return dispatch({ kind: 'refresh', threadId, companyNumber }, { marker: true });
}

async function dispatchRescreen({ threadId, seedInput, ctx }) {
  return dispatch({ kind: 'rescreen', threadId, seedInput, ctx }, { marker: true });
}

async function dispatchResume({ threadId, resume, graphKey, ctx }) {
  return dispatch({ kind: 'resume', threadId, resume, graphKey, ctx });
}

async function dispatchResumeFailed({ threadId, graphKey, ctx }) {
  return dispatch({ kind: 'resumeFailed', threadId, graphKey, ctx });
}

module.exports = {
  executeRunJob,
  dispatchStart,
  dispatchRefresh,
  dispatchRescreen,
  dispatchResume,
  dispatchResumeFailed,
};
