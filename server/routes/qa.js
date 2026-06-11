// Phase 5 — QA endpoints: read per-run frozen result + matrix-threshold
// rebase. Reviewer-driven decisions are in routes/decision.js.
const repo = require('../db/repo');
const matrixService = require('../services/risk/matrix');
const qaService = require('../services/qa');

const TERMINAL_CASE_STATUSES = new Set(['approved', 'rejected']);

function register(app) {
  app.get('/api/dossiers/:companyNumber/runs/:runId/qa', async (req, res, next) => {
    try {
      const dossier = await repo.getDossier(req.params.companyNumber);
      if (!dossier) return res.status(404).json({ error: 'dossier not found' });
      const run = await repo.getRun(req.params.runId);
      if (!run) return res.status(404).json({ error: 'run not found' });
      if (run.dossierId !== dossier.id) {
        return res.status(404).json({ error: 'run does not belong to dossier' });
      }
      if (!run.qaResult) {
        return res.status(404).json({ error: 'run has not yet been QA-checked' });
      }
      res.json({ runId: run.id, qaResult: run.qaResult });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/dossiers/:companyNumber/runs/:runId/qa/recompute', async (req, res, next) => {
    try {
      const dossier = await repo.getDossier(req.params.companyNumber);
      if (!dossier) return res.status(404).json({ error: 'dossier not found' });
      const run = await repo.getRun(req.params.runId);
      if (!run) return res.status(404).json({ error: 'run not found' });
      if (run.dossierId !== dossier.id) {
        return res.status(404).json({ error: 'run does not belong to dossier' });
      }
      if (TERMINAL_CASE_STATUSES.has(dossier.caseStatus)) {
        return res.status(400).json({
          error: 'decision already finalized',
          caseStatus: dossier.caseStatus,
        });
      }
      if (!run.finalProfile || !run.finalKycCard || !run.finalScreeningReport || !run.finalRiskAssessment) {
        return res.status(400).json({
          error: 'run is missing one or more snapshots required for QA — run a refresh first',
        });
      }

      const matrix = await matrixService.loadActiveMatrix();
      const syntheticState = {
        profile: run.finalProfile,
        officers: run.finalOfficers,
        psc: run.finalPsc,
        kycCard: run.finalKycCard,
        documents: run.finalDocuments || [],
        screeningReport: run.finalScreeningReport,
        riskAssessment: run.finalRiskAssessment,
      };
      const qaResult = qaService.evaluateQa({ state: syntheticState, matrix });

      // Single transaction: qa_result write only. case_status mirroring is
      // off here too — the await_decision interrupt is the sole gate that
      // can flip the dossier (Phase 5 follow-up).
      await repo.finalizeRunQa(
        run.id,
        dossier.companyNumber,
        qaResult,
        { requireLatestRun: true, mirrorCaseStatus: false },
      );

      res.json({ ok: true, runId: run.id, qaResult, caseStatusUpdated: false });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { register, TERMINAL_CASE_STATUSES };
