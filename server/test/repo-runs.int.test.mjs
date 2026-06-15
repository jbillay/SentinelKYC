// Phase 3 — runs aggregate round-trips against a real (test) Postgres.
import { it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { describeIntegration, getRepo, truncateRunData, closePool } from './helpers/appHarness.mjs';

describeIntegration('repo: runs', () => {
  let db;
  let dossierId;
  beforeAll(() => { db = getRepo(); });
  afterAll(closePool);
  beforeEach(async () => {
    await truncateRunData();
    const d = await db.upsertDossier({ companyNumber: '01234567', companyName: 'ACME LTD' });
    dossierId = d.id;
  });

  it('creates a running run and reads it back with empty fragments', async () => {
    const run = await db.createRun({ dossierId, threadId: 'thread-1' });
    expect(run.status).toBe('running');
    const got = await db.getRun(run.id);
    expect(got.threadId).toBe('thread-1');
    expect(got.fragments).toEqual([]);
    expect(await db.getRunByThreadId('thread-1')).toMatchObject({ id: run.id });
  });

  it('closes a run with a final risk assessment and timestamps it', async () => {
    const run = await db.createRun({ dossierId, threadId: 'thread-2' });
    const closed = await db.closeRun(run.id, { status: 'done', finalRiskAssessment: { tier: 'Low', score: 12 } });
    expect(closed.status).toBe('done');
    expect(closed.endedAt).not.toBeNull();
    expect(closed.finalRiskAssessment).toMatchObject({ tier: 'Low' });
  });

  it('lists runs for a dossier newest-first', async () => {
    const a = await db.createRun({ dossierId, threadId: 't-a' });
    await db.closeRun(a.id, { status: 'done' }); // free the one-running-per-dossier slot
    await db.createRun({ dossierId, threadId: 't-b' });
    const list = await db.getRunsForDossier(dossierId);
    expect(list).toHaveLength(2);
    expect(list[0].threadId).toBe('t-b'); // most recent first
  });

  it('reapStaleRuns returns a count without throwing', async () => {
    await db.createRun({ dossierId, threadId: 't-stale' });
    const reaped = await db.reapStaleRuns({ olderThanMinutes: 0 });
    expect(typeof reaped).toBe('number');
  });
});
