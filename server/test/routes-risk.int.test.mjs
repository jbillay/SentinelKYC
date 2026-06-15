// Phase 3 — risk routes: per-run risk read + the recalculate-risk rebase.
// recalculate-risk runs the deterministic engine then the LLM rationale; with
// the dead-host LLM (harness OLLAMA_HOST) it deterministically falls back to
// the template (rationaleSource: 'template') — exercising that path offline.
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

describeIntegration('routes: risk', () => {
  let repo;
  beforeAll(async () => {
    repo = getRepo();
    await seedReference(); // active risk matrix
    await asAdmin((await api()).get('/api/risk/matrix')); // warm app
  }, 30_000);
  afterAll(closePool);
  beforeEach(truncateRunData);

  async function dossierWithSnapshotRun() {
    const d = await repo.upsertDossier({ companyNumber: '01234567', companyName: 'ACME LTD' });
    const run = await repo.createRun({ dossierId: d.id, threadId: 'risk-thread' });
    await repo.closeRun(run.id, {
      status: 'done',
      finalProfile: { type: 'ltd', registered_office_address: { country: 'United Kingdom' }, sic_codes: ['62012'] },
      finalKycCard: { identity: { name: 'ACME LTD' }, shareholders: [] },
      finalScreeningReport: { summary: { overallRisk: 'low' } },
      finalRiskAssessment: { tier: 'Low', score: 10 },
    });
    return { companyNumber: d.companyNumber, runId: run.id };
  }

  it('GET /api/dossiers/:cn/runs/:runId/risk returns the frozen assessment', async () => {
    const { companyNumber, runId } = await dossierWithSnapshotRun();
    const res = await asAdmin((await api()).get(`/api/dossiers/${companyNumber}/runs/${runId}/risk`));
    expect(res.status).toBe(200);
    expect(res.body.riskAssessment.tier).toBe('Low');
  });

  it('GET …/risk is 404 for a run without an assessment', async () => {
    const d = await repo.upsertDossier({ companyNumber: '02222222', companyName: 'BETA' });
    const run = await repo.createRun({ dossierId: d.id, threadId: 'no-risk' });
    const res = await asAdmin((await api()).get(`/api/dossiers/02222222/runs/${run.id}/risk`));
    expect(res.status).toBe(404);
  });

  it('POST recalculate-risk rebases against the active matrix (template rationale, LLM offline)', async () => {
    const { companyNumber } = await dossierWithSnapshotRun();
    const res = await asAdmin((await api()).post(`/api/dossiers/${companyNumber}/recalculate-risk`));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.rationaleSource).toBe('template'); // dead LLM ⇒ fallback
    expect(res.body.riskAssessment).toHaveProperty('tier');
    expect(res.body.riskAssessment).toHaveProperty('receipt');
  });

  it('POST recalculate-risk is 400 when no run carries an API-state snapshot', async () => {
    const d = await repo.upsertDossier({ companyNumber: '03333333', companyName: 'GAMMA' });
    await repo.createRun({ dossierId: d.id, threadId: 'bare' }); // no snapshots
    const res = await asAdmin((await api()).post('/api/dossiers/03333333/recalculate-risk'));
    expect(res.status).toBe(400);
  });

  it('recalculate-risk is 404 for an unknown dossier', async () => {
    const res = await asAdmin((await api()).post('/api/dossiers/00000000/recalculate-risk'));
    expect(res.status).toBe(404);
  });
});
