// S4 — Integration tests for services/decision/index.js (applyDecision).
//
// Tests the service directly (not via HTTP) against a real Postgres database
// so all transaction/constraint behaviour is exercised.  Requires TEST_DATABASE_URL.
import { it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import {
  describeIntegration,
  getRepo,
  getPool,
  closePool,
  truncateRunData,
} from './helpers/appHarness.mjs';

const require = createRequire(import.meta.url);

describeIntegration('services/decision: applyDecision', () => {
  let repo;
  let applyDecision;
  let ALLOWED_FROM_ANY, ALLOWED_FROM_APPROVE, ACTION_TO_NEXT_STATUS;

  // Shared dossier + run recreated before each test.
  let companyNumber;
  let runId;

  beforeAll(async () => {
    repo = getRepo();
    ({ applyDecision, ALLOWED_FROM_ANY, ALLOWED_FROM_APPROVE, ACTION_TO_NEXT_STATUS } =
      require('../services/decision/index'));
  }, 30_000);

  afterAll(closePool);

  beforeEach(async () => {
    await truncateRunData();
    companyNumber = '0' + Math.floor(Math.random() * 9_000_000 + 1_000_000);
    const dossier = await repo.upsertDossier({ companyNumber, companyName: 'Test Co Ltd' });
    const run = await repo.createRun({
      dossierId: dossier.id,
      threadId: randomUUID(),
      trigger: 'initial',
    });
    runId = run.id;
  });

  // ─── Exports / constants ─────────────────────────────────────────────────────

  it('ACTION_TO_NEXT_STATUS maps all four actions', () => {
    expect(ACTION_TO_NEXT_STATUS.approve).toBe('approved');
    expect(ACTION_TO_NEXT_STATUS.reject).toBe('rejected');
    expect(ACTION_TO_NEXT_STATUS.escalate).toBe('escalated');
    expect(ACTION_TO_NEXT_STATUS.request_info).toBe('info_requested');
  });

  it('ALLOWED_FROM_ANY includes pending', () => {
    expect(ALLOWED_FROM_ANY.has('pending')).toBe(true);
  });

  it('ALLOWED_FROM_APPROVE does NOT include info_requested', () => {
    expect(ALLOWED_FROM_APPROVE.has('info_requested')).toBe(false);
  });

  // ─── Input validation errors ─────────────────────────────────────────────────

  it('throws when companyNumber is missing', async () => {
    await expect(
      applyDecision({ companyNumber: null, runId, userId: 'u1', payload: { action: 'approve' } }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws when runId is missing', async () => {
    await expect(
      applyDecision({ companyNumber, runId: null, userId: 'u1', payload: { action: 'approve' } }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws when userId is missing', async () => {
    await expect(
      applyDecision({ companyNumber, runId, userId: null, payload: { action: 'approve' } }),
    ).rejects.toThrow('userId required');
  });

  it('throws when payload.action is missing', async () => {
    await expect(
      applyDecision({ companyNumber, runId, userId: 'u1', payload: {} }),
    ).rejects.toThrow('payload.action required');
  });

  it('throws invalid_payload for an unknown action', async () => {
    await expect(
      applyDecision({ companyNumber, runId, userId: 'u1', payload: { action: 'yolo' } }),
    ).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  // ─── not_found errors ────────────────────────────────────────────────────────

  it('throws not_found for a missing dossier', async () => {
    await expect(
      applyDecision({ companyNumber: '99999999', runId, userId: 'u1', payload: { action: 'approve' } }),
    ).rejects.toMatchObject({ code: 'not_found', message: /dossier/ });
  });

  it('throws not_found for a missing run', async () => {
    const fakeRunId = randomUUID();
    await expect(
      applyDecision({ companyNumber, runId: fakeRunId, userId: 'u1', payload: { action: 'approve' } }),
    ).rejects.toMatchObject({ code: 'not_found', message: /run/ });
  });

  it('throws not_found when run belongs to a different dossier', async () => {
    const other = await repo.upsertDossier({ companyNumber: '87654321', companyName: 'Other Co' });
    const otherRun = await repo.createRun({
      dossierId: other.id, threadId: randomUUID(), trigger: 'initial',
    });
    await expect(
      applyDecision({ companyNumber, runId: otherRun.id, userId: 'u1', payload: { action: 'approve' } }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  // ─── Happy paths ─────────────────────────────────────────────────────────────

  it('approve: flips caseStatus to approved and returns fragmentId', async () => {
    const result = await applyDecision({
      companyNumber,
      runId,
      userId: 'reviewer-1',
      payload: { action: 'approve' },
    });
    expect(result.ok).toBe(true);
    expect(result.caseStatus).toBe('approved');
    expect(result.previousCaseStatus).toBe('pending');
    expect(typeof result.fragmentId).toBe('string');

    const pool = getPool();
    const { rows } = await pool.query(
      "SELECT case_status FROM dossiers WHERE company_number = $1",
      [companyNumber],
    );
    expect(rows[0].case_status).toBe('approved');
  });

  it('reject: flips caseStatus to rejected', async () => {
    const result = await applyDecision({
      companyNumber,
      runId,
      userId: 'reviewer-1',
      payload: { action: 'reject', reasonCode: 'sanctions_hit', freeText: 'Clear sanctions match found.' },
    });
    expect(result.caseStatus).toBe('rejected');
    expect(result.ok).toBe(true);
  });

  it('escalate: flips caseStatus to escalated', async () => {
    const result = await applyDecision({
      companyNumber,
      runId,
      userId: 'reviewer-1',
      payload: { action: 'escalate', notes: 'Needs senior sign-off on complex structure.' },
    });
    expect(result.caseStatus).toBe('escalated');
  });

  it('request_info: flips caseStatus to info_requested', async () => {
    const result = await applyDecision({
      companyNumber,
      runId,
      userId: 'reviewer-1',
      payload: {
        action: 'request_info',
        items: [{ description: 'Provide UBO documentation', category: 'identity' }],
      },
    });
    expect(result.caseStatus).toBe('info_requested');
  });

  it('writes a human_action decision_fragment with correct fields', async () => {
    const result = await applyDecision({
      companyNumber,
      runId,
      userId: 'reviewer-99',
      payload: { action: 'approve' },
    });

    const pool = getPool();
    const { rows } = await pool.query(
      'SELECT * FROM decision_fragments WHERE id = $1',
      [result.fragmentId],
    );
    expect(rows).toHaveLength(1);
    const frag = rows[0];
    expect(frag.kind).toBe('human_action');
    expect(frag.node_id).toBe('human_decision');
    expect(frag.run_id).toBe(runId);
    expect(frag.status).toBe('ok');
    expect(frag.inputs.userId).toBe('reviewer-99');
    expect(frag.inputs.action).toBe('approve');
  });

  it('fragment summary includes the userId', async () => {
    const result = await applyDecision({
      companyNumber,
      runId,
      userId: 'alice',
      payload: { action: 'approve' },
    });
    const pool = getPool();
    const { rows } = await pool.query(
      'SELECT summary FROM decision_fragments WHERE id = $1',
      [result.fragmentId],
    );
    expect(rows[0].summary).toMatch(/alice/);
  });

  it('escalate summary includes "escalated"', async () => {
    const result = await applyDecision({
      companyNumber,
      runId,
      userId: 'bob',
      payload: { action: 'escalate', notes: 'Needs extra review for complex ownership.' },
    });
    const pool = getPool();
    const { rows } = await pool.query(
      'SELECT summary FROM decision_fragments WHERE id = $1',
      [result.fragmentId],
    );
    expect(rows[0].summary).toMatch(/escalated/i);
  });

  it('request_info summary includes item count', async () => {
    const result = await applyDecision({
      companyNumber,
      runId,
      userId: 'carol',
      payload: {
        action: 'request_info',
        items: [
          { description: 'ID document', category: 'identity' },
          { description: 'Proof of address', category: 'address' },
        ],
      },
    });
    const pool = getPool();
    const { rows } = await pool.query(
      'SELECT summary FROM decision_fragments WHERE id = $1',
      [result.fragmentId],
    );
    expect(rows[0].summary).toMatch(/2 items/);
  });

  // ─── resumeOwed stamp ────────────────────────────────────────────────────────

  it('stamps resume_owed_at on the run when resumeOwed=true', async () => {
    await applyDecision({
      companyNumber,
      runId,
      userId: 'u1',
      payload: { action: 'approve' },
      resumeOwed: true,
    });
    const pool = getPool();
    const { rows } = await pool.query(
      'SELECT resume_owed_at FROM runs WHERE id = $1',
      [runId],
    );
    expect(rows[0].resume_owed_at).not.toBeNull();
  });

  it('does NOT stamp resume_owed_at when resumeOwed=false (default)', async () => {
    await applyDecision({
      companyNumber,
      runId,
      userId: 'u1',
      payload: { action: 'approve' },
    });
    const pool = getPool();
    const { rows } = await pool.query(
      'SELECT resume_owed_at FROM runs WHERE id = $1',
      [runId],
    );
    expect(rows[0].resume_owed_at).toBeNull();
  });

  // ─── invalid_transition guards ───────────────────────────────────────────────

  it('throws invalid_transition for approve from a terminal approved state', async () => {
    // First apply an approve to get to terminal state.
    await applyDecision({ companyNumber, runId, userId: 'u1', payload: { action: 'approve' } });
    // Second approve from 'approved' should be rejected.
    await expect(
      applyDecision({ companyNumber, runId, userId: 'u1', payload: { action: 'approve' } }),
    ).rejects.toMatchObject({ code: 'invalid_transition', from: 'approved' });
  });

  it('throws invalid_transition for approve from escalated', async () => {
    await applyDecision({
      companyNumber, runId, userId: 'u1',
      payload: { action: 'escalate', notes: 'Needs further review from senior analyst.' },
    });
    // escalated is in ALLOWED_FROM_ANY but NOT ALLOWED_FROM_APPROVE — approve should fail.
    await expect(
      applyDecision({ companyNumber, runId, userId: 'u1', payload: { action: 'approve' } }),
    ).rejects.toMatchObject({ code: 'invalid_transition' });
  });

  it('allows reject from escalated (escalated is in ALLOWED_FROM_ANY)', async () => {
    await applyDecision({
      companyNumber, runId, userId: 'u1',
      payload: { action: 'escalate', notes: 'Need more information before deciding.' },
    });
    const result = await applyDecision({
      companyNumber, runId, userId: 'u1',
      payload: { action: 'reject', reasonCode: 'high_risk', freeText: 'Risk too high after review.' },
    });
    expect(result.caseStatus).toBe('rejected');
  });

  it('throws invalid_transition from rejected (terminal)', async () => {
    await applyDecision({
      companyNumber, runId, userId: 'u1',
      payload: { action: 'reject', reasonCode: 'sanctions_hit', freeText: 'Confirmed sanctions match.' },
    });
    await expect(
      applyDecision({
        companyNumber, runId, userId: 'u1',
        payload: { action: 'escalate', notes: 'Actually, let us escalate instead.' },
      }),
    ).rejects.toMatchObject({ code: 'invalid_transition', from: 'rejected' });
  });

  // ─── Fragment userId is NOT in outputs ───────────────────────────────────────

  it('actionMetadata strips userId from outputs', async () => {
    const result = await applyDecision({
      companyNumber,
      runId,
      userId: 'strip-me',
      payload: {
        action: 'reject',
        userId: 'should-be-stripped',
        reasonCode: 'other',
        freeText: 'Test that userId is stripped from outputs.',
      },
    });
    const pool = getPool();
    const { rows } = await pool.query(
      'SELECT outputs FROM decision_fragments WHERE id = $1',
      [result.fragmentId],
    );
    expect(rows[0].outputs.userId).toBeUndefined();
  });
});
