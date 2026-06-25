// S5 — integration tests for services/party/resolver.js (resolveParties).
// Requires TEST_DATABASE_URL.
//
// Tests cover the main orchestration paths without triggering LLM:
//   - empty inputs
//   - officer resolution (strong key + new party)
//   - PSC resolution (individual + corporate)
//   - shareholder resolution
//   - historical reconciliation

import { it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { describeIntegration, getRepo, getPool, truncateRunData, closePool } from './helpers/appHarness.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

// Disable the corroboration gate so EXACT name matches auto-link without DOB.
process.env.PARTY_REQUIRE_CORROBORATION = 'false';

describeIntegration('resolveParties', () => {
  let repo;
  let resolveParties;
  let pool;

  beforeAll(() => {
    repo = getRepo();
    pool = getPool();
    ({ resolveParties } = require('../services/party/resolver.js'));
  });
  afterAll(closePool);
  beforeEach(truncateRunData);

  async function makeDossier(cn = '00000001') {
    const r = await pool.query(
      `INSERT INTO dossiers (company_number, company_name, case_status) VALUES ($1, $2, 'pending') RETURNING id`,
      [cn, 'Resolver Test Co'],
    );
    return r.rows[0].id;
  }

  // ─── empty inputs ─────────────────────────────────────────────────────────

  it('handles all-empty inputs (returns zero counts)', async () => {
    const dossierId = await makeDossier();
    const result = await resolveParties({ dossierId });
    expect(result.counts.officers).toBe(0);
    expect(result.counts.psc).toBe(0);
    expect(result.counts.shareholders).toBe(0);
    expect(result.counts.newParties).toBe(0);
    expect(result.parties).toHaveLength(0);
    expect(result.links).toHaveLength(0);
  });

  it('throws when dossierId is missing', async () => {
    await expect(resolveParties({})).rejects.toThrow('dossierId required');
  });

  // ─── officer: no appointment id → name-matcher path ──────────────────────

  it('creates a new party for a brand-new officer (no strong key)', async () => {
    const dossierId = await makeDossier('10000001');
    const officers = [{ name: 'Alice Newperson', officer_role: 'director', appointed_on: '2020-01-01' }];

    const result = await resolveParties({ dossierId, officers });
    expect(result.counts.officers).toBe(1);
    expect(result.counts.newParties).toBe(1);
    expect(result.parties[0].created).toBe(true);
  });

  it('links the officer to the dossier', async () => {
    const dossierId = await makeDossier('10000002');
    const officers = [{ name: 'Bob Linked', officer_role: 'director' }];

    const result = await resolveParties({ dossierId, officers });
    expect(result.links).toHaveLength(1);
    expect(result.links[0].role).toBe('officer');
  });

  // ─── officer: strong key (appointment id) ────────────────────────────────

  it('links to an existing party via CH appointment id (strong key)', async () => {
    const dossierId1 = await makeDossier('10000003');
    const dossierId2 = await makeDossier('10000004');
    const apptPath = '/officers/appt-abc/appointments';
    const officer = {
      name: 'Charlie Strong',
      officer_role: 'director',
      links: { officer: { appointments: apptPath } },
    };

    // First run creates the party
    const r1 = await resolveParties({ dossierId: dossierId1, officers: [officer] });
    const partyId = r1.parties[0].id;
    expect(r1.counts.newParties).toBe(1);

    // Second run on a different dossier should find it by appointment id
    const r2 = await resolveParties({ dossierId: dossierId2, officers: [officer] });
    expect(r2.parties[0].id).toBe(partyId);
    expect(r2.counts.newParties).toBe(0);
    expect(r2.counts.autoLinkedStrong).toBe(1);
  });

  // ─── PSC ─────────────────────────────────────────────────────────────────

  it('creates a new party for an individual PSC', async () => {
    const dossierId = await makeDossier('20000001');
    const psc = [{
      name: 'Diana PSC',
      kind: 'individual-person-with-significant-control',
      natures_of_control: ['ownership-of-shares-75-to-100-percent'],
      notified_on: '2019-03-01',
    }];

    const result = await resolveParties({ dossierId, psc });
    expect(result.counts.psc).toBe(1);
    expect(result.counts.newParties).toBe(1);
    expect(result.links[0].role).toBe('psc');
  });

  it('creates a new party for a corporate PSC without registration number', async () => {
    const dossierId = await makeDossier('20000002');
    const psc = [{
      name: 'PARENT CORP',
      kind: 'corporate-entity-person-with-significant-control',
      natures_of_control: ['ownership-of-shares-25-to-50-percent'],
    }];

    const result = await resolveParties({ dossierId, psc });
    expect(result.counts.psc).toBe(1);
    expect(result.counts.newParties).toBe(1);
    const party = await repo.findPartyById(result.parties[0].id);
    expect(party.partyType).toBe('organisation');
  });

  // ─── shareholder ─────────────────────────────────────────────────────────

  it('creates a new party for a shareholder', async () => {
    const dossierId = await makeDossier('30000001');
    const shareholders = [{ name: 'Eve Shareholder', type: 'individual', shares: 500, percentage: 50 }];

    const result = await resolveParties({ dossierId, shareholders });
    expect(result.counts.shareholders).toBe(1);
    expect(result.counts.newParties).toBe(1);
    expect(result.links[0].role).toBe('shareholder');
  });

  it('records share count and percentage on the link', async () => {
    const dossierId = await makeDossier('30000002');
    const shareholders = [{ name: 'Fred Holdings', type: 'corporate', shares: 1000, percentage: 100 }];

    const result = await resolveParties({ dossierId, shareholders });
    const link = result.links[0];
    expect(Number(link.shares_count)).toBe(1000);
    expect(Number(link.shares_percentage)).toBe(100);
  });

  // ─── resigned officer status ──────────────────────────────────────────────

  it('marks resigned officer link as resigned', async () => {
    const dossierId = await makeDossier('40000001');
    const officers = [{
      name: 'Grace Resigned',
      officer_role: 'director',
      appointed_on: '2015-01-01',
      resigned_on: '2022-06-30',
    }];

    const result = await resolveParties({ dossierId, officers });
    expect(result.links[0].status).toBe('resigned');
  });

  // ─── historical reconciliation ────────────────────────────────────────────

  it('flips untouched links to historical on re-run', async () => {
    const dossierId = await makeDossier('50000001');
    const officers = [
      { name: 'Hank Active', officer_role: 'director' },
      { name: 'Iris Gone', officer_role: 'director' },
    ];

    // First run — both links created
    await resolveParties({ dossierId, officers });

    // Second run — Iris is gone from the officers list
    await resolveParties({ dossierId, officers: [officers[0]], reconcileHistorical: true });

    const linksRes = await pool.query(
      `SELECT pl.status, p.full_name FROM party_links pl
       JOIN parties p ON p.id = pl.party_id
       WHERE pl.dossier_id = $1::uuid`,
      [dossierId],
    );
    const statusMap = Object.fromEntries(linksRes.rows.map((r) => [r.full_name, r.status]));
    expect(statusMap['Hank Active']).toBe('active');
    expect(statusMap['Iris Gone']).toBe('historical');
  });

  it('skips historical reconciliation when reconcileHistorical=false', async () => {
    const dossierId = await makeDossier('50000002');
    const officers = [
      { name: 'Jack Active', officer_role: 'director' },
      { name: 'Kim Stale', officer_role: 'director' },
    ];
    await resolveParties({ dossierId, officers });

    // Only Jack in second run, but reconciliation disabled
    const r2 = await resolveParties({ dossierId, officers: [officers[0]], reconcileHistorical: false });
    expect(r2.counts.historicalReconciled).toBe(0);

    const linksRes = await pool.query(
      `SELECT status FROM party_links WHERE dossier_id = $1::uuid AND status = 'historical'`,
      [dossierId],
    );
    expect(linksRes.rows).toHaveLength(0);
  });

  // ─── EXACT name-match dedup across dossiers ───────────────────────────────

  it('auto-links an exact name match to the existing party (corroboration disabled)', async () => {
    const d1 = await makeDossier('60000001');
    const d2 = await makeDossier('60000002');
    const officers = [{ name: 'Lara Croft', officer_role: 'director' }];

    const r1 = await resolveParties({ dossierId: d1, officers });
    const partyId = r1.parties[0].id;
    expect(r1.counts.newParties).toBe(1);

    const r2 = await resolveParties({ dossierId: d2, officers });
    expect(r2.parties[0].id).toBe(partyId);
    expect(r2.counts.newParties).toBe(0);
    expect(r2.counts.autoLinkedExact).toBe(1);
  });
});
