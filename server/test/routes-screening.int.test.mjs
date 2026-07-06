// Integration tests for routes/screening.js (lists, hits/overrides).
// Screening engine config (match threshold, results per subject) moved into
// the screening agent's versioned config — covered by routes-agents tests.
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

describeIntegration('routes: screening', () => {
  let repo;
  let runId;
  let hitId;

  beforeAll(async () => {
    repo = getRepo();
    await seedReference();
    await asAdmin((await api()).get('/api/health'));
  }, 30_000);

  afterAll(closePool);

  beforeEach(async () => {
    await truncateRunData();

    // Seed a dossier + run + one hit + evaluation for hit-level tests.
    const dossier = await repo.upsertDossier({ companyNumber: '01234567', companyName: 'ACME LTD' });
    const run = await repo.createRun({ dossierId: dossier.id, threadId: randomUUID(), trigger: 'initial' });
    runId = run.id;
    hitId = randomUUID();
    await repo.appendScreeningHit({
      id: hitId, runId,
      subjectId: 'company:01234567', subjectName: 'ACME LTD', subjectKind: 'company',
      subjectSource: 'profile', listSource: 'OFAC_SDN', listEntryId: 'sdn-99',
      matchScore: 0.88, matchedFields: ['name'], rawEntry: { name: 'ACME CORP' },
    });
    await repo.appendScreeningEvaluation({
      hitId, decision: 'needs_review', llmReasoning: 'uncertain', llmScore: 0.5,
    });
  });

  // ─── Sanctions lists ────────────────────────────────────────────────────────

  it('GET /api/screening/lists returns an array', async () => {
    const res = await asAdmin((await api()).get('/api/screening/lists'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    // May be empty if lists:refresh hasn't run, which is fine in CI.
  });

  // ─── Retired config endpoints ───────────────────────────────────────────────

  it('GET /api/screening/config is gone (404)', async () => {
    const res = await asAdmin((await api()).get('/api/screening/config'));
    expect(res.status).toBe(404);
  });

  // ─── Run-level screening ────────────────────────────────────────────────────

  it('GET /api/dossiers/:cn/runs/:runId/screening returns hits + evaluations', async () => {
    const res = await asAdmin(
      (await api()).get(`/api/dossiers/01234567/runs/${runId}/screening`),
    );
    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(runId);
    expect(res.body.hits).toHaveLength(1);
    expect(res.body.hits[0].id).toBe(hitId);
    expect(res.body.evaluations).toHaveLength(1);
    expect(res.body.evaluations[0].decision).toBe('needs_review');
  });

  it('GET /api/dossiers/:cn/runs/:runId/screening returns 404 for unknown dossier', async () => {
    const res = await asAdmin(
      (await api()).get(`/api/dossiers/99999999/runs/${runId}/screening`),
    );
    expect(res.status).toBe(404);
  });

  it('GET /api/dossiers/:cn/runs/:runId/screening returns 404 for unknown run', async () => {
    const unknownRunId = randomUUID();
    const res = await asAdmin(
      (await api()).get(`/api/dossiers/01234567/runs/${unknownRunId}/screening`),
    );
    expect(res.status).toBe(404);
  });

  // ─── Hit override (reviewer) ─────────────────────────────────────────────

  it('PATCH /api/dossiers/:cn/runs/:runId/hits/:hitId sets a human override', async () => {
    const res = await asAdmin(
      (await api())
        .patch(`/api/dossiers/01234567/runs/${runId}/hits/${hitId}`)
        .send({ decision: 'dismissed', reason: 'Known false positive' }),
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.evaluation).toBeTruthy();
    // report is rebuilt in the response
    expect(res.body).toHaveProperty('report');
  });

  it('PATCH hit override rejects an invalid decision value', async () => {
    const res = await asAdmin(
      (await api())
        .patch(`/api/dossiers/01234567/runs/${runId}/hits/${hitId}`)
        .send({ decision: 'invalid_value' }),
    );
    expect(res.status).toBe(400);
  });

  it('PATCH hit override clears override when decision is null', async () => {
    // First set, then clear.
    await asAdmin((await api())
      .patch(`/api/dossiers/01234567/runs/${runId}/hits/${hitId}`)
      .send({ decision: 'confirmed' }));

    const res = await asAdmin(
      (await api())
        .patch(`/api/dossiers/01234567/runs/${runId}/hits/${hitId}`)
        .send({ decision: null }),
    );
    expect(res.status).toBe(200);
  });

  // ─── Carry overrides forward ─────────────────────────────────────────────

  it('POST /api/dossiers/:cn/runs/:runId/carry-overrides-forward returns ok', async () => {
    // Give the hit an override to carry forward.
    await asAdmin(
      (await api())
        .patch(`/api/dossiers/01234567/runs/${runId}/hits/${hitId}`)
        .send({ decision: 'dismissed', reason: 'fp' }),
    );
    const res = await asAdmin(
      (await api()).post(`/api/dossiers/01234567/runs/${runId}/carry-overrides-forward`),
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body).toHaveProperty('carried');
    expect(res.body).toHaveProperty('dossierLevel');
    expect(res.body).toHaveProperty('partyLevel');
  });

  it('GET /api/screening/lists requires auth', async () => {
    const res = await (await api()).get('/api/screening/lists');
    expect(res.status).toBe(401);
  });
});
