// Run lifecycle routes: start / cancel / resume / stream / list / refresh / rescreen.
//
// Execution is flag-gated by RUN_EXECUTION (services/queue.js#isQueueMode):
//  - inline (default): the graph runs in this process via the in-memory
//    RunRegistry, and SSE streams from the in-memory buffer — exactly as before.
//  - queue: routes enqueue pg-boss jobs (services/runDispatch.js) that the
//    worker drives; SSE streams from the durable run_events table via the
//    runEventsBus LISTEN/replay, and /runs/active is derived from the DB.
const { randomUUID: uuid } = require('crypto');
const { z } = require('zod');
const repo = require('../db/repo');
const { pool } = require('../db/client');
const { registry } = require('../sse/runtime');
const { isQueueMode } = require('../services/queue');
const { runEventsBus } = require('../services/runEventsBus');
const { log } = require('../services/log');
const {
  dispatchStart,
  dispatchRefresh,
  dispatchRescreen,
  dispatchResume,
  dispatchResumeFailed,
} = require('../services/runDispatch');

const SSE_HEADERS = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

// Shape gate for the run-start body (CODE_REVIEW §4.8). gather_input still
// normalises (postcode regex, year range) — this just rejects garbage before
// a thread + checkpoint row is created for it. Unknown keys are stripped.
const runInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional(),
    companyNumber: z.string().trim().min(2).max(10).optional(),
    postcode: z.string().trim().max(10).optional(),
    incorporationYear: z.coerce.number().int().min(1800).max(2100).optional(),
  })
  .refine((v) => v.name || v.companyNumber, {
    message: 'name or companyNumber is required',
  });

