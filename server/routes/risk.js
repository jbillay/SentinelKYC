// Risk matrix CRUD + recalculate-risk + per-run frozen risk read.
// Matrix edits are admin-tier; recalculate-risk is a deterministic, auditable
// rebase against the active matrix and stays analyst-accessible (CODE_REVIEW §3.2).
const repo = require('../db/repo');
const { requireRole } = require('../services/auth');
const matrixService = require('../services/risk/matrix');
const riskService = require('../services/risk');
const { generateRationale } = require('../services/risk/rationale');
const { templateRationale } = require('../graph/nodes/assessRisk');
const { log } = require('../services/log');

function register(app) {
  app.get('/api/risk/matrix', async (_req, res, next) => {
    try {
      const m = await matrixService.loadActiveMatrix();
      res.json(m);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/risk/matrix/versions', async (_req, res, next) => {
    try {
      const list = await matrixService.listMatrixVersions();
      res.json(list);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/risk/matrix/versions/:id', async (req, res, next) => {
    try {
      const row = await matrixService.loadMatrixVersion(req.params.id);
      if (!row) return res.status(404).json({ error: 'version not found' });
      res.json(row);
    } catch (err) {
      next(err);
    }
  });

  // Create a new matrix version. Validated server-side regardless of client.
  // Does NOT activate — separate POST /api/risk/matrix/active for that.
  app.post('/api/risk/matrix/versions', requireRole('admin'), async (req, res, next) => {
    try {
      const { body, notes } = req.body || {};
      if (notes !== undefined && notes !== null && typeof notes !== 'string') {
        return res.status(400).json({ error: 'notes must be a string' });
      }
      const errors = matrixService.validateMatrix(body);
      if (errors.length) {
        return res.status(400).json({ error: 'invalid risk matrix', validationErrors: errors });
      }
      const row = await repo.createRiskMatrixVersion({ body, notes: notes ?? null });
      res.status(201).json({ id: row.id, version: row.version });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/risk/matrix/active', requireRole('admin'), async (req, res, next) => {
    try {
      const { versionId } = req.body || {};
      if (!versionId || typeof versionId !== 'string') {
        return res.status(400).json({ error: 'versionId required' });
      }
      const row = await matrixService.setActiveMatrix(versionId);
      if (!row) return res.status(404).json({ error: 'version not found' });
      res.json({ ok: true, active: { id: row.id, version: row.version } });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/dossiers/:companyNumber/runs/:runId/risk', async (req, res, next) => {
    try {
      const dossier = await repo.getDossier(req.params.companyNumber);
      if (!dossier) return res.status(404).json({ error: 'dossier not found' });
      const run = await repo.getRun(req.params.runId);
      if (!run) return res.status(404).json({ error: 'run not found' });
      if (run.dossierId !== dossier.id) {
        return res.status(404).json({ error: 'run does not belong to dossier' });
      }
      if (!run.finalRiskAssessment) {
        return res.status(404).json({ error: 'run has no risk assessment' });
      }
      res.json({ runId: run.id, riskAssessment: run.finalRiskAssessment });
    } catch (err) {
      next(err);
    }
  });

  // Matrix-edit-only rebase: re-run the deterministic engine + LLM rationale
  // against the latest run's stored snapshots using the active matrix.
  app.post('/api/dossiers/:companyNumber/recalculate-risk', async (req, res, next) => {
    try {
      const dossier = await repo.getDossier(req.params.companyNumber);
      if (!dossier) return res.status(404).json({ error: 'dossier not found' });

      const sourceRun = (dossier.runs || []).find((r) => r.finalProfile && r.finalKycCard);
      if (!sourceRun) {
        return res.status(400).json({
          error:
            'no run with an API-state snapshot on this dossier — run a refresh first to populate it',
        });
      }

      const matrix = await matrixService.loadActiveMatrix();

      let previousAssessment = null;
      try {
        previousAssessment = await repo.getPreviousRiskAssessment(
          dossier.companyNumber,
          sourceRun.id,
        );
      } catch (err) {
        log.error(`[recalculate-risk] previous assessment lookup failed: ${err.message}`);
      }

      const result = await riskService.assessRisk({
        profile: sourceRun.finalProfile,
        kycCard: sourceRun.finalKycCard,
        psc: sourceRun.finalPsc,
        screeningReport: sourceRun.finalScreeningReport,
        previousAssessment,
        matrix,
      });

      let rationaleSource = 'llm';
      try {
        result.rationale = await generateRationale(result.receipt);
      } catch (err) {
        log.error(`[recalculate-risk] LLM rationale failed, using template: ${err.message}`);
        result.rationale = templateRationale(result);
        rationaleSource = 'template';
      }

      await repo.updateRunRiskAssessment(sourceRun.id, result);

      res.json({ ok: true, runId: sourceRun.id, rationaleSource, riskAssessment: result });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { register };
