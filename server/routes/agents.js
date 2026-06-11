// Agent registry + per-agent configuration. Reads are open to any signed-in
// role; mutations are admin-tier like the other config surfaces (prompts,
// risk matrix, screening config).
const agentConfig = require('../agents/config');
const { requireRole, readUserId } = require('../services/auth');

function register(app) {
  app.get('/api/agents', async (_req, res, next) => {
    try {
      res.json(await agentConfig.listAgents());
    } catch (err) {
      next(err);
    }
  });

  app.get('/api/agents/:id', async (req, res, next) => {
    try {
      res.json(await agentConfig.getAgentDetail(req.params.id));
    } catch (err) {
      if (/Unknown agent id/.test(err.message)) {
        return res.status(404).json({ error: 'unknown agent' });
      }
      next(err);
    }
  });

  // Full config save — creates a new version and activates it (audited).
  app.post('/api/agents/:id/config', requireRole('admin'), async (req, res, next) => {
    try {
      const { body, notes } = req.body || {};
      if (!body || typeof body !== 'object' || Array.isArray(body)) {
        return res.status(400).json({ error: 'invalid_payload', detail: 'body must be an object' });
      }
      const row = await agentConfig.saveAgentConfig(req.params.id, body, {
        actor: readUserId(req),
        notes: notes ?? null,
      });
      const detail = await agentConfig.getAgentDetail(req.params.id);
      res.json({ ok: true, version: row.version, agent: detail });
    } catch (err) {
      if (err.code === 'invalid_config') {
        return res.status(400).json({ error: 'invalid_config', validationErrors: err.validationErrors });
      }
      if (/Unknown agent id/.test(err.message)) {
        return res.status(404).json({ error: 'unknown agent' });
      }
      next(err);
    }
  });

  // Enable/disable toggle — convenience over the full save.
  app.post('/api/agents/:id/enabled', requireRole('admin'), async (req, res, next) => {
    try {
      const { enabled } = req.body || {};
      if (typeof enabled !== 'boolean') {
        return res.status(400).json({ error: 'invalid_payload', detail: 'enabled must be a boolean' });
      }
      await agentConfig.setAgentEnabled(req.params.id, enabled, { actor: readUserId(req) });
      const detail = await agentConfig.getAgentDetail(req.params.id);
      res.json({ ok: true, agent: detail });
    } catch (err) {
      if (err.code === 'agent_required') {
        return res.status(400).json({ error: 'agent_required' });
      }
      if (/Unknown agent id/.test(err.message)) {
        return res.status(404).json({ error: 'unknown agent' });
      }
      next(err);
    }
  });
}

module.exports = { register };
