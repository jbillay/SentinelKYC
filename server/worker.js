// R2 — run worker process (RUN_EXECUTION=queue).
//
// A pg-boss subscriber that drives LangGraph runs out of the HTTP request
// lifecycle. It runs the SAME graphs and the SAME executeRunJob() mapping as the
// inline path — the only difference is the host process and the event sink: this
// process installs a NotifySink, so every SSE event is appended to run_events +
// NOTIFYd, and the web process's runEventsBus relays them to the browser. A web
// restart therefore can't lose an in-flight run; the worker keeps going and the
// browser reconnects + replays from run_events.
//
// Start it alongside the web process:  npm run worker   (after `npm run dev`).
// Concurrency defaults to 1 (Ollama is serial on one GPU) — R2 buys durability
// and decoupling, NOT parallel LLM throughput. See P0_IMPLEMENTATION_PLAN.md R2.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const os = require('os');
const events = require('events');
// Same EventTarget listener bump as index.js — screening makes 11+ LLM calls
// that each attach an abort listener to the run-level signal.
events.setMaxListeners(50);

const { setProcessKind } = require('./services/log');
const log = setProcessKind('worker');
const metrics = require('./services/metrics');
const repo = require('./db/repo');
const { pool } = require('./db/client');
const { registry } = require('./sse/runtime');
const { executeRunJob } = require('./services/runDispatch');
const { NotifySink } = require('./services/eventSink');
const { getBoss, stopBoss, enqueueRun, QUEUE, workerConcurrency } = require('./services/queue');

const WORKER_ID = `${os.hostname()}:${process.pid}`;

// R7 — metrics are per-process; node/LLM series accumulate HERE in queue mode.
// /api/metrics can't see them, so log a snapshot periodically + at shutdown.
const METRICS_SNAPSHOT_INTERVAL_MS = 5 * 60_000;
const metricsTimer = setInterval(() => {
  log.info({ metrics: metrics.snapshot() }, 'metrics snapshot');
}, METRICS_SNAPSHOT_INTERVAL_MS);
if (typeof metricsTimer.unref === 'function') metricsTimer.unref();

// Install the cross-process sink: events go to run_events + NOTIFY, not to an
// in-memory res (this process has no browser connections).
const sink = new NotifySink({ repo, pool });
registry.setSink(sink);

async function handleJob(job) {
  const data = job.data;
  const { threadId } = data;
  if (!threadId) {
    log.error({ jobId: job.id }, '[worker] job missing threadId, skipping');
    return;
  }
  // Continue the durable seq counter from the tail (resume / retry safe).
  await sink.initThread(threadId);
  log.info(`[worker] ${WORKER_ID} driving ${data.kind} thread=${threadId} job=${job.id}`);
  try {
    await executeRunJob(data, { workerId: WORKER_ID });
  } catch (err) {
    // executeRunJob → runGraph already converts node errors into error events +
    // a failed run row; a throw here is an unexpected harness failure.
    log.error(`[worker] executeRunJob threw: ${err.message}`);
    throw err;
  } finally {
    // Final drain MUST surface persistent failure: completing the job while
    // the terminal event is missing from run_events leaves the run's UI state
    // wedged forever (CODE_REVIEW §4.3). Failing the job keeps the run row
    // 'running' so boot reconciliation re-drives it once Postgres recovers.
    let drainErr = null;
    try {
      await sink.drain(threadId);
    } catch (err) {
      drainErr = err;
    }
    sink.forget(threadId);
    if (drainErr) {
      log.error(`[worker] event drain failed for thread=${threadId}: ${drainErr.message}`);
      // eslint-disable-next-line no-unsafe-finally
      throw drainErr;
    }
  }
}

// Boot reconciliation: a worker that died mid-run leaves runs marked `running`.
// On restart, re-drive each from its LangGraph checkpoint — EXCEPT runs paused
// at a human interrupt (those are legitimately waiting for a user/reviewer and
// are resumed by their action, not by us). Disable with WORKER_RECONCILE=off
// (e.g. when iterating on worker code with multiple restarts).
async function reconcile() {
  if (String(process.env.WORKER_RECONCILE || 'on').toLowerCase() === 'off') return;
  let running;
  try {
    running = await repo.listRunningRuns();
  } catch (err) {
    log.error(`[worker] reconcile list failed: ${err.message}`);
    return;
  }
  for (const r of running) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const { interrupted } = await repo.getThreadStreamState(r.threadId);
      if (interrupted) continue;
      // eslint-disable-next-line no-await-in-loop
      const full = await repo.getRun(r.runId);
      const graphKey = r.trigger === 'rescreen' ? 'screening' : 'full';
      log.warn(`[worker] reconciling crashed run thread=${r.threadId} — re-enqueueing`);
      // Re-enqueue rather than drive in-process: a direct executeRunJob here
      // would bypass pg-boss's localConcurrency (N crashed runs + queued jobs
      // would all hit the serial LLM at once) and would not survive a second
      // crash mid-reconcile. As a queue job it serialises with everything
      // else and is durable from the moment it's enqueued. CODE_REVIEW §4.4.
      const data = {
        kind: 'resumeFailed',
        threadId: r.threadId,
        graphKey,
        ctx: {
          runId: r.runId,
          dossierId: full?.dossierId,
          companyNumber: r.companyNumber,
          trigger: r.trigger,
          fragmentCount: (full?.fragments || []).length,
        },
      };
      // eslint-disable-next-line no-await-in-loop
      await enqueueRun(data);
    } catch (err) {
      log.error(`[worker] reconcile item failed: ${err.message}`);
    }
  }
}

async function main() {
  const boss = await getBoss();
  const concurrency = workerConcurrency();
  await boss.work(
    QUEUE,
    { batchSize: 1, localConcurrency: concurrency, pollingIntervalSeconds: 1 },
    async ([job]) => {
      await handleJob(job);
    },
  );
  log.info(`[worker] ${WORKER_ID} online — queue '${QUEUE}', concurrency ${concurrency}`);
  await reconcile();
}

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.info({ metrics: metrics.snapshot() }, `[worker] ${signal} — draining and stopping`);
  try {
    await stopBoss({ graceful: true, timeout: 15_000 });
  } catch (err) {
    log.warn(`[worker] stop error: ${err.message}`);
  }
  try {
    await pool.end();
  } catch {
    /* noop */
  }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

main().catch((err) => {
  log.error({ err }, '[worker] fatal startup error');
  process.exit(1);
});
