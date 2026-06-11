// Dossier listing, single read, PATCH, run detail + export, audit feed.
const repo = require('../db/repo');

const ALLOWED_TAGS = ['escalate', 'cleared', 'monitor'];

function register(app) {
  app.get('/api/dossiers', async (req, res, next) => {
    try {
      const { q, status, tag, caseStatus } = req.query;
      const list = await repo.listDossiers({ q, status, tag, caseStatus });
      res.json(list);
    } catch (err) {
      next(err);
    }
  });

  // Phase 5 / Q5 — flat audit-log feed across all dossiers.
  app.get('/api/audit', async (req, res, next) => {
    try {
      const { kind, limit } = req.query;
      const rows = await repo.listFragments({ kind, limit });
      res.json(rows);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/dossiers/kpis', async (_req, res, next) => {
    try {
      const kpis = await repo.computeKpis();
      res.json(kpis);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/dossiers/:companyNumber', async (req, res, next) => {
    try {
      const dossier = await repo.getDossier(req.params.companyNumber);
      if (!dossier) return res.status(404).json({ error: 'dossier not found' });
      res.json(dossier);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/dossiers/:companyNumber/runs/:runId/export.json', async (req, res, next) => {
    try {
      const dossier = await repo.getDossier(req.params.companyNumber);
      if (!dossier) return res.status(404).json({ error: 'dossier not found' });
      const run = await repo.getRun(req.params.runId);
      if (!run) return res.status(404).json({ error: 'run not found' });
      if (run.dossierId !== dossier.id) {
        return res.status(404).json({ error: 'run does not belong to dossier' });
      }
      const filename = `${dossier.companyNumber}-run-${run.id.slice(0, 8)}.json`;
      res.set('Content-Disposition', `attachment; filename="${filename}"`);
      res.set('Content-Type', 'application/json');
      res.send(
        JSON.stringify(
          {
            exportedAt: new Date().toISOString(),
            dossier: {
              companyNumber: dossier.companyNumber,
              companyName: dossier.companyName,
              tags: dossier.tags,
              notes: dossier.notes,
              createdAt: dossier.createdAt,
              updatedAt: dossier.updatedAt,
            },
            run,
          },
          null,
          2,
        ),
      );
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/dossiers/:companyNumber/runs/:runId', async (req, res, next) => {
    try {
      const dossier = await repo.getDossier(req.params.companyNumber);
      if (!dossier) return res.status(404).json({ error: 'dossier not found' });
      const run = await repo.getRun(req.params.runId);
      if (!run) return res.status(404).json({ error: 'run not found' });
      if (run.dossierId !== dossier.id) {
        return res.status(404).json({ error: 'run does not belong to dossier' });
      }
      res.json(run);
    } catch (err) {
      next(err);
    }
  });

  app.patch('/api/dossiers/:companyNumber', async (req, res, next) => {
    try {
      const { tags, notes } = req.body || {};
      const patch = {};
      if (tags !== undefined) {
        if (!Array.isArray(tags)) {
          return res.status(400).json({ error: 'tags must be an array' });
        }
        const invalid = tags.filter((t) => !ALLOWED_TAGS.includes(t));
        if (invalid.length) {
          return res.status(400).json({ error: `invalid tags: ${invalid.join(', ')}` });
        }
        patch.tags = tags;
      }
      if (notes !== undefined) {
        if (notes !== null && typeof notes !== 'string') {
          return res.status(400).json({ error: 'notes must be a string' });
        }
        patch.notes = notes;
      }
      const updated = await repo.updateDossierMeta(req.params.companyNumber, patch);
      if (!updated) return res.status(404).json({ error: 'dossier not found' });
      res.json(updated);
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { register, ALLOWED_TAGS };
