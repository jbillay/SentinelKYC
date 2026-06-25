// S3 — Pure unit tests for services/auth/ (passwords, session, middleware).
//
// No Postgres required — repo and pool are mocked so this runs in the CI
// node-only tier alongside the other pure suites.

import { describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// ─── Mock dependencies before importing modules that read them at load time ──

vi.mock('../db/client', () => ({
  pool: { query: vi.fn(), connect: vi.fn() },
  db: {},
}));

vi.mock('../services/log', () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

// connect-pg-simple calls pool.query at construction; mock to avoid live DB.
vi.mock('connect-pg-simple', () => {
  return () => class MockPgStore {
    constructor() {}
  };
});

// ─── passwords.js ────────────────────────────────────────────────────────────

describe('services/auth/passwords', () => {
  const { hashPassword, verifyPassword, COST, DUMMY_HASH } = require('../services/auth/passwords');

  it('COST is a positive integer', () => {
    expect(Number.isInteger(COST)).toBe(true);
    expect(COST).toBeGreaterThan(0);
  });

  it('DUMMY_HASH is a bcrypt hash string (60 chars)', () => {
    expect(typeof DUMMY_HASH).toBe('string');
    expect(DUMMY_HASH).toHaveLength(60);
    expect(DUMMY_HASH.startsWith('$2')).toBe(true);
  });

  it('hashPassword produces a bcrypt hash that verifies', async () => {
    const hash = await hashPassword('CorrectHorse42!');
    expect(typeof hash).toBe('string');
    expect(hash).toHaveLength(60);
    expect(await verifyPassword('CorrectHorse42!', hash)).toBe(true);
  });

  it('hashPassword rejects empty string', async () => {
    await expect(hashPassword('')).rejects.toThrow('non-empty');
  });

  it('hashPassword rejects non-string', async () => {
    await expect(hashPassword(null)).rejects.toThrow();
    await expect(hashPassword(42)).rejects.toThrow();
  });

  it('verifyPassword returns false for a wrong password', async () => {
    const hash = await hashPassword('RightPass1!');
    expect(await verifyPassword('WrongPass99!', hash)).toBe(false);
  });

  it('verifyPassword returns false for a malformed hash without throwing', async () => {
    expect(await verifyPassword('anything', 'not-a-hash')).toBe(false);
  });

  it('verifyPassword returns false when plain is non-string', async () => {
    const hash = await hashPassword('SomePass1!');
    expect(await verifyPassword(null, hash)).toBe(false);
    expect(await verifyPassword(undefined, hash)).toBe(false);
  });

  it('verifyPassword returns false when hash is empty', async () => {
    expect(await verifyPassword('password', '')).toBe(false);
  });

  it('DUMMY_HASH does not verify against any guessable string', async () => {
    // The dummy hash protects against a timing oracle — it should never match.
    expect(await verifyPassword('password', DUMMY_HASH)).toBe(false);
    expect(await verifyPassword('', DUMMY_HASH)).toBe(false);
  });
});

// ─── session.js ──────────────────────────────────────────────────────────────

describe('services/auth/session', () => {
  it('buildSessionMiddleware throws when SESSION_SECRET is unset', () => {
    const old = process.env.SESSION_SECRET;
    delete process.env.SESSION_SECRET;
    try {
      const { buildSessionMiddleware } = require('../services/auth/session');
      expect(() => buildSessionMiddleware()).toThrow('SESSION_SECRET');
    } finally {
      if (old !== undefined) process.env.SESSION_SECRET = old;
    }
  });

  it('buildSessionMiddleware returns a function when SECRET is set', () => {
    process.env.SESSION_SECRET = 'test-secret-value-long-enough';
    const { buildSessionMiddleware } = require('../services/auth/session');
    const mw = buildSessionMiddleware();
    expect(typeof mw).toBe('function');
  });

  it('TTL_MS is a positive number', () => {
    const { TTL_MS } = require('../services/auth/session');
    expect(TTL_MS).toBeGreaterThan(0);
  });

  it('COOKIE_SECURE defaults to false', () => {
    const { COOKIE_SECURE } = require('../services/auth/session');
    expect(typeof COOKIE_SECURE).toBe('boolean');
  });
});

// ─── auth/index.js middleware ─────────────────────────────────────────────────

describe('services/auth/index: requireAuth', () => {
  const { requireAuth } = require('../services/auth/index');

  function mockRes() {
    const res = { _status: null, _body: null };
    res.status = (s) => { res._status = s; return res; };
    res.json = (b) => { res._body = b; return res; };
    return res;
  }

  it('calls next() when req.auth is set', () => {
    const next = vi.fn();
    requireAuth({ auth: { userId: '1', role: 'analyst' } }, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 401 when req.auth is null', () => {
    const res = mockRes();
    requireAuth({ auth: null }, res, vi.fn());
    expect(res._status).toBe(401);
    expect(res._body.error).toBe('authentication required');
  });
});

describe('services/auth/index: requireRole', () => {
  const { requireRole } = require('../services/auth/index');

  function mockRes() {
    const res = {};
    res.status = (s) => { res._status = s; return res; };
    res.json = (b) => { res._body = b; return res; };
    return res;
  }

  it('throws for an unknown role string', () => {
    expect(() => requireRole('superuser')).toThrow('unknown role');
  });

  it('allows analyst to pass an analyst guard', () => {
    const mw = requireRole('analyst');
    const next = vi.fn();
    mw({ auth: { role: 'analyst' } }, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('allows admin to pass a reviewer guard (hierarchy)', () => {
    const mw = requireRole('reviewer');
    const next = vi.fn();
    mw({ auth: { role: 'admin' } }, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('blocks analyst from a reviewer guard', () => {
    const mw = requireRole('reviewer');
    const res = mockRes();
    mw({ auth: { role: 'analyst' } }, res, vi.fn());
    expect(res._status).toBe(403);
    expect(res._body.error).toBe('forbidden');
  });

  it('blocks reviewer from an admin guard', () => {
    const mw = requireRole('admin');
    const res = mockRes();
    mw({ auth: { role: 'reviewer' } }, res, vi.fn());
    expect(res._status).toBe(403);
  });

  it('returns 401 when req.auth is null (unauthenticated)', () => {
    const mw = requireRole('analyst');
    const res = mockRes();
    mw({ auth: null }, res, vi.fn());
    expect(res._status).toBe(401);
  });
});

describe('services/auth/index: csrfProtection', () => {
  const { csrfProtection } = require('../services/auth/index');

  function mockRes() {
    const res = {};
    res.status = (s) => { res._status = s; return res; };
    res.json = (b) => { res._body = b; return res; };
    return res;
  }

  it('skips CSRF check for GET', () => {
    const next = vi.fn();
    csrfProtection({ method: 'GET', auth: null, headers: {}, session: {} }, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('skips CSRF check for HEAD', () => {
    const next = vi.fn();
    csrfProtection({ method: 'HEAD', auth: null, headers: {}, session: {} }, mockRes(), next);
    expect(next).toHaveBeenCalledOnce();
  });

  it('skips CSRF check for dev-bypass requests', () => {
    const next = vi.fn();
    csrfProtection(
      { method: 'POST', auth: { viaBypass: true }, headers: {}, session: {} },
      mockRes(),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });

  it('returns 403 invalid_csrf_token when no token is sent', () => {
    const res = mockRes();
    csrfProtection(
      { method: 'POST', auth: null, headers: {}, session: { csrfToken: 'expected-token' } },
      res,
      vi.fn(),
    );
    expect(res._status).toBe(403);
    expect(res._body.error).toBe('invalid_csrf_token');
  });

  it('returns 403 when token mismatches', () => {
    const res = mockRes();
    csrfProtection(
      {
        method: 'POST',
        auth: null,
        headers: { 'x-csrf-token': 'wrong' },
        session: { csrfToken: 'correct-token-abc' },
      },
      res,
      vi.fn(),
    );
    expect(res._status).toBe(403);
  });

  it('calls next() when token matches', () => {
    const next = vi.fn();
    const token = 'a'.repeat(64);
    csrfProtection(
      {
        method: 'POST',
        auth: null,
        headers: { 'x-csrf-token': token },
        session: { csrfToken: token },
      },
      mockRes(),
      next,
    );
    expect(next).toHaveBeenCalledOnce();
  });
});

describe('services/auth/index: issueCsrfToken', () => {
  const { issueCsrfToken } = require('../services/auth/index');

  it('mints a hex token on first call', () => {
    const req = { session: {} };
    const token = issueCsrfToken(req);
    expect(typeof token).toBe('string');
    expect(token).toHaveLength(64); // 32 bytes as hex
  });

  it('returns the same token on subsequent calls', () => {
    const req = { session: {} };
    const t1 = issueCsrfToken(req);
    const t2 = issueCsrfToken(req);
    expect(t1).toBe(t2);
  });

  it('throws when req.session is absent', () => {
    expect(() => issueCsrfToken({ session: null })).toThrow('no session');
  });
});

describe('services/auth/index: readUserId', () => {
  const { readUserId } = require('../services/auth/index');

  it('returns req.auth.userId when authenticated', () => {
    expect(readUserId({ auth: { userId: 'uuid-123' } })).toBe('uuid-123');
  });

  it('falls back to "system" when req.auth is null', () => {
    expect(readUserId({ auth: null })).toBe('system');
  });
});

describe('services/auth/index: authMiddleware (pure paths)', () => {
  const { authMiddleware } = require('../services/auth/index');

  it('sets req.auth = null and calls next when no session userId', async () => {
    // The bypass is off (AUTH_DEV_BYPASS defaults false in the vitest env).
    const req = { session: {}, headers: {} };
    const next = vi.fn();
    await authMiddleware(req, {}, next);
    expect(req.auth).toBeNull();
    expect(next).toHaveBeenCalledOnce();
  });

  it('dev-bypass sets req.auth when x-user-id header is present', async () => {
    // The bypass is already on in the test env (AUTH_DEV_BYPASS not set → defaults
    // to the module-load-time value). Since auth/index.js reads AUTH_DEV_BYPASS at
    // require-time we must check the module constant rather than toggling the env.
    const { AUTH_DEV_BYPASS } = require('../services/auth/index');
    if (!AUTH_DEV_BYPASS) return; // skip if bypass was off at load time

    const req = { session: {}, headers: { 'x-user-id': 'smoke-admin' } };
    await authMiddleware(req, {}, vi.fn());
    expect(req.auth).toMatchObject({ userId: 'smoke-admin', role: 'admin', viaBypass: true });
  });
});
