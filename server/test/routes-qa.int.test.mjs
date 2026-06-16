// Integration tests for routes/qa.js (GET result + recompute).
// The LLM is dead (dead Ollama host), so recompute exercises the pure QA engine
// and confirms the route returns the correct shape without calling an LLM.
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

const SNAPSHOT = {
  finalProfile: { company_status: 'active', company_number: '01234567' },
  finalOfficers: { items: [] },
  finalPsc: { items: [{ name: 'Jane Doe', kind: 'individual-person-with-significant-control' }] },
  finalKycCard: {
    identity: { name: 'ACME LTD', companyNumber: '01234567', status: 'active', countryOfIncorporation: 'United Kingdom' },
    shareholders: [{ name: 'Jane Doe', type: 'individual' }],
    redFlags: [],
  },
  finalDocuments: [],
  finalScreeningReport: {
    summary: { subjectCount: 2, confirmedHits: 0, needsReview: 0, dismissedHits: 0, overallRisk: 'low' },
    perSubject: [],
  },
  finalRiskAssessment: { score: 12, tier: 'Low', outcome: 'Low', knockoutsTriggered: [], rationale: 'Low risk.' },
};

describeIntegration('routes: qa', () => {
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

  // ─── GET frozen result ───────────────────────────────────────────────────

  it('GET /api/dossiers/:cn/runs/:runId/qa returns 404 when qa has not run', async () => {
    const res = await asAdmin(
      (await api()).get(`/api/dossiers/01234567/runs/${runId}/qa`),
    );
    expect(res.status).toBe(404);
  });

  it('GET /api/dossiers/:cn/runs/:runId/qa returns the frozen qaResult after it is written', async () => {
    await repo.setRunQaResult(runId, {
      passed: true,
      completeness: { passed: true, missingFields: [] },
      consistency: { passed: true, issues: [] },
      routing: { caseStatus: 'auto_approved', qaSummary: 'All checks passed' },
      qaSummary: 'All checks passed',
      tier: 'Low',
      evaluatedAt: new Date().toISOString(),
    });

    const res = await asAdmin(
      (await api()).get(`/api/dossiers/01234567/runs/${runId}/qa`),
    );
    expect(res.status).toBe(200);
    expect(res.body.runId).toBe(runId);
    expect(res.body.qaResult.passed).toBe(true);
    expect(res.body.qaResult.routing.caseStatus).toBe('auto_approved');
  });

  it('GET /api/dossiers/:cn/runs/:runId/qa returns 404 for unknown dossier', async () => {
    const res = await asAdmin(
      (await api()).get(`/api/dossiers/99999999/runs/${runId}/qa`),
    );
    expect(res.status).toBe(404);
  });

  // ─── Recompute ───────────────────────────────────────────────────────────

  it('POST /api/dossiers/:cn/runs/:runId/qa/recompute returns 400 when run has no snapshots', async () => {
    const res = await asAdmin(
      (await api()).post(`/api/dossiers/01234567/runs/${runId}/qa/recompute`),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/snapshot/);
  });

  it('POST /api/dossiers/:cn/runs/:runId/qa/recompute runs the pure QA engine and returns qaResult', async () => {
    await repo.closeRun(runId, { status: 'done', ...SNAPSHOT });

    const res = await asAdmin(
      (await api()).post(`/api/dossiers/01234567/runs/${runId}/qa/recompute`),
    );
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.runId).toBe(runId);
    expect(res.body.qaResult).toHaveProperty('passed');
    expect(res.body.qaResult).toHaveProperty('routing');
    expect(res.body.caseStatusUpdated).toBe(false); // mirrorCaseStatus:false in recompute
  });

  it('POST /api/dossiers/:cn/runs/:runId/qa/recompute returns 400 when case is finalised', async () => {
    await repo.closeRun(runId, { status: 'done', ...SNAPSHOT });
    await getPool().query(
      `UPDATE dossiers SET case_status = 'approved' WHERE company_number = '01234567'`,
    );

    const res = await asAdmin(
      (await api()).post(`/api/dossiers/01234567/runs/${runId}/qa/recompute`),
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/finalized/);
  });

  it('POST qa/recompute returns 404 for unknown dossier', async () => {
    const res = await asAdmin(
      (await api()).post(`/api/dossiers/99999999/runs/${runId}/qa/recompute`),
    );
    expect(res.status).toBe(404);
  });

  it('GET /api/dossiers/:cn/runs/:runId/qa requires auth', async () => {
    const res = await (await api()).get(`/api/dossiers/01234567/runs/${runId}/qa`);
    expect(res.status).toBe(401);
  });
});