function register(app) {
  app.post('/api/run', async (req, res, next) => {
    try {
      const parsed = runInputSchema.safeParse(req.body || {});
      if (!parsed.success) {
        return res.status(400).json({
          error: 'invalid_payload',
          validationErrors: parsed.error.issues,
        });
      }
      const threadId = uuid();
      const input = parsed.data;
      // Inline mode needs the registry thread to exist before we respond so an
      // immediate GET /api/stream finds it. Queue mode validates via run_events.
      if (!isQueueMode()) {
        const t = registry.ensure(threadId);
        t.lastInput = input;
      }
      await dispatchStart({ threadId, input });
      res.json({ threadId });
    } catch (err) {
      next(err);
    }
  });

  // Rescreen: re-run the screening sub-graph against a prior run's API state.
  // See CLAUDE.md "Refresh vs rescreen".
  app.post('/api/dossiers/:companyNumber/rescreen', async (req, res, next) => {
    try {
      const dossier = await repo.getDossier(req.params.companyNumber);
      if (!dossier) return res.status(404).json({ error: 'dossier not found' });

      // One running run per dossier (CODE_REVIEW §4.1): surface the live
      // thread so the UI can attach to it instead of spawning a ghost run.
      const running = await repo.getRunningRunForDossier(dossier.id);
      if (running) {
        return res.status(409).json({ error: 'run_in_progress', threadId: running.threadId });
      }

      // Dedicated query — getDossier now returns lean historical runs
      // (CODE_REVIEW §5.2), so the seed snapshot is fetched explicitly.
      const sourceRun = await repo.getRescreenSourceRun(dossier.id);
      if (!sourceRun) {
        return res.status(400).json({
          error:
            'no completed run with API-state snapshot on this dossier — run a refresh first to populate it',
        });
      }

      const threadId = uuid();
      // The run row is created eagerly (both modes) so the worker has a runId
      // and never double-creates on its lazy-persist path.
      const run = await repo.createRun({
        dossierId: dossier.id,
        threadId,
        trigger: 'rescreen',
      });

      if (!isQueueMode()) {
        const t = registry.ensure(threadId);
        t.trigger = 'rescreen';
        t.companyNumber = dossier.companyNumber;
        t.companyName = dossier.companyName || null;
        t.dossierId = dossier.id;
        t.lastInput = { companyNumber: dossier.companyNumber };
        t.runId = run.id;
      }

      const seedInput = {
        companyNumber: dossier.companyNumber,
        profile: sourceRun.finalProfile,
        officers: sourceRun.finalOfficers,
        psc: sourceRun.finalPsc,
        kycCard: sourceRun.finalKycCard,
        shareholderGraph: sourceRun.finalShareholderGraph || undefined,
        documents: sourceRun.finalDocuments || [],
      };

      await dispatchRescreen({
        threadId,
        seedInput,
        ctx: {
          runId: run.id,
          dossierId: dossier.id,
          companyNumber: dossier.companyNumber,
          companyName: dossier.companyName || null,
          trigger: 'rescreen',
          fragmentCount: 0,
        },
      });
      res.json({ threadId, sourceRunId: sourceRun.id });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/dossiers/:companyNumber/refresh', async (req, res, next) => {
    try {
      const dossier = await repo.getDossier(req.params.companyNumber);
      if (!dossier) return res.status(404).json({ error: 'dossier not found' });

      // One running run per dossier (CODE_REVIEW §4.1).
      const running = await repo.getRunningRunForDossier(dossier.id);
      if (running) {
        return res.status(409).json({ error: 'run_in_progress', threadId: running.threadId });
      }

      const threadId = uuid();
      if (!isQueueMode()) {
        const t = registry.ensure(threadId);
        t.trigger = 'refresh';
        t.companyNumber = dossier.companyNumber;
        t.companyName = dossier.companyName || null;
        t.lastInput = { companyNumber: dossier.companyNumber };
      }

      await dispatchRefresh({ threadId, companyNumber: dossier.companyNumber });
      res.json({ threadId });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/stream/:threadId', async (req, res, next) => {
    const { threadId } = req.params;

    // Queue mode: stream from the durable run_events channel via the bus. The
    // run executes in the worker, so there is no in-memory buffer to read.
    if (isQueueMode()) {
      try {
        const { hasEvents } = await repo.getThreadStreamState(threadId);
        if (!hasEvents) {
          const run = await repo.getRunByThreadId(threadId);
          if (!run) return res.status(404).json({ error: 'unknown threadId' });
        }
        res.set(SSE_HEADERS);
        res.flushHeaders();
        // subscribe() replays the durable tail immediately, then streams new
        // events as the worker emits them.
        const unsubscribe = runEventsBus.subscribe(threadId, res);
        const heartbeat = setInterval(() => {
          try { res.write(': heartbeat\n\n'); } catch { /* noop */ }
        }, 15000);
        req.on('close', () => {
          clearInterval(heartbeat);
          unsubscribe();
        });
      } catch (err) {
        if (!res.headersSent) return next(err);
      }
      return undefined;
    }

    // Inline mode: stream from the in-memory buffer + live res (original path).
    // POST /api/run / refresh / rescreen always calls registry.ensure before
    // returning, so the thread exists by the time the client opens this stream.
    // Refuse to spawn an empty zombie thread on an unknown id.
    if (!registry.has(threadId)) {
      return res.status(404).json({ error: 'unknown threadId' });
    }
    const t = registry.get(threadId);

    res.set(SSE_HEADERS);
    res.flushHeaders();

    try {
      for (const event of t.events) {
        res.write(`data: ${JSON.stringify(event)}\n\n`);
      }
    } catch (err) {
      log.warn(`[sse replay] ${err.message}`);
      return undefined;
    }

    t.sseRes = res;
    if (t.gcTimer) {
      clearTimeout(t.gcTimer);
      t.gcTimer = null;
    }

    const heartbeat = setInterval(() => {
      // try/catch: a write against a response torn down without a 'close'
      // event would otherwise throw uncaught inside the timer and take the
      // process down. Mirrors the queue-mode heartbeat. CODE_REVIEW §4.6.
      try {
        res.write(': heartbeat\n\n');
      } catch {
        clearInterval(heartbeat);
        if (t.sseRes === res) t.sseRes = null;
      }
    }, 15000);

    req.on('close', () => {
      clearInterval(heartbeat);
      if (t.sseRes === res) t.sseRes = null;
    });
    return undefined;
  });

  app.get('/api/runs/active', async (_req, res, next) => {
    if (isQueueMode()) {
      try {
        return res.json(await repo.listActiveRunsFromDb());
      } catch (err) {
        return next(err);
      }
    }
    return res.json(registry.activeSnapshot());
  });

  app.post('/api/cancel/:threadId', async (req, res, next) => {
    const { threadId } = req.params;

    // Queue mode: the run executes in the worker, so there is no in-memory
    // thread to flip. Mark the run cancelled in the DB and publish a cancelled
    // event to run_events so connected browsers see it immediately. The worker
    // job, if already past the point of no return, finishes its current node;
    // closeRun won't resurrect a cancelled run (it only writes terminal columns
    // once). Hard mid-LLM cancellation is out of scope for the POC.
    if (isQueueMode()) {
      try {
        const run = await repo.getRunByThreadId(threadId);
        if (!run) return res.status(404).json({ error: 'unknown threadId' });
        if (run.status !== 'running') {
          return res.json({ ok: true, alreadyClosed: true, status: run.status });
        }
        await repo.closeRun(run.id, {
          status: 'cancelled',
          error: 'cancelled by user',
        });
        const seq = (await repo.getMaxRunEventSeq(threadId)) + 1;
        await repo.appendRunEvent({
          threadId,
          seq,
          payload: { type: 'cancelled', node: 'cancel', ts: Date.now(), msg: 'run cancelled by user' },
        });
        await pool.query('SELECT pg_notify($1, $2)', ['run_events', threadId]);
        return res.json({ ok: true });
      } catch (err) {
        return next(err);
      }
    }

    // In-memory thread is gone (server restart / GC) but the DB row may still
    // be `running` — orphaned run that the UI can't otherwise clean up. Close
    // the row directly so the dossier stops showing a stuck run.
    if (!registry.has(threadId)) {
      try {
        const run = await repo.getRunByThreadId(threadId);
        if (!run) return res.status(404).json({ error: 'unknown threadId' });
        if (run.status !== 'running') {
          return res.json({ ok: true, alreadyClosed: true, status: run.status });
        }
        await repo.closeRun(run.id, {
          status: 'cancelled',
          error: 'cancelled by user after server lost in-memory thread (orphaned run)',
        });
        return res.json({ ok: true, orphaned: true });
      } catch (err) {
        return next(err);
      }
    }

    const t = registry.get(threadId);
    if (t.cancelled) return res.json({ ok: true, alreadyCancelled: true });

    t.cancelled = true;

    if (t.runId && !t.runClosed) {
      try {
        await repo.closeRun(t.runId, { status: 'cancelled' });
        t.runClosed = true;
      } catch (err) {
        log.error(`[cancel] closeRun failed: ${err.message}`);
      }
    }

    registry.pushEvent(threadId, {
      type: 'cancelled',
      node: 'cancel',
      ts: Date.now(),
      msg: 'run cancelled by user',
    });

    if (t.sseRes) {
      try {
        t.sseRes.end();
      } catch {
        // noop
      }
      t.sseRes = null;
    }

    registry.scheduleGc(threadId);
    return res.json({ ok: true });
  });

  // Resume after the entity-selection interrupt (#1).
  app.post('/api/resume/:threadId', async (req, res, next) => {
    const { threadId } = req.params;
    const { companyNumber } = req.body || {};
    if (!companyNumber) {
      return res.status(400).json({ error: 'companyNumber required' });
    }

    if (isQueueMode()) {
      try {
        const { interrupted, interruptKind } = await repo.getThreadStreamState(threadId);
        if (!interrupted || interruptKind === 'final_decision') {
          return res.status(409).json({ error: 'thread is not waiting on an entity-selection interrupt' });
        }
        const run = await repo.getRunByThreadId(threadId);
        await dispatchResume({
          threadId,
          resume: { companyNumber },
          graphKey: 'full',
          ctx: run
            ? { runId: run.id, dossierId: run.dossierId, companyNumber, trigger: run.trigger }
            : { companyNumber },
        });
        return res.json({ ok: true });
      } catch (err) {
        return next(err);
      }
    }

    if (!registry.has(threadId)) {
      return res.status(404).json({ error: 'unknown threadId' });
    }
    const t = registry.get(threadId);
    // Guard against double-resume / resume-on-finished. See CODE_REVIEW §4.3.
    if (!t.interrupted) {
      return res.status(409).json({
        error: 'thread is not waiting on an interrupt',
        phase: t.cancelled ? 'cancelled' : t.runClosed ? 'closed' : 'running',
      });
    }
    await dispatchResume({ threadId, resume: { companyNumber }, graphKey: 'full' });
    return res.json({ ok: true });
  });

  // Re-run a `failed` run from its checkpoint.
  app.post('/api/dossiers/:companyNumber/runs/:runId/resume', async (req, res, next) => {
    try {
      const dossier = await repo.getDossier(req.params.companyNumber);
      if (!dossier) return res.status(404).json({ error: 'dossier not found' });
      const run = await repo.getRun(req.params.runId);
      if (!run) return res.status(404).json({ error: 'run not found' });
      if (run.dossierId !== dossier.id) {
        return res.status(404).json({ error: 'run does not belong to dossier' });
      }
      if (run.status !== 'failed') {
        return res.status(400).json({ error: `cannot resume run in status ${run.status}` });
      }

      // reopenRun flips this run back to 'running' — refuse if another run is
      // already running for the dossier (the partial unique index would turn
      // the UPDATE into a 500 otherwise). See CODE_REVIEW §4.1.
      const running = await repo.getRunningRunForDossier(dossier.id);
      if (running) {
        return res.status(409).json({ error: 'run_in_progress', threadId: running.threadId });
      }

      await repo.reopenRun(run.id);
      const graphKey = run.trigger === 'rescreen' ? 'screening' : 'full';
      const fragmentCount = (run.fragments || []).length;

      if (!isQueueMode()) {
        const t = registry.ensure(run.threadId);
        t.runId = run.id;
        t.dossierId = dossier.id;
        t.companyNumber = dossier.companyNumber;
        t.companyName = dossier.companyName || null;
        t.lastInput = { companyNumber: dossier.companyNumber };
        t.runClosed = false;
        t.trigger = run.trigger;
        t.lastFragmentLen = fragmentCount;
        t.lastTraceLen = 0;
        t.lastErrorLen = 0;
        t.lastScreeningHitLen = 0;
        t.lastScreeningEvalLen = 0;
        t.pendingFragments = [];
      }

      await dispatchResumeFailed({
        threadId: run.threadId,
        graphKey,
        ctx: {
          runId: run.id,
          dossierId: dossier.id,
          companyNumber: dossier.companyNumber,
          companyName: dossier.companyName || null,
          trigger: run.trigger,
          fragmentCount,
          resetCursors: true,
        },
      });
      res.json({ threadId: run.threadId });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { register };
