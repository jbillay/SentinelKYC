// Admin-only surfaces. The pipeline-config reads (agents, prompts, risk matrix,
// screening) live in their own route modules and stay open to any signed-in
// role; this module owns the genuinely admin-gated admin-section data.
const repo = require('../db/repo');
const { requireRole } = require('../services/auth');

function register(app) {
  // Members list — real application users (safe fields only). Admin-tier:
  // exposes the roster + roles, which non-admins have no business reading.
  app.get('/api/admin/users', requireRole('admin'), async (_req, res, next) => {
    try {
      res.json({ users: await repo.listUsers() });
    } catch (err) {
      next(err);
    }
  });
}

module.exports = { register };
