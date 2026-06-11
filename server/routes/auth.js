// R1 — authentication routes: login / logout / me / csrf.
//
// Session-cookie auth (see services/auth/session.js). Login verifies a bcrypt
// password against the application user store, regenerates the session (fixation
// defence), and stamps the verified user id onto it. All other routes read
// identity from that session via authMiddleware.
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const repo = require('../db/repo');
const { verifyPassword, hashPassword, DUMMY_HASH } = require('../services/auth/passwords');
const { issueCsrfToken } = require('../services/auth');

const USERNAME_RE = /^[a-zA-Z0-9._-]{3,32}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 8;

// Blunt brute-force: 10 failed attempts / 15 min, keyed on IP + username.
// Keying on IP alone shares one bucket behind the Vite dev proxy (no trust
// proxy → every client is 127.0.0.1), letting one attacker lock everyone out
// of the login page. The username component scopes the lockout to the
// targeted account. CODE_REVIEW §3.5.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) =>
    `${ipKeyGenerator(req.ip)}|${String(req.body?.username || '').trim().toLowerCase().slice(0, 64)}`,
  message: { error: 'too_many_attempts', detail: 'try again later' },
});

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName || null,
    email: user.email || null,
    role: user.role,
  };
}

function register(app) {
  // Mint/return a CSRF token for this session. Safe (GET) so it needs no token
  // itself; the client calls this first, then echoes the value in x-csrf-token.
  app.get('/api/auth/csrf', (req, res) => {
    const csrfToken = issueCsrfToken(req);
    res.json({ csrfToken });
  });

  app.get('/api/auth/me', (req, res) => {
    if (!req.auth) return res.status(401).json({ error: 'not_authenticated' });
    res.json({
      user: {
        id: req.auth.userId,
        username: req.auth.username,
        displayName: req.auth.displayName || null,
        email: req.auth.email || null,
        role: req.auth.role,
      },
    });
  });

  // Self-service profile update. Auth-gated (path not in PUBLIC_API) + CSRF
  // (mutating). Users edit their OWN row only — id comes from the session, never
  // the body. Role / active are deliberately not editable here.
  app.patch('/api/auth/profile', async (req, res, next) => {
    try {
      const { displayName, username, email } = req.body || {};
      const patch = {};

      if (displayName !== undefined) {
        const dn = String(displayName).trim();
        if (dn.length < 1 || dn.length > 80) {
          return res.status(400).json({ error: 'invalid_display_name' });
        }
        patch.displayName = dn;
      }
      if (username !== undefined) {
        const un = String(username).trim();
        if (!USERNAME_RE.test(un)) {
          return res.status(400).json({ error: 'invalid_username', detail: '3–32 chars: letters, digits, . _ -' });
        }
        patch.username = un;
      }
      if (email !== undefined) {
        const em = String(email).trim();
        if (em === '') {
          patch.email = null; // allow clearing
        } else if (!EMAIL_RE.test(em) || em.length > 254) {
          return res.status(400).json({ error: 'invalid_email' });
        } else {
          patch.email = em;
        }
      }

      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'no_fields_to_update' });
      }

      const updated = await repo.updateUserProfile(req.auth.userId, patch);
      res.json({ user: publicUser(updated) });
    } catch (err) {
      // Unique-violation on username / email.
      if (err && err.code === '23505') {
        const field = /email/i.test(err.detail || '') ? 'email' : 'username';
        return res.status(409).json({ error: 'conflict', field });
      }
      next(err);
    }
  });

  // Change password — requires the current password. Auth-gated + CSRF.
  app.post('/api/auth/password', async (req, res, next) => {
    try {
      const { currentPassword, newPassword } = req.body || {};
      if (!currentPassword || !newPassword) {
        return res.status(400).json({ error: 'current and new password required' });
      }
      if (String(newPassword).length < MIN_PASSWORD_LEN) {
        return res.status(400).json({ error: 'weak_password', detail: `min ${MIN_PASSWORD_LEN} characters` });
      }

      const user = await repo.getUserById(req.auth.userId);
      if (!user) return res.status(404).json({ error: 'not_found' });

      const ok = await verifyPassword(currentPassword, user.passwordHash);
      if (!ok) return res.status(403).json({ error: 'wrong_current_password' });

      const hash = await hashPassword(String(newPassword));
      await repo.updateUserPassword(user.id, hash);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/auth/login', loginLimiter, async (req, res, next) => {
    try {
      const { username, password } = req.body || {};
      if (!username || !password) {
        return res.status(400).json({ error: 'username and password required' });
      }

      const user = await repo.getUserByUsername(username);
      // Always run verify (even on a missing user, against a real dummy hash)
      // to keep the timing roughly uniform and avoid leaking which usernames
      // exist. DUMMY_HASH is a valid 60-char bcrypt hash generated at boot —
      // a malformed constant would short-circuit and defeat the purpose.
      const ok = user && user.active
        ? await verifyPassword(password, user.passwordHash)
        : await verifyPassword(password, DUMMY_HASH);

      if (!user || !user.active || !ok) {
        return res.status(401).json({ error: 'invalid_credentials' });
      }

      // Regenerate to prevent session fixation, then stamp identity + a fresh
      // CSRF token for subsequent mutations.
      req.session.regenerate((err) => {
        if (err) return next(err);
        req.session.userId = user.id;
        issueCsrfToken(req);
        req.session.save(async (saveErr) => {
          if (saveErr) return next(saveErr);
          try {
            await repo.touchUserLogin(user.id);
          } catch {
            /* best-effort */
          }
          res.json({ user: publicUser(user) });
        });
      });
    } catch (err) {
      next(err);
    }
  });

  app.post('/api/auth/logout', (req, res, next) => {
    if (!req.session) return res.json({ ok: true });
    req.session.destroy((err) => {
      if (err) return next(err);
      res.clearCookie('ccpoc.sid', { path: '/' });
      res.json({ ok: true });
    });
  });
}

module.exports = { register };
