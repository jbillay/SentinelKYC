#!/usr/bin/env node
// R2 — queue + cross-process transport smoke.
//
// Exercises the moving parts R2 adds, deterministically and offline (needs only
// Postgres — no LLM, no Companies House):
//
//   1. NotifySink → run_events → runEventsBus: a NotifySink appends events to
//      run_events + NOTIFYs; a runEventsBus subscriber replays the durable tail
//      AND receives subsequently-written events live. This is the worker→web
//      SSE path that lets a browser reconnect to a worker-driven run.
//   2. pg-boss enqueue → work round-trip: a job sent to a throwaway queue is
//      delivered to a worker handler with its payload intact. This is the
//      durable job path that replaces setImmediate(runGraph).
//
// The full "kill the web process mid-run, reconnect, run still completes" test
// requires the live stack (Ollama + CH) and is a MANUAL test — see
// P0_IMPLEMENTATION_PLAN.md R2 "Restart test".
//
// If Postgres is unreachable it prints SKIP and exits 0.
//
// Run: npm run queue:smoke

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

function isEnvUnavailable(err) {
  const m = String((err && err.message) || err);
  return /DATABASE_URL|ECONNREFUSED|ECONNRESET|ETIMEDOUT|getaddrinfo|connect|ENOTFOUND|socket hang up/i.test(m);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(predicate, { timeoutMs = 8000, intervalMs = 100 } = {}) {
  const start = Date.now();
  // eslint-disable-next-line no-await-in-loop
  while (Date.now() - start < timeoutMs) {
    if (predicate()) return true;
    // eslint-disable-next-line no-await-in-loop
    await sleep(intervalMs);
  }
  return false;
}

let passed = 0;
let failed = 0;
function check(name, ok) {
  if (ok) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}`);
  }
}

async function main() {
  const repo = require('../db/repo');
  const { pool } = require('../db/client');
  const { NotifySink } = require('../services/eventSink');
  const { RunEventsBus } = require('../services/runEventsBus');
  const { getBoss, stopBoss, QUEUE } = require('../services/queue');

  // A unique thread id so reruns don't collide.
  const threadId = `queue-smoke-${process.pid}-${Date.now()}`;
  const bus = new RunEventsBus();

  try {
    // --- Part 1: NotifySink → run_events → runEventsBus -------------------
    console.log('[1] NotifySink → run_events → runEventsBus transport');
    const sink = new NotifySink({ repo, pool });
    await sink.initThread(threadId);

    // Write two events BEFORE anyone subscribes — these must arrive via replay.
    sink.write(threadId, null, { type: 'progress', node: 'queue', seqHint: 0 });
    sink.write(threadId, null, { type: 'trace', node: 'gather_input', seqHint: 1 });
    await sink.drain(threadId);

    const rows = await repo.getRunEvents(threadId, -1);
    check('run_events persisted both pre-subscribe events', rows.length === 2);
    check('events carry monotonic seq starting at 0', rows[0].seq === 0 && rows[1].seq === 1);

    await bus.start();
    const received = [];
    const fakeRes = {
      write(s) {
        // SSE frames look like `data: {...}\n\n`
        const m = /^data: (.*)\n\n$/s.exec(s);
        if (m) received.push(JSON.parse(m[1]));
        return true;
      },
    };
    const unsubscribe = bus.subscribe(threadId, fakeRes);

    const gotReplay = await waitFor(() => received.length >= 2);
    check('subscriber replayed the durable tail', gotReplay && received.length === 2);

    // Now write a live event AFTER subscribing — must arrive via NOTIFY.
    sink.write(threadId, null, { type: 'done', node: '__end__', seqHint: 2 });
    await sink.drain(threadId);
    const gotLive = await waitFor(() => received.some((e) => e.type === 'done'));
    check('subscriber received the live post-subscribe event', gotLive);
    check('no events duplicated across replay + live', received.length === 3);

    unsubscribe();
    await bus.stop();

    // --- Part 2: pg-boss enqueue → work round-trip -----------------------
    console.log('[2] pg-boss enqueue → work round-trip');
    const boss = await getBoss();
    check('pg-boss started + run queue created', !!boss);

    const testQueue = `${QUEUE}_smoke_${process.pid}`;
    await boss.createQueue(testQueue);
    let delivered = null;
    await boss.work(testQueue, { batchSize: 1, pollingIntervalSeconds: 1 }, async ([job]) => {
      delivered = job.data;
    });
    const jobId = await boss.send(testQueue, { kind: 'smoke', threadId, marker: 42 });
    check('job enqueued (got id)', !!jobId);
    const gotJob = await waitFor(() => delivered !== null, { timeoutMs: 10000 });
    check('worker handler received the job payload', gotJob && delivered?.marker === 42);

    // Cleanup the throwaway queue.
    try { await boss.deleteQueue(testQueue); } catch { /* noop */ }
  } finally {
    // Always clean up this thread's run_events + close pg-boss + pool.
    try { await pool.query('DELETE FROM run_events WHERE thread_id = $1', [threadId]); } catch { /* noop */ }
    try { await bus.stop(); } catch { /* noop */ }
    try { await stopBoss({ graceful: false }); } catch { /* noop */ }
    try { await pool.end(); } catch { /* noop */ }
  }

  console.log(`\nqueue-smoke: ${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  if (isEnvUnavailable(err)) {
    console.log('SKIP queue-smoke — environment unavailable:', err.message);
    process.exit(0);
  }
  console.error('[queue-smoke] unexpected error:', err);
  process.exit(1);
});
