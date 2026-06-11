// R2 — durable job queue (pg-boss, Postgres-backed).
//
// Why pg-boss and not BullMQ/Redis: the POC bans Docker and Postgres is already
// installed, so the queue lives in the same database. pg-boss manages its own
// schema (default `pgboss`, overridable via PGBOSS_SCHEMA) and creates it on
// start() — no hand-written migration needed for the queue itself.
//
// One logical queue, `run`, carries every run job; the payload's `kind`
// discriminates start / resume / rescreen / refresh / resumeFailed. A single
// queue with localConcurrency=1 (default) serialises all graph execution, which
// matches the reality that Ollama is effectively serial on one GPU — R2 buys
// durability + decoupling from the HTTP lifecycle, NOT parallel LLM throughput.
//
// Execution mode is flag-gated by RUN_EXECUTION (default `inline`): in inline
// mode this module is never touched and runs execute in-process exactly as
// before; in `queue` mode the web process enqueues and server/worker.js drives.

const { PgBoss } = require('pg-boss');
const { log } = require('./log');

const QUEUE = 'run';

function isQueueMode() {
  return String(process.env.RUN_EXECUTION || 'inline').toLowerCase() === 'queue';
}

function workerConcurrency() {
  const n = parseInt(process.env.WORKER_CONCURRENCY || '1', 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

let bossPromise = null;

// Lazily construct + start a single shared pg-boss instance per process. Both
// the web enqueuer and the worker call this; pg-boss is safe to run in multiple
// processes against the same schema.
async function getBoss() {
  if (!bossPromise) {
    bossPromise = (async () => {
      if (!process.env.DATABASE_URL) {
        throw new Error('[queue] DATABASE_URL is required for RUN_EXECUTION=queue');
      }
      const boss = new PgBoss({
        connectionString: process.env.DATABASE_URL,
        schema: process.env.PGBOSS_SCHEMA || 'pgboss',
        // Long-running graph runs: don't let pg-boss expire an active job while
        // a multi-minute OCR/LLM pass is still going.
        // (Per-job expireInSeconds is set on send() below.)
      });
      boss.on('error', (err) => log.error(`[pg-boss] ${err.message}`));
      await boss.start();
      await boss.createQueue(QUEUE);
      return boss;
    })();
  }
  return bossPromise;
}

// Enqueue a run job. retryLimit:0 — a run is not idempotent to blind re-execution
// (the LangGraph checkpointer + run_events seq handle crash-recovery via the
// worker boot reconciler instead). expireInSeconds is generous so a slow run is
// never reaped mid-flight.
async function enqueueRun(data) {
  const boss = await getBoss();
  return boss.send(QUEUE, data, {
    retryLimit: 0,
    expireInSeconds: 2 * 60 * 60, // 2h, matches the in-memory hard-timeout
  });
}

async function stopBoss({ graceful = true, timeout = 10_000 } = {}) {
  if (!bossPromise) return;
  const boss = await bossPromise;
  bossPromise = null;
  try {
    await boss.stop({ graceful, timeout });
  } catch (err) {
    log.warn(`[pg-boss] stop failed: ${err.message}`);
  }
}

module.exports = {
  QUEUE,
  isQueueMode,
  workerConcurrency,
  getBoss,
  enqueueRun,
  stopBoss,
};
