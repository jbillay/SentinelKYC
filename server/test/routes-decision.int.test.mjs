// Integration tests for routes/decision.js (POST /api/dossiers/:cn/runs/:runId/decision)
// and the human_action immutability middleware on /api/fragments/:id.
//
// The graph is not running — the route applies the decision transactionally and
// then gracefully skips the graph resume because no in-memory thread exists
// (registry.has(threadId) → false in inline mode without an active run).
import { it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  describeIntegration,
  api,
  asAdmin,
  getRepo,
  getPool,
  seedReference,
  truncateRunData,
  closePool,
} from './helpers/appHarness.mjs';

describeIntegration('routes: decision', () => {
  let repo;
  let runId;

  beforeAll(async () => {
    repo = getRepo();
    await seedReference();
    await asAdmin((await api()).get('/api/health'));
  }, 30_000);

  afterAll(closePool);

  beforeEach(async () => {
    await truncateRunData();
    const dossier = await repo.upsertDossier({ companyNumber: '01234567', companyName: 'ACME LTD' });
    const run = await repo.createRun({ dossierId: dossier.id, threadId: randomUUID(), trigger: 'initial' });
    runId = run.id;
  });

  // ─── Payload validation ───────────────────────────────────────────────────

  it('POST /decision rejects a missing action with 400 invalid_payload', async () => {
    const res = await asAdmin(
      (await api())
        .post(`/api/dossiers/01234567/runs/${runId}/decision`)
        .send({}),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_payload');
    expect(Array.isArray(res.body.validationErrors)).toBe(true);
  });

  it('POST /decision rejects an unknown action with 400 invalid_payload', async () => {
    const res = await asAdmin(
      (await api())
        .post(`/api/dossiers/01234567/runs/${runId}/decision`)
        .send({ action: 'yolo' }),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_payload');
  });

  it('POST /decision rejects reject without required reasonCode', async () => {
    const res = await asAdmin(
      (await api())
        .post(`/api/dossiers/01234567/runs/${runId}/decision`)
        .send({ action: 'reject', freeText: 'short' }),
    );
    expect(res.status).toBe(400);
  });

  it('POST /decision reject with valid reasonCode and freeText succeeds', async () => {
    const res = await asAdmin(
      (await api())
        .post(`/api/dossiers/01234567/runs/${runId}/decision`)
        .send({ action: 'reject', reasonCode: 'sanctions_hit', freeText: 'Confirmed sanctions match against OFAC SDN list' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.caseStatus).toBe('rejected');
  });

  it('POST /decision rejects escalate with too-short notes', async () => {
    const res = await asAdmin(
      (await api())
        .post(`/api/dossiers/01234567/runs/${runId}/decision`)
        .send({ action: 'escalate', notes: 'ok' }), // < 10 chars
    );
    expect(res.status).toBe(400);
  });

  // ─── Approve ─────────────────────────────────────────────────────────────

  it('POST /decision approve on a pending run succeeds', async () => {
    const res = await asAdmin(
      (await api())
        .post(`/api/dossiers/01234567/runs/${runId}/decision`)
        .send({ action: 'approve' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.caseStatus).toBe('approved');
    expect(res.body.previousCaseStatus).toBe('pending');
    expect(res.body.fragmentId).toBeTruthy();

    // Dossier should now be approved.
    const dossier = await repo.getDossier('01234567');
    expect(dossier.caseStatus).toBe('approved');
  });

  it('POST /decision approve writes a human_action fragment', async () => {
    const res = await asAdmin(
      (await api())
        .post(`/api/dossiers/01234567/runs/${runId}/decision`)
        .send({ action: 'approve' }),
    );
    expect(res.status).toBe(200);
    const fragment = await repo.getLatestHumanActionFragment(runId);
    expect(fragment).not.toBeNull();
    expect(fragment.kind).toBe('human_action');
    expect(fragment.nodeId).toBe('human_decision');
  });

  // ─── Invalid transition ───────────────────────────────────────────────────

  it('POST /decision on a terminal (approved) dossier returns 409 invalid_transition', async () => {
    await getPool().query(
      `UPDATE dossiers SET case_status = 'approved' WHERE company_number = '01234567'`,
    );
    const res = await asAdmin(
      (await api())
        .post(`/api/dossiers/01234567/runs/${runId}/decision`)
        .send({ action: 'approve' }),
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('invalid_transition');
    expect(res.body.from).toBe('approved');
  });

  it('POST /decision approve on an escalated case returns 409 (approve not allowed from escalated)', async () => {
    await getPool().query(
      `UPDATE dossiers SET case_status = 'escalated' WHERE company_number = '01234567'`,
    );
    const res = await asAdmin(
      (await api())
        .post(`/api/dossiers/01234567/runs/${runId}/decision`)
        .send({ action: 'approve' }),
    );
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('invalid_transition');
  });

  // ─── Other actions ────────────────────────────────────────────────────────

  it('POST /decision request_info with valid items succeeds', async () => {
    const res = await asAdmin(
      (await api())
        .post(`/api/dossiers/01234567/runs/${runId}/decision`)
        .send({
          action: 'request_info',
          items: [{ description: 'Need proof of address', category: 'identity' }],
        }),
    );
    expect(res.status).toBe(200);
    expect(res.body.caseStatus).toBe('info_requested');
  });

  it('POST /decision escalate with valid notes succeeds', async () => {
    const res = await asAdmin(
      (await api())
        .post(`/api/dossiers/01234567/runs/${runId}/decision`)
        .send({ action: 'escalate', notes: 'Complex ownership structure requires senior review' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.caseStatus).toBe('escalated');
  });

  // ─── 404 paths ───────────────────────────────────────────────────────────

  it('POST /decision returns 404 for unknown dossier', async () => {
    const res = await asAdmin(
      (await api())
        .post(`/api/dossiers/99999999/runs/${runId}/decision`)
        .send({ action: 'approve' }),
    );
    expect(res.status).toBe(404);
  });

  it('POST /decision returns 404 for unknown run', async () => {
    const unknownRunId = randomUUID();
    const res = await asAdmin(
      (await api())
        .post(`/api/dossiers/01234567/runs/${unknownRunId}/decision`)
        .send({ action: 'approve' }),
    );
    expect(res.status).toBe(404);
  });

  // ─── human_action immutability middleware ─────────────────────────────────

  it('non-GET on /api/fragments/:id with kind=human_action returns 403', async () => {
    // First create a human_action fragment via the decision route.
    const approve = await asAdmin(
      (await api())
        .post(`/api/dossiers/01234567/runs/${runId}/decision`)
        .send({ action: 'approve' }),
    );
    expect(approve.status).toBe(200);
    const fragmentId = approve.body.fragmentId;

    const mutate = await asAdmin(
      (await api()).patch(`/api/fragments/${fragmentId}`).send({ status: 'tampered' }),
    );
    expect(mutate.status).toBe(403);
    expect(mutate.body.error).toMatch(/immutable/);
  });

  it('GET on /api/fragments/:id is allowed (not guarded)', async () => {
    // The GET route doesn't exist, but the middleware must let it pass through.
    // We expect a 404 (no GET handler registered), not 403 (which would be wrong).
    const approve = await asAdmin(
      (await api())
        .post(`/api/dossiers/01234567/runs/${runId}/decision`)
        .send({ action: 'approve' }),
    );
    const fragmentId = approve.body.fragmentId;
    const get = await asAdmin((await api()).get(`/api/fragments/${fragmentId}`));
    // 404 means the middleware passed it through (no GET handler defined).
    expect(get.status).not.toBe(403);
  });

  it('GET /api/audit requires auth (401 on GET without credentials)', async () => {
    const res = await (await api()).get('/api/audit');
    expect(res.status).toBe(401);
  });
});
