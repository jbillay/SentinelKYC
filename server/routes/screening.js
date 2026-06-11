// Screening: sanctions lists, config, run-level hits + evaluations + overrides.
//
// Role guards (CODE_REVIEW §3.2): overriding a screening decision IS a decision
// → reviewer; the match threshold is engine configuration on par with the risk
// matrix → admin. Guards live here, next to the handlers, not in index.js.
const repo = require('../db/repo');
const { rebuildScreeningReport } = require('../sse/runtime');
const { requireRole } = require('../services/auth');

function register(app) {
  app.get('/api/dossiers/:companyNumber/runs/:runId/screening', async (req, res, next) => {
    try {
      const dossier = await repo.getDossier(req.params.companyNumber);
      if (!dossier) return res.status(404).json({ error: 'dossier not found' });
      const run = await repo.getRun(req.params.runId);
      if (!run) return res.status(404).json({ error: 'run not found' });
      if (run.dossierId !== dossier.id) {
        return res.status(404).json({ error: 'run does not belong to dossier' });
      }
      const detail = await repo.getRunScreening(run.id);
      res.json({
        runId: run.id,
        report: run.finalScreeningReport || null,
        hits: detail.hits,
        evaluations: detail.evaluations,
      });
    } catch (err) {
      next(err);
    }
  });

  // Set/clear a human override; re-derive runs.final_screening_report.summary
  // server-side so the dossier list KPIs and Screening tab top strip stay in sync.
  app.patch('/api/dossiers/:companyNumber/runs/:runId/hits/:hitId', requireRole('reviewer'), async (req, res, next) => {
    try {
      const dossier = await repo.getDossier(req.params.companyNumber);
      if (!dossier) return res.status(404).json({ error: 'dossier not found' });
      const run = await repo.getRun(req.params.runId);
      if (!run) return res.status(404).json({ error: 'run not found' });
      if (run.dossierId !== dossier.id) {
        return res.status(404).json({ error: 'run does not belong to dossier' });
      }

      const { decision, reason } = req.body || {};
      const ALLOWED = ['confirmed', 'dismissed', 'needs_review', null];
      if (!ALLOWED.includes(decision === undefined ? null : decision)) {
        return res.status(400).json({
          error: 'decision must be confirmed | dismissed | needs_review | null',
        });
      }

      const updated = await repo.setHumanOverride(req.params.hitId, {
        decision: decision ?? null,
        reason: reason ?? null,
      });
      if (!updated) return res.status(404).json({ error: 'evaluation not found for hit' });

      const newReport = await rebuildScreeningReport(run);
      await repo.updateRunScreeningReport(run.id, newReport);

      res.json({ ok: true, evaluation: updated, report: newReport });
    } catch (err) {
      next(err);
    }
  });

  app.post(
    '/api/dossiers/:companyNumber/runs/:runId/carry-overrides-forward',
    requireRole('reviewer'),
    async (req, res, next) => {
      try {
        const dossier = await repo.getDossier(req.params.companyNumber);
        if (!dossier) return res.status(404).json({ error: 'dossier not found' });
        const run = await repo.getRun(req.params.runId);
        if (!run) return res.status(404).json({ error: 'run not found' });
        if (run.dossierId !== dossier.id) {
          return res.status(404).json({ error: 'run does not belong to dossier' });
        }

        const detail = await repo.getRunScreening(run.id);
        const evalsByHit = new Map(detail.evaluations.map((e) => [e.hitId, e]));
        const hitsWithEval = detail.hits.map((h) => {
          const ev = evalsByHit.get(h.id);
          return {
            partyId: h.partyId ?? null,    // Phase 3: party-level when present
            subjectId: h.subjectId,
            listSource: h.listSource,
            listEntryId: h.listEntryId,
            evidenceUrl: h.rawEntry?.url ?? null,
            evaluation: ev || null,
          };
        });

        const counts = await repo.applyOverridesForward(dossier.id, hitsWithEval);
        const carried = (counts?.dossierLevel ?? 0) + (counts?.partyLevel ?? 0);
        res.json({
          ok: true,
          carried,
          dossierLevel: counts?.dossierLevel ?? 0,
          partyLevel: counts?.partyLevel ?? 0,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  app.get('/api/screening/lists', async (_req, res, next) => {
    try {
      const list = await repo.listSanctionsLists();
      res.json(list);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/screening/config', async (_req, res, next) => {
    try {
      const cfg = await repo.getScreeningConfig();
      res.json(cfg);
    } catch (err) {
      next(err);
    }
  });

  app.patch('/api/screening/config', requireRole('admin'), async (req, res, next) => {
    try {
      const { matchThreshold, bingResultsPerSubject } = req.body || {};
      const patch = {};
      if (matchThreshold !== undefined) {
        const n = Number(matchThreshold);
        // See CODE_REVIEW §3.11.
        if (!Number.isFinite(n) || n < 0.5 || n > 0.99) {
          return res.status(400).json({
            error: 'matchThreshold must be a number in [0.5, 0.99]',
            code: 'invalid_threshold',
          });
        }
        patch.matchThreshold = n;
      }
      if (bingResultsPerSubject !== undefined) {
        const n = Number(bingResultsPerSubject);
        if (!Number.isInteger(n) || n < 1 || n > 100) {
          return res.status(400).json({ error: 'bingResultsPerSubject must be 1-100' });
        }
        patch.bingResultsPerSubject = n;
      }
      const updated = await repo.setScreeningConfig(patch);
      if (!updated) return res.status(404).json({ error: 'screening_config row missing' });
      const cfg = await repo.getScreeningConfig();
      res.json(cfg);
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { register };
