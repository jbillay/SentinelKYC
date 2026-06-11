// R1 — auth middleware + guards.
//
// Identity comes from the server-side session (services/auth/session.js): at
// login we store `session.userId`; on every request `authMiddleware` loads the
// fresh user row and sets `req.auth = { userId, username, role }`. Loading per
// request (not trusting a cached copy on the session) makes deactivation /
// role-change take effect immediately — real revocation.
//
// Authorization is a clean hierarchy: admin > reviewer > analyst.
// `requireRole('reviewer')` therefore admits reviewer AND admin.
//
// CSRF: cookie auth means the browser auto-sends credentials, so mutating
// methods require a double-submit token. The client fetches GET /api/auth/csrf
// (which mints a per-session token) and echoes it in the `x-csrf-token` header.
const crypto = require('crypto');
const repo = require('../../db/repo');
const { log } = require('../log');

const ROLE_RANK = { analyst: 1, reviewer: 2, admin: 3 };

const AUTH_DEV_BYPASS = String(process.env.AUTH_DEV_BYPASS || 'false') === 'true';

// Populate req.auth from the session (or the dev bypass). Never rejects — that's
// requireAuth/requireRole's job; this just resolves identity.
async function authMiddleware(req, _res, next) {
  req.auth = null;
  try {
    const userId = req.session?.userId;
    if (userId) {
      const user = await repo.getUserById(userId);
      if (user && user.active) {
        req.auth = {
          userId: user.id,
          username: user.username,
          displayName: user.displayName || null,
          email: user.email || null,
          role: user.role,
        };
      } else if (req.session) {
        // Stale / deactivated — drop the session identity.
        req.session.userId = null;
      }
    }

    // Local-only escape hatch for engine smoke scripts hitting HTTP. OFF by
    // default; when on, a bare x-user-id header is trusted as an admin actor.
    if (!req.auth && AUTH_DEV_BYPASS) {
      const hdr = String(req.headers['x-user-id'] || '').trim().slice(0, 128);
      if (hdr) req.auth = { userId: hdr, username: hdr, role: 'admin', viaBypass: true };
    }
  } catch (err) {
    // Fail closed: leave req.auth null on a lookup error.
    log.error(`[auth] middleware lookup failed: ${err.message}`);
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.auth) return res.status(401).json({ error: 'authentication required' });
  next();
}

// requireRole(minRole) — hierarchy-aware. admin satisfies every lower role.
function requireRole(minRole) {
  const min = ROLE_RANK[minRole];
  if (!min) throw new Error(`requireRole: unknown role "${minRole}"`);
  return (req, res, next) => {
    if (!req.auth) return res.status(401).json({ error: 'authentication required' });
    const have = ROLE_RANK[req.auth.role] || 0;
    if (have < min) {
      return res.status(403).json({ error: 'forbidden', requiredRole: minRole, role: req.auth.role });
    }
    next();
  };
}

// Mint (or return) the per-session CSRF token. Writing it persists the session
// (saveUninitialized:false otherwise wouldn't), so a fresh client gets a cookie.
function issueCsrfToken(req) {
  if (!req.session) throw new Error('issueCsrfToken: no session');
  if (!req.session.csrfToken) {
    req.session.csrfToken = crypto.randomBytes(32).toString('hex');
  }
  return req.session.csrfToken;
}

const CSRF_SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Double-submit CSRF check for mutating methods. Skipped for the dev bypass
// (no cookie → no CSRF surface) and for safe methods. Comparison is
// constant-time (CODE_REVIEW §3.4).
function csrfProtection(req, res, next) {
  if (CSRF_SAFE_METHODS.has(req.method)) return next();
  if (req.auth?.viaBypass) return next();
  const sent = req.headers['x-csrf-token'];
  const expected = req.session?.csrfToken;
  if (!expected || typeof sent !== 'string' || !timingSafeEqualStr(sent, expected)) {
    return res.status(403).json({ error: 'invalid_csrf_token' });
  }
  next();
}

function timingSafeEqualStr(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// The single identity read path used by route modules (replaces the old
// x-user-id reader in index.js). Returns the verified user id, or 'system' as a
// last resort so audit writes never get an empty actor.
function readUserId(req) {
  return req.auth?.userId || 'system';
}

module.exports = {
  authMiddleware,
  requireAuth,
  requireRole,
  csrfProtection,
  issueCsrfToken,
  readUserId,
  ROLE_RANK,
  AUTH_DEV_BYPASS,
};
