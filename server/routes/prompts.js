// Prompt registry CRUD. Backed by services/prompts.js — versioned active rows.
// Editing prompts is admin-tier (CODE_REVIEW §3.2); reads are open to any role.
const promptsService = require('../services/prompts');
const { requireRole } = require('../services/auth');

function register(app) {
  app.get('/api/prompts', async (_req, res, next) => {
    try {
      const list = await promptsService.listAll();
      res.json(list);
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/prompts/:key', async (req, res, next) => {
    try {
      const { key } = req.params;
      const meta = promptsService.listKeys().find((k) => k.key === key);
      if (!meta) return res.status(404).json({ error: 'unknown prompt key' });
      const active = await promptsService.getActiveVersion(key);
      const versions = await promptsService.listVersions(key);
      res.json({
        key,
        label: meta.label,
        description: meta.description,
        defaultBody: meta.defaultBody,
        active,
        versions,
      });
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/prompts/:key/versions/:id', async (req, res, next) => {
    try {
      const { key, id } = req.params;
      const ver = await promptsService.getVersion(id);
      if (!ver || ver.promptKey !== key) {
        return res.status(404).json({ error: 'version not found' });
      }
      res.json(ver);
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/prompts/:key/versions', requireRole('admin'), async (req, res, next) => {
    try {
      const { key } = req.params;
      const { body, notes } = req.body || {};
      if (typeof body !== 'string' || !body.trim()) {
        return res.status(400).json({ error: 'body must be a non-empty string' });
      }
      if (notes !== undefined && notes !== null && typeof notes !== 'string') {
        return res.status(400).json({ error: 'notes must be a string' });
      }
      const row = await promptsService.createVersion(key, body, notes ?? null);
      res.status(201).json(row);
    } catch (err) {
      if (/unknown prompt key/i.test(err.message)) {
        return res.status(404).json({ error: err.message });
      }
      next(err);
    }
  });

  app.post('/api/prompts/:key/active', requireRole('admin'), async (req, res, next) => {
    try {
      const { key } = req.params;
      const { versionId } = req.body || {};
      if (!versionId || typeof versionId !== 'string') {
        return res.status(400).json({ error: 'versionId required' });
      }
      const ver = await promptsService.setActive(key, versionId);
      res.json({ ok: true, active: ver });
    } catch (err) {
      if (/unknown prompt key|does not belong/i.test(err.message)) {
        return res.status(400).json({ error: err.message });
      }
      next(err);
    }
  });
}

module.exports = { register };
