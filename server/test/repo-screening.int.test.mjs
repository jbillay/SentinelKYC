// Integration tests for db/repo/screening.js against the test Postgres.
import { it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  describeIntegration,
  getRepo,
  getPool,
  truncateRunData,
  closePool,
} from './helpers/appHarness.mjs';

describeIntegration('repo: screening', () => {
  let repo;
  let dossierId;
  let runId;

  beforeAll(async () => {
    repo = getRepo();
    // Warm pool (session table creation).
    await getPool().query('SELECT 1');
  }, 30_000);

  afterAll(closePool);

  beforeEach(async () => {
    await truncateRunData();
    // Create a dossier + run to attach hits to.
    const dossier = await repo.upsertDossier({ companyNumber: '01234567', companyName: 'ACME LTD' });
    dossierId = dossier.id;
    const run = await repo.createRun({ dossierId, threadId: randomUUID(), trigger: 'initial' });
    runId = run.id;
  });

  // ─── Screening config ───────────────────────────────────────────────────────

  it('getScreeningConfig returns defaults when no row exists', async () => {
    // The screeningConfig table is seeded by migration with id=1.
    const cfg = await repo.getScreeningConfig();
    expect(cfg.matchThreshold).toBeTypeOf('number');
    expect(cfg.matchThreshold).toBeGreaterThan(0.5);
  });

  it('setScreeningConfig patches matchThreshold and getScreeningConfig reflects it', async () => {
    const updated = await repo.setScreeningConfig({ matchThreshold: 0.9 });
    expect(updated).not.toBeNull();
    const cfg = await repo.getScreeningConfig();
    expect(cfg.matchThreshold).toBe(0.9);
    // Restore default.
    await repo.setScreeningConfig({ matchThreshold: 0.85 });
  });

  it('setScreeningConfig rejects an out-of-range threshold', async () => {
    await expect(repo.setScreeningConfig({ matchThreshold: 0.3 }))
      .rejects.toMatchObject({ code: 'invalid_threshold' });
  });

  // ─── Hits ───────────────────────────────────────────────────────────────────

  it('appendScreeningHit inserts a hit row (idempotent)', async () => {
    const hitId = randomUUID();
    const hit1 = await repo.appendScreeningHit({
      id: hitId,
      runId,
      subjectId: 'company:01234567',
      subjectName: 'ACME LTD',
      subjectKind: 'company',
      subjectSource: 'profile',
      listSource: 'OFAC_SDN',
      listEntryId: 'sdn-42',
      matchScore: 0.92,
      matchedFields: ['name'],
      rawEntry: { name: 'ACME CORP', sdnType: 'Entity' },
    });
    expect(hit1.id).toBe(hitId);

    // Idempotent: second insert with same id does nothing and returns undefined.
    const hit2 = await repo.appendScreeningHit({
      id: hitId,
      runId,
      subjectId: 'company:01234567',
      subjectName: 'ACME LTD',
      subjectKind: 'company',
      subjectSource: 'profile',
      listSource: 'OFAC_SDN',
      listEntryId: 'sdn-42',
      matchScore: 0.99,
    });
    expect(hit2).toBeUndefined();
  });

  // ─── Evaluations ────────────────────────────────────────────────────────────

  it('appendScreeningEvaluation inserts and upserts an evaluation', async () => {
    const hitId = randomUUID();
    await repo.appendScreeningHit({
      id: hitId, runId,
      subjectId: 'ind:alice', subjectName: 'Alice', subjectKind: 'individual',
      subjectSource: 'officer', listSource: 'UK_HMT',
    });

    const ev1 = await repo.appendScreeningEvaluation({
      hitId, decision: 'dismissed', llmReasoning: 'clearly different entity', llmScore: 0.1,
    });
    expect(ev1.decision).toBe('dismissed');
    expect(ev1.hitId).toBe(hitId);

    // Upsert — update decision.
    const ev2 = await repo.appendScreeningEvaluation({
      hitId, decision: 'confirmed', llmReasoning: 'exact match on DOB', llmScore: 0.95,
    });
    expect(ev2.decision).toBe('confirmed');
  });

  it('setHumanOverride flips the evaluation override', async () => {
    const hitId = randomUUID();
    await repo.appendScreeningHit({
      id: hitId, runId,
      subjectId: 'ind:bob', subjectName: 'Bob', subjectKind: 'individual',
      subjectSource: 'officer', listSource: 'OFAC_SDN',
    });
    await repo.appendScreeningEvaluation({ hitId, decision: 'needs_review', llmReasoning: 'unclear' });

    const ov = await repo.setHumanOverride(hitId, { decision: 'dismissed', reason: 'Confirmed false positive' });
    expect(ov).toBeTruthy();
    const first = Array.isArray(ov) ? ov[0] : ov;
    expect(first.humanOverride).toBe('dismissed');
    expect(first.overrideReason).toBe('Confirmed false positive');
  });

  // ─── getRunScreening ────────────────────────────────────────────────────────

  it('getRunScreening returns hits and evaluations for the run', async () => {
    const hitId = randomUUID();
    await repo.appendScreeningHit({
      id: hitId, runId,
      subjectId: 'ind:carol', subjectName: 'Carol', subjectKind: 'individual',
      subjectSource: 'officer', listSource: 'UK_HMT',
    });
    await repo.appendScreeningEvaluation({ hitId, decision: 'confirmed', llmReasoning: 'name matches' });

    const { hits, evaluations } = await repo.getRunScreening(runId);
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toBe(hitId);
    expect(evaluations).toHaveLength(1);
    expect(evaluations[0].decision).toBe('confirmed');
  });

  it('getRunScreening returns empty arrays for a run with no hits', async () => {
    const { hits, evaluations } = await repo.getRunScreening(runId);
    expect(hits).toEqual([]);
    expect(evaluations).toEqual([]);
  });

  // ─── listSanctionsLists ─────────────────────────────────────────────────────

  it('listSanctionsLists returns an array (may be empty without lists:refresh)', async () => {
    const lists = await repo.listSanctionsLists();
    expect(Array.isArray(lists)).toBe(true);
  });
});
