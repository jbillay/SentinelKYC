// Integration tests for routes/auth.js (login, me, csrf, profile, password).
//
// CSRF note: POST requests from non-bypass clients go through csrfProtection
// before the auth gate, so unauthenticated POSTs return 403 (CSRF) not 401.
// The login tests must use a session-aware agent that carries the cookie set
// by GET /api/auth/csrf across to the POST /api/auth/login call.
import { it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import {
  describeIntegration,
  api,
  asAdmin,
  createAgent,
  getRepo,
  getPool,
  closePool,
} from './helpers/appHarness.mjs';

const require = createRequire(import.meta.url);

describeIntegration('routes: auth', () => {
  let repo;
  let userId;

  beforeAll(async () => {
    repo = getRepo();
    const { hashPassword } = require('../services/auth/passwords');
    // Warm the app (first request initialises the session store).
    await asAdmin((await api()).get('/api/auth/csrf'));
    // Seed a real user so profile/password routes have a DB row to work with.
    await getPool().query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
    const hash = await hashPassword('Hunter22!');
    const user = await repo.upsertUser({ username: 'testauth', passwordHash: hash, role: 'analyst' });
    userId = user.id;
  }, 30_000);

  afterAll(closePool);

  // ─── CSRF ───────────────────────────────────────────────────────────────────

  it('GET /api/auth/csrf returns a token (no auth required)', async () => {
    const res = await (await api()).get('/api/auth/csrf');
    expect(res.status).toBe(200);
    expect(res.body.csrfToken).toBeTypeOf('string');
    expect(res.body.csrfToken.length).toBeGreaterThan(10);
  });

  // ─── /me ────────────────────────────────────────────────────────────────────

  it('GET /api/auth/me with dev bypass returns the synthetic user', async () => {
    const res = await asAdmin((await api()).get('/api/auth/me'));
    expect(res.status).toBe(200);
    expect(res.body.user.role).toBe('admin');
    expect(res.body.user.username).toBe('test-admin');
  });

  it('GET /api/auth/me without auth returns 401', async () => {
    const res = await (await api()).get('/api/auth/me');
    expect(res.status).toBe(401);
  });

  // ─── Login ──────────────────────────────────────────────────────────────────
  // Login uses a cookie-jar agent: GET /api/auth/csrf sets the session cookie;
  // the subsequent POST /api/auth/login sends it back with the x-csrf-token.

  it('POST /api/auth/login with valid credentials returns the user', async () => {
    const agent = await createAgent();
    const csrfRes = await agent.get('/api/auth/csrf');
    const res = await agent
      .post('/api/auth/login')
      .set('x-csrf-token', csrfRes.body.csrfToken)
      .send({ username: 'testauth', password: 'Hunter22!' });
    expect(res.status).toBe(200);
    expect(res.body.user.username).toBe('testauth');
    expect(res.body.user.role).toBe('analyst');
    expect(res.body.user.passwordHash).toBeUndefined();
  });

  it('POST /api/auth/login with wrong password returns 401', async () => {
    const agent = await createAgent();
    const csrfRes = await agent.get('/api/auth/csrf');
    const res = await agent
      .post('/api/auth/login')
      .set('x-csrf-token', csrfRes.body.csrfToken)
      .send({ username: 'testauth', password: 'wrong' });
    expect(res.status).toBe(401);
    expect(res.body.error).toBe('invalid_credentials');
  });

  it('POST /api/auth/login with unknown username returns 401', async () => {
    const agent = await createAgent();
    const csrfRes = await agent.get('/api/auth/csrf');
    const res = await agent
      .post('/api/auth/login')
      .set('x-csrf-token', csrfRes.body.csrfToken)
      .send({ username: 'nobody', password: 'anything' });
    expect(res.status).toBe(401);
  });

  it('POST /api/auth/login with missing fields returns 400', async () => {
    const agent = await createAgent();
    const csrfRes = await agent.get('/api/auth/csrf');
    const res = await agent
      .post('/api/auth/login')
      .set('x-csrf-token', csrfRes.body.csrfToken)
      .send({ username: 'testauth' });
    expect(res.status).toBe(400);
  });

  // ─── Logout ─────────────────────────────────────────────────────────────────

  it('POST /api/auth/logout with bypass session returns ok', async () => {
    const res = await asAdmin((await api()).post('/api/auth/logout'));
    expect([200, 204]).toContain(res.status);
  });

  // ─── Profile PATCH ──────────────────────────────────────────────────────────
  // The bypass sets req.auth.userId = header value. We pass the real UUID so
  // updateUserProfile can find and update the DB row.

  it('PATCH /api/auth/profile with a real userId updates displayName', async () => {
    const res = await (await api())
      .patch('/api/auth/profile')
      .set('x-user-id', userId)
      .send({ displayName: 'Test Auth User' });
    expect(res.status).toBe(200);
    expect(res.body.user.displayName).toBe('Test Auth User');
  });

  it('PATCH /api/auth/profile with no fields returns 400', async () => {
    const res = await (await api())
      .patch('/api/auth/profile')
      .set('x-user-id', userId)
      .send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('no_fields_to_update');
  });

  it('PATCH /api/auth/profile rejects an invalid username pattern (too short)', async () => {
    const res = await (await api())
      .patch('/api/auth/profile')
      .set('x-user-id', userId)
      .send({ username: 'ab' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_username');
  });

  it('PATCH /api/auth/profile rejects a malformed email', async () => {
    const res = await (await api())
      .patch('/api/auth/profile')
      .set('x-user-id', userId)
      .send({ email: 'not-an-email' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_email');
  });

  // ─── Password change ────────────────────────────────────────────────────────

  it('POST /api/auth/password with correct current password changes it', async () => {
    const { hashPassword } = require('../services/auth/passwords');
    const hash = await hashPassword('Original1!');
    await repo.updateUserPassword(userId, hash);

    const res = await (await api())
      .post('/api/auth/password')
      .set('x-user-id', userId)
      .send({ currentPassword: 'Original1!', newPassword: 'Updated2@' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it('POST /api/auth/password with wrong current password returns 403', async () => {
    const res = await (await api())
      .post('/api/auth/password')
      .set('x-user-id', userId)
      .send({ currentPassword: 'wrong', newPassword: 'NewPass3!' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('wrong_current_password');
  });

  it('POST /api/auth/password rejects a weak new password', async () => {
    const res = await (await api())
      .post('/api/auth/password')
      .set('x-user-id', userId)
      .send({ currentPassword: 'anything', newPassword: 'short' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('weak_password');
  });

  it('POST /api/auth/password with missing fields returns 400', async () => {
    const res = await (await api())
      .post('/api/auth/password')
      .set('x-user-id', userId)
      .send({ currentPassword: 'only-this' });
    expect(res.status).toBe(400);
  });

  // ─── Auth gate is enforced ───────────────────────────────────────────────

  it('GET /api/dossiers returns 401 without credentials (auth gate)', async () => {
    const res = await (await api()).get('/api/dossiers');
    expect(res.status).toBe(401);
  });
});
