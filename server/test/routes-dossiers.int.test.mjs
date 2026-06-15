// Phase 3 — route integration via supertest against the REAL app pipeline
// (helmet → cors → session → auth → routes) and a test Postgres. Auth uses the
// dev bypass (x-user-id ⇒ admin). External boundaries (LLM/CH/GDELT) are not
// touched by these read/meta routes.
import { it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  describeIntegration,
  api,
  asAdmin,
  getRepo,
  seedReference,
  truncateRunData,
  closePool,
} from './helpers/appHarness.mjs';

describeIntegration('routes: dossiers + reference reads', () => {
  let repo;
  beforeAll(async () => {
    repo = getRepo();
    await seedReference();
    // Warm the app once — the first build initialises the session store
    // (creates the `session` table), which would otherwise blow a test's 5s
    // timeout on cold start.
    await asAdmin((await api()).get('/api/dossiers'));
  }, 30_000);
  afterAll(closePool);
  beforeEach(truncateRunData);

  it('rejects an unauthenticated request with 401', async () => {
    const res = await (await api()).get('/api/dossiers'); // no x-user-id
    expect(res.status).toBe(401);
  });

  it('GET /api/dossiers returns [] then the inserted dossier', async () => {
    let res = await asAdmin((await api()).get('/api/dossiers'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);

    await repo.upsertDossier({ companyNumber: '01234567', companyName: 'ACME LTD' });
    res = await asAdmin((await api()).get('/api/dossiers'));
    expect(res.status).toBe(200);
    expect(res.body.map((d) => d.companyNumber)).toContain('01234567');
  });

  it('GET /api/dossiers/:cn returns the dossier or 404', async () => {
    await repo.upsertDossier({ companyNumber: '01234567', companyName: 'ACME LTD' });
    const ok = await asAdmin((await api()).get('/api/dossiers/01234567'));
    expect(ok.status).toBe(200);
    expect(ok.body.companyName).toBe('ACME LTD');

    const missing = await asAdmin((await api()).get('/api/dossiers/99999999'));
    expect(missing.status).toBe(404);
  });

  it('PATCH /api/dossiers/:cn updates tags and notes', async () => {
    await repo.upsertDossier({ companyNumber: '01234567', companyName: 'ACME LTD' });
    const res = await asAdmin((await api()).patch('/api/dossiers/01234567'))
      .send({ tags: ['monitor'], notes: 'keep an eye on this' });
    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual(['monitor']);
    const reread = await repo.getDossier('01234567');
    expect(reread.notes).toBe('keep an eye on this');
  });

  it('GET /api/dossiers/kpis returns the dashboard shape', async () => {
    const res = await asAdmin((await api()).get('/api/dossiers/kpis'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('dossiersThisMonth');
    expect(res.body.dossiersThisMonth).toHaveProperty('trend');
  });

  it('GET /api/risk/matrix returns the active (or default) matrix', async () => {
    const res = await asAdmin((await api()).get('/api/risk/matrix'));
    expect(res.status).toBe(200);
    expect(res.body.body || res.body).toHaveProperty('weights');
  });

  it('GET /api/agents lists the six pipeline agents', async () => {
    const res = await asAdmin((await api()).get('/api/agents'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBe(6);
  });

  it('GET /api/prompts returns the seeded prompt registry', async () => {
    const res = await asAdmin((await api()).get('/api/prompts'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
  });
});
