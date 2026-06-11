// Phase 5 / Q4 — final-decision endpoint and the future-proof immutability
// middleware that guards /api/fragments/:id against accidental mutation of a
// `human_action` row by a yet-to-be-added route.
const { applyDecision } = require('../services/decision');
const { decisionPayloadSchema } = require('../lib/decisionSchema');
const { db } = require('../db/client');
const schema = require('../db/schema');
const { eq } = require('drizzle-orm');
const repo = require('../db/repo');
const { registry } = require('../sse/runtime');
const { isQueueMode } = require('../services/queue');
const { dispatchResume } = require('../services/runDispatch');
const { requireRole } = require('../services/auth');
const { log } = require('../services/log');

function register(app, { readUserId }) {
  // Deny mutating requests against any /api/fragments/:id whose row is
  // kind='human_action'. No such routes exist today — this middleware is here
  // so an accidentally-added PATCH/DELETE later can't silently rewrite the
  // audit trail. Fails CLOSED on DB errors. Migration 0010 also adds a
  // BEFORE UPDATE trigger as a second line of defence.
  app.use('/api/fragments/:id', async (req, res, next) => {
    if (req.method === 'GET' || req.method === 'HEAD') return next();
    try {
      const [row] = await db
        .select({ kind: schema.decisionFragments.kind })
        .from(schema.decisionFragments)
        .where(eq(schema.decisionFragments.id, req.params.id))
        .limit(1);
      if (row?.kind === 'human_action') {
        return res.status(403).json({ error: 'human_action fragments are immutable' });
      }
      return next();
    } catch (err) {
      log.error({ err }, '[human_action guard]');
      return res.status(503).json({ error: 'audit guard temporarily unavailable' });
    }
  });

  app.post('/api/dossiers/:companyNumber/runs/:runId/decision', requireRole('reviewer'), async (req, res, next) => {
    const userId = readUserId(req);
    const parsed = decisionPayloadSchema.safeParse({
      ...(req.body || {}),
      userId,
    });
    if (!parsed.success) {
      return res.status(400).json({
        error: 'invalid_payload',
        validationErrors: parsed.error.issues,
      });
    }

    try {
      const result = await applyDecision({
        companyNumber: req.params.companyNumber,
        runId: req.params.runId,
        userId,
        payload: parsed.data,
        // R4b: stamp resume_owed_at in the same txn — the boot reconciler
        // drains it if we crash before the resume below lands.
        resumeOwed: true,
      });

      // The graph for this run is paused at await_decision. Apply-then-resume:
      // the DB transaction has already flipped case_status + written the
      // human_action fragment + stamped resume_owed_at (R4b), so we resume
      // with the outcome so the node can emit its trace and the run can close
      // cleanly.
      //
      // In queue mode the resume is a durable pg-boss job; the owed marker is
      // cleared at enqueue. In inline mode the resume is in-process and the
      // marker clears at the run terminus (closeRun) — if the process dies
      // first, the boot reconciler (services/resumeReconciler.js) drains it.
      try {
        const run = await repo.getRun(req.params.runId);
        if (run && run.threadId) {
          const graphKey = run.trigger === 'rescreen' ? 'screening' : 'full';
          const resumePayload = {
            decisionApplied: true,
            action: parsed.data.action,
            caseStatus: result.caseStatus,
            userId,
            fragmentId: result.fragmentId,
          };
          if (isQueueMode()) {
            const { interrupted } = await repo.getThreadStreamState(run.threadId);
            if (interrupted) {
              await dispatchResume({
                threadId: run.threadId,
                resume: resumePayload,
                graphKey,
                ctx: {
                  runId: run.id,
                  dossierId: run.dossierId,
                  companyNumber: req.params.companyNumber,
                  trigger: run.trigger,
                  fragmentCount: (run.fragments || []).length,
                },
              });
              // R4b: the pg-boss job is durable from here — the resume can no
              // longer be lost, so the owed marker is settled. (Inline mode
              // clears at the run terminus via closeRun instead.)
              await repo.clearResumeOwed(run.id);
            }
          } else if (registry.has(run.threadId)) {
            const t = registry.get(run.threadId);
            if (t && t.interrupted) {
              await dispatchResume({ threadId: run.threadId, resume: resumePayload, graphKey });
            }
          }
        }
      } catch (resumeErr) {
        // Resume is best-effort — surfacing this would only confuse the
        // reviewer because the decision did land.
        log.warn(`[decision] graph resume after applyDecision failed: ${resumeErr.message}`);
      }

      res.json(result);
    } catch (err) {
      if (err.code === 'invalid_transition') {
        return res.status(409).json({
          error: 'invalid_transition',
          from: err.from,
          action: err.action,
        });
      }
      if (err.code === 'not_found') {
        return res.status(404).json({ error: err.message });
      }
      if (err.code === 'invalid_payload') {
        return res.status(400).json({ error: err.message });
      }
      return next(err);
    }
  });
}

module.exports = { register };
