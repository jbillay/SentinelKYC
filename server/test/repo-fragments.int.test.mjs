// Integration tests for db/repo/fragments.js against the test Postgres.
import { it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  describeIntegration,
  getRepo,
  getPool,
  truncateRunData,
  closePool,
} from './helpers/appHarness.mjs';

describeIntegration('repo: fragments', () => {
  let repo;
  let dossierId;
  let runId;

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

  function baseFragment(over = {}) {
    return {
      runId,
      nodeId: 'gather_input',
      sequence: 0,
      kind: 'audit',
      status: 'ok',
      summary: 'Input gathered',
      startedAt: new Date().toISOString(),
      durationMs: 42,
      inputs: { name: 'ACME' },
      outputs: { normalised: true },
      ...over,
    };
  }

  it('appendFragment inserts and returns the row', async () => {
    const row = await repo.appendFragment(baseFragment());
    expect(row).not.toBeUndefined();
    expect(row.nodeId).toBe('gather_input');
    expect(row.kind).toBe('audit');
    expect(row.status).toBe('ok');
  });

  it('appendFragment is idempotent when called with the same id', async () => {
    const id = randomUUID();
    const r1 = await repo.appendFragment(baseFragment({ id, sequence: 1, summary: 'first' }));
    const r2 = await repo.appendFragment(baseFragment({ id, sequence: 1, summary: 'second' }));
    expect(r1.id).toBe(id);
    expect(r2).toBeUndefined(); // conflict → nothing returned
  });

  it('appendFragmentsBatch inserts multiple fragments in one call', async () => {
    const rows = await repo.appendFragmentsBatch([
      baseFragment({ sequence: 0, nodeId: 'gather_input', kind: 'audit' }),
      baseFragment({ sequence: 1, nodeId: 'search_ch', kind: 'audit', summary: 'Searched CH' }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.nodeId)).toEqual(expect.arrayContaining(['gather_input', 'search_ch']));
  });

  it('appendFragmentsBatch handles empty array gracefully', async () => {
    const rows = await repo.appendFragmentsBatch([]);
    expect(rows).toEqual([]);
  });

  it('listFragments returns fragments with joined dossier/run info', async () => {
    await repo.appendFragment(baseFragment({ sequence: 0, kind: 'decision' }));
    const all = await repo.listFragments();
    expect(all.length).toBeGreaterThanOrEqual(1);
    // Has the join columns from the dossier + run joins.
    expect(all[0]).toHaveProperty('companyNumber');
    expect(all[0]).toHaveProperty('runStatus');
  });

  it('listFragments filters by kind', async () => {
    await repo.appendFragment(baseFragment({ sequence: 0, kind: 'decision', nodeId: 'qa_check' }));
    await repo.appendFragment(baseFragment({ sequence: 1, kind: 'audit', nodeId: 'gather_input' }));

    const decisions = await repo.listFragments({ kind: 'decision' });
    expect(decisions.every((f) => f.kind === 'decision')).toBe(true);
  });

  it('getLatestHumanActionFragment returns null when no human_action exists', async () => {
    const result = await repo.getLatestHumanActionFragment(runId);
    expect(result).toBeNull();
  });

  it('getLatestHumanActionFragment returns the newest human_action row', async () => {
    await repo.appendFragment({
      runId, nodeId: 'human_decision', sequence: 0, kind: 'human_action',
      status: 'ok', summary: 'User approved', startedAt: new Date().toISOString(), durationMs: 0,
    });
    await repo.appendFragment({
      runId, nodeId: 'human_decision', sequence: 1, kind: 'human_action',
      status: 'ok', summary: 'User escalated', startedAt: new Date().toISOString(), durationMs: 0,
    });
    const latest = await repo.getLatestHumanActionFragment(runId);
    expect(latest.sequence).toBe(1);
    expect(latest.summary).toBe('User escalated');
  });

  it('listFragments with human_action kind lists audit-trail rows', async () => {
    await repo.appendFragment({
      runId, nodeId: 'human_decision', sequence: 0, kind: 'human_action',
      status: 'ok', summary: 'Approved', startedAt: new Date().toISOString(), durationMs: 0,
    });
    const rows = await repo.listFragments({ kind: 'human_action', limit: 10 });
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows.every((r) => r.kind === 'human_action')).toBe(true);
  });
});
