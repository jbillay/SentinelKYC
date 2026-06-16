// Integration tests for routes/runs.js (lifecycle: start, cancel, active, resume
// validation, rescreen/refresh guard paths).
// The graph is NOT exercised — these tests cover request validation, DB state
// guards, and inline-mode mechanics. The graph starts asynchronously in the
// background and fails fast (dead Ollama host), which is acceptable here.
import { it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  describeIntegration,
  api,
  asAdmin,
  getRepo,
  seedReference,
  truncateRunData,
  closePool,
} from './helpers/appHarness.mjs';

describeIntegration('routes: runs', () => {
  let repo;

  beforeAll(async () => {
    repo = getRepo();
    await seedReference();
    await asAdmin((await api()).get('/api/health'));
  }, 30_000);

  afterAll(closePool);

  beforeEach(truncateRunData);

  // ─── POST /api/run — input validation ──────────────────────────────────────

  it('POST /api/run with a valid name returns threadId', async () => {
    const res = await asAdmin((await api()).post('/api/run').send({ name: 'ACME LTD' }));
    expect(res.status).toBe(200);
    expect(res.body.threadId).toBeTypeOf('string');
  });

  it('POST /api/run with a valid companyNumber returns threadId', async () => {
    const res = await asAdmin((await api()).post('/api/run').send({ companyNumber: '01234567' }));
    expect(res.status).toBe(200);
    expect(res.body.threadId).toBeTypeOf('string');
  });

  it('POST /api/run with neither name nor companyNumber returns 400', async () => {
    const res = await asAdmin((await api()).post('/api/run').send({}));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_payload');
    expect(Array.isArray(res.body.validationErrors)).toBe(true);
  });

  it('POST /api/run with an overlong name returns 400', async () => {
    const res = await asAdmin((await api()).post('/api/run').send({ name: 'X'.repeat(201) }));
    expect(res.status).toBe(400);
  });

  it('POST /api/run with an out-of-range year returns 400', async () => {
    const res = await asAdmin((await api()).post('/api/run').send({ name: 'ACME', incorporationYear: 1700 }));
    expect(res.status).toBe(400);
  });

  // ─── GET /api/runs/active ───────────────────────────────────────────────────

  it('GET /api/runs/active returns an array (inline mode)', async () => {
    const res = await asAdmin((await api()).get('/api/runs/active'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  // ─── POST /api/resume/:threadId ────────────────────────────────────────────

  it('POST /api/resume/:threadId without companyNumber returns 400', async () => {
    const res = await asAdmin(
      (await api()).post(`/api/resume/${randomUUID()}`).send({}),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('companyNumber required');
  });

  it('POST /api/resume/:threadId for an unknown thread returns 404 (inline mode)', async () => {
    const res = await asAdmin(
      (await api()).post(`/api/resume/${randomUUID()}`).send({ companyNumber: '01234567' }),
    );
    expect(res.status).toBe(404);
  });

  // ─── POST /api/cancel/:threadId ────────────────────────────────────────────

  it('POST /api/cancel/:threadId for a completely unknown id returns 404', async () => {
    const res = await asAdmin((await api()).post(`/api/cancel/${randomUUID()}`));
    expect(res.status).toBe(404);
  });

  it('POST /api/cancel/:threadId for a persisted but GCd thread closes it cleanly', async () => {
    // Create an orphaned run (running status, no in-memory thread).
    const dossier = await repo.upsertDossier({ companyNumber: '01234567', companyName: 'ACME' });
    const threadId = randomUUID();
    const run = await repo.createRun({ dossierId: dossier.id, threadId, trigger: 'initial' });
    // Leave status='running' — the route should detect the orphan via the DB.

    const res = await asAdmin((await api()).post(`/api/cancel/${threadId}`));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    // run should now be closed in the DB.
    const updated = await repo.getRun(run.id);
    expect(updated.status).toBe('cancelled');
  });

  // ─── POST /api/dossiers/:cn/rescreen ───────────────────────────────────────

  it('POST /api/dossiers/:cn/rescreen returns 404 for unknown dossier', async () => {
    const res = await asAdmin(
      (await api()).post('/api/dossiers/99999999/rescreen'),
    );
    expect(res.status).toBe(404);
  });

  it('POST /api/dossiers/:cn/rescreen returns 400 when no completed run exists', async () => {
    await repo.upsertDossier({ companyNumber: '01234567', companyName: 'ACME' });
    const res = await asAdmin(
      (await api()).post('/api/dossiers/01234567/rescreen'),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no completed run/);
  });

  // ─── POST /api/dossiers/:cn/refresh ────────────────────────────────────────

  it('POST /api/dossiers/:cn/refresh returns 404 for unknown dossier', async () => {
    const res = await asAdmin(
      (await api()).post('/api/dossiers/99999999/refresh'),
    );
    expect(res.status).toBe(404);
  });

  it('POST /api/dossiers/:cn/refresh returns 409 when a run is already in progress', async () => {
    const dossier = await repo.upsertDossier({ companyNumber: '01234567', companyName: 'ACME' });
    const threadId = randomUUID();
    await repo.createRun({ dossierId: dossier.id, threadId, trigger: 'initial' });
    // The run is created with status='running' by default.

    const res = await asAdmin((await api()).post('/api/dossiers/01234567/refresh'));
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('run_in_progress');
    expect(res.body.threadId).toBe(threadId);
  });

  // ─── POST /api/dossiers/:cn/runs/:runId/resume (failed run) ───────────────

  it('POST failed-run resume returns 404 for unknown dossier', async () => {
    const res = await asAdmin(
      (await api()).post(`/api/dossiers/99999999/runs/${randomUUID()}/resume`),
    );
    expect(res.status).toBe(404);
  });

  it('POST failed-run resume returns 400 when run is not in failed status', async () => {
    const dossier = await repo.upsertDossier({ companyNumber: '01234567', companyName: 'ACME' });
    const threadId = randomUUID();
    const run = await repo.createRun({ dossierId: dossier.id, threadId, trigger: 'initial' });

    const res = await asAdmin(
      (await api()).post(`/api/dossiers/01234567/runs/${run.id}/resume`),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot resume run in status running/);
  });

  it('GET /api/runs/active requires auth (401 on GET without credentials)', async () => {
    const res = await (await api()).get('/api/runs/active');
    expect(res.status).toBe(401);
  });
});
