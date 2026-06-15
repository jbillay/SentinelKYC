// Phase 3 — DB repo round-trips against a real (test) Postgres. Exercises the
// dossier aggregate directly: upsert / read / list / meta / case-status / KPIs.
import { it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { describeIntegration, getRepo, truncateRunData, closePool } from './helpers/appHarness.mjs';

describeIntegration('repo: dossiers', () => {
  let db;
  beforeAll(() => { db = getRepo(); });
  afterAll(closePool);
  beforeEach(truncateRunData);

  it('upserts a dossier and reads it back', async () => {
    const created = await db.upsertDossier({ companyNumber: '01234567', companyName: 'ACME LTD' });
    expect(created.companyNumber).toBe('01234567');
    const got = await db.getDossier('01234567');
    expect(got.companyName).toBe('ACME LTD');
    expect(got.runs).toEqual([]);
  });

  it('upsert is idempotent and updates the name on conflict', async () => {
    await db.upsertDossier({ companyNumber: '01234567', companyName: 'OLD NAME' });
    const updated = await db.upsertDossier({ companyNumber: '01234567', companyName: 'NEW NAME' });
    expect(updated.companyName).toBe('NEW NAME');
    const all = await db.listDossiers();
    expect(all.filter((d) => d.companyNumber === '01234567')).toHaveLength(1);
  });

  it('lists dossiers with q and tag filters', async () => {
    await db.upsertDossier({ companyNumber: '11111111', companyName: 'ALPHA TRADING' });
    await db.upsertDossier({ companyNumber: '22222222', companyName: 'BETA HOLDINGS' });
    await db.updateDossierMeta('11111111', { tags: ['monitor'] });

    expect(await db.listDossiers({ q: 'alpha' })).toHaveLength(1);
    const tagged = await db.listDossiers({ tag: 'monitor' });
    expect(tagged.map((d) => d.companyNumber)).toEqual(['11111111']);
    expect(await db.listDossiers()).toHaveLength(2);
  });

  it('updates meta (tags + notes) and returns null for an unknown company', async () => {
    await db.upsertDossier({ companyNumber: '33333333', companyName: 'GAMMA' });
    const updated = await db.updateDossierMeta('33333333', { tags: ['cleared'], notes: 'looks fine' });
    expect(updated.tags).toEqual(['cleared']);
    expect(updated.notes).toBe('looks fine');
    expect(await db.updateDossierMeta('00000000', { notes: 'x' })).toBeNull();
  });

  it('flips and reads case status', async () => {
    await db.upsertDossier({ companyNumber: '44444444', companyName: 'DELTA' });
    await db.updateDossierCaseStatus('44444444', { caseStatus: 'standard_review' });
    expect((await db.getCaseStatus('44444444')).caseStatus).toBe('standard_review');
  });

  it('computes KPIs over an empty-ish dataset without throwing', async () => {
    await db.upsertDossier({ companyNumber: '55555555', companyName: 'EPSILON' });
    const kpis = await db.computeKpis();
    expect(kpis.dossiersThisMonth.value).toBeGreaterThanOrEqual(1);
    expect(kpis.dossiersThisMonth.trend).toHaveLength(6);
    expect(kpis.avgCompletionHours).toHaveProperty('value');
  });

  it('deletes a dossier', async () => {
    await db.upsertDossier({ companyNumber: '66666666', companyName: 'ZETA' });
    await db.deleteDossier('66666666');
    expect(await db.getDossier('66666666')).toBeNull();
  });
});
