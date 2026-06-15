// Integration tests for db/repo/qa.js against the test Postgres.
import { it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  describeIntegration,
  getRepo,
  getPool,
  truncateRunData,
  closePool,
} from './helpers/appHarness.mjs';

describeIntegration('repo: qa', () => {
  let repo;
  let dossierId;
  let runId;

  const SNAPSHOT = {
    finalProfile: { company_status: 'active' },
    finalKycCard: { identity: { name: 'ACME LTD' } },
    finalScreeningReport: { summary: { overallRisk: 'low', confirmedHits: 0 } },
    finalRiskAssessment: { score: 10, tier: 'Low', outcome: 'Low' },
  };

  const QA_RESULT = {
    passed: true,
    completeness: { passed: true, missingFields: [] },
    consistency: { passed: true, issues: [] },
    routing: { caseStatus: 'auto_approved', qaSummary: 'All checks passed' },
    qaSummary: 'All checks passed',
    tier: 'Low',
    evaluatedAt: new Date().toISOString(),
  };

  beforeAll(async () => {
    repo = getRepo();
    await getPool().query('SELECT 1');
  }, 30_000);

  afterAll(closePool);

  beforeEach(async () => {
    await truncateRunData();
    const dossier = await repo.upsertDossier({ companyNumber: '01234567', companyName: 'ACME LTD' });
    dossierId = dossier.id;
    const run = await repo.createRun({ dossierId, threadId: randomUUID(), trigger: 'initial' });
    runId = run.id;
  });

  it('setRunQaResult writes qaResult onto the run row', async () => {
    const row = await repo.setRunQaResult(runId, QA_RESULT);
    expect(row).not.toBeNull();
    expect(row.qaResult.passed).toBe(true);
    expect(row.qaResult.routing.caseStatus).toBe('auto_approved');
  });

  it('setRunQaNarrative writes the narrative text', async () => {
    const narrative = 'ACME LTD is a low-risk entity.';
    const row = await repo.setRunQaNarrative(runId, narrative);
    expect(row).not.toBeNull();
    expect(row.qaNarrative).toBe(narrative);
  });

  it('finalizeRunQa writes qa_result and mirrors case_status to dossier (non-terminal)', async () => {
    // Close run with snapshots so getLatestRunWithSnapshots can find it.
    await repo.closeRun(runId, { status: 'done', ...SNAPSHOT });

    const { run: updatedRun, caseStatusUpdated } = await repo.finalizeRunQa(
      runId,
      '01234567',
      QA_RESULT,
      { mirrorCaseStatus: true },
    );
    expect(updatedRun.qaResult.passed).toBe(true);
    expect(caseStatusUpdated).toBe(true);

    const dossier = await repo.getDossier('01234567');
    expect(dossier.caseStatus).toBe('auto_approved');
  });

  it('finalizeRunQa does NOT mirror case_status when mirrorCaseStatus is false', async () => {
    await repo.closeRun(runId, { status: 'done', ...SNAPSHOT });

    const { caseStatusUpdated } = await repo.finalizeRunQa(
      runId,
      '01234567',
      QA_RESULT,
      { mirrorCaseStatus: false },
    );
    expect(caseStatusUpdated).toBe(false);

    const dossier = await repo.getDossier('01234567');
    expect(dossier.caseStatus).toBe('pending'); // unchanged
  });

  it('finalizeRunQa does not overwrite terminal approved status', async () => {
    await repo.closeRun(runId, { status: 'done', ...SNAPSHOT });
    // Force dossier into a terminal state.
    await getPool().query(
      `UPDATE dossiers SET case_status = 'approved' WHERE company_number = '01234567'`,
    );

    const failQa = { ...QA_RESULT, routing: { caseStatus: 'standard_review', qaSummary: 'issues' } };
    const { caseStatusUpdated } = await repo.finalizeRunQa(runId, '01234567', failQa, {
      mirrorCaseStatus: true,
    });
    expect(caseStatusUpdated).toBe(false); // terminal guard

    const dossier = await repo.getDossier('01234567');
    expect(dossier.caseStatus).toBe('approved'); // untouched
  });

  it('getLatestRunWithSnapshots returns null when no snapshot run exists', async () => {
    const result = await repo.getLatestRunWithSnapshots('01234567');
    expect(result).toBeNull();
  });

  it('getLatestRunWithSnapshots returns the run once snapshots are written', async () => {
    await repo.closeRun(runId, { status: 'done', ...SNAPSHOT });
    const result = await repo.getLatestRunWithSnapshots('01234567');
    expect(result).not.toBeNull();
    expect(result.id).toBe(runId);
  });
});
