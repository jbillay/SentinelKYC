// S5 — integration tests for services/party/graph.js (buildPartyGraph).
// Requires TEST_DATABASE_URL.

import { it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { describeIntegration, getRepo, getPool, truncateRunData, closePool } from './helpers/appHarness.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describeIntegration('buildPartyGraph', () => {
  let repo;
  let buildPartyGraph, GraphBuildError;
  let pool;

  beforeAll(() => {
    repo = getRepo();
    pool = getPool();
    ({ buildPartyGraph, GraphBuildError } = require('../services/party/graph.js'));
  });
  afterAll(closePool);
  beforeEach(truncateRunData);

  async function makeParty(over = {}) {
    return repo.insertParty({ partyType: 'individual', fullName: 'Graph Test Person', ...over });
  }

  async function makeDossier(companyNumber, name = 'Graph Test Co') {
    const r = await pool.query(
      `INSERT INTO dossiers (company_number, company_name, case_status) VALUES ($1, $2, 'pending') RETURNING id`,
      [companyNumber, name],
    );
    return r.rows[0].id;
  }

  async function linkPartyToDossier(partyId, dossierId, role = 'officer') {
    await pool.query(
      `INSERT INTO party_links (party_id, dossier_id, role, status) VALUES ($1::uuid, $2::uuid, $3, 'active')`,
      [partyId, dossierId, role],
    );
  }

  // ─── validation ─────────────────────────────────────────────────────────

  it('throws GraphBuildError (invalid_payload) when partyId is missing', async () => {
    await expect(buildPartyGraph(null)).rejects.toMatchObject({ code: 'invalid_payload' });
    await expect(buildPartyGraph('')).rejects.toMatchObject({ code: 'invalid_payload' });
  });

  it('throws GraphBuildError (not_found) when party does not exist', async () => {
    await expect(
      buildPartyGraph('00000000-0000-0000-0000-000000000000'),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  // ─── isolated party (no links) ────────────────────────────────────────────

  it('returns a graph with just the centre node when party has no links', async () => {
    const p = await makeParty({ fullName: 'Isolated Party' });
    const g = await buildPartyGraph(p.id);
    expect(g.centerPartyId).toBe(p.id);
    expect(g.nodes).toHaveLength(1);
    expect(g.nodes[0].data.id).toBe(`party:${p.id}`);
    expect(g.nodes[0].data.isCenter).toBe(true);
    expect(g.edges).toHaveLength(0);
    expect(g.counts.truncated).toBe(false);
  });

  // ─── depth 1: centre → linked dossiers ───────────────────────────────────

  it('adds dossier node and an edge for each linked dossier', async () => {
    const p = await makeParty({ fullName: 'Party With Dossier' });
    const d1 = await makeDossier('11111111', 'Company One');
    const d2 = await makeDossier('22222222', 'Company Two');
    await linkPartyToDossier(p.id, d1);
    await linkPartyToDossier(p.id, d2);

    const g = await buildPartyGraph(p.id, { depth: 1 });
    expect(g.nodes.filter((n) => n.data.kind === 'dossier')).toHaveLength(2);
    expect(g.edges).toHaveLength(2);
    for (const e of g.edges) {
      expect(e.data.source).toBe(`party:${p.id}`);
    }
    expect(g.counts.dossiers).toBe(2);
  });

  // ─── depth 2: includes other parties on linked dossiers ──────────────────

  it('includes other parties on the same dossier at depth 2', async () => {
    const centre = await makeParty({ fullName: 'Centre Party' });
    const other = await makeParty({ fullName: 'Other Officer' });
    const dossierId = await makeDossier('33333333', 'Shared Co');
    await linkPartyToDossier(centre.id, dossierId, 'officer');
    await linkPartyToDossier(other.id, dossierId, 'psc');

    const g = await buildPartyGraph(centre.id, { depth: 2 });
    const partyIds = g.nodes.map((n) => n.data.id);
    expect(partyIds).toContain(`party:${other.id}`);
    expect(g.counts.parties).toBe(2);
  });

  it('does NOT include other parties at depth=1', async () => {
    const centre = await makeParty({ fullName: 'Centre d1' });
    const other = await makeParty({ fullName: 'Other d1' });
    const dossierId = await makeDossier('44444444', 'D1 Co');
    await linkPartyToDossier(centre.id, dossierId);
    await linkPartyToDossier(other.id, dossierId);

    const g = await buildPartyGraph(centre.id, { depth: 1 });
    const partyIds = g.nodes.map((n) => n.data.id);
    expect(partyIds).not.toContain(`party:${other.id}`);
  });

  // ─── node cap / truncation ────────────────────────────────────────────────

  it('caps nodes at the limit and sets counts.truncated', async () => {
    const centre = await makeParty({ fullName: 'Hub' });
    // Create 5 dossiers — with limit=3 we only fit centre + 2 dossiers.
    for (let i = 0; i < 5; i++) {
      const d = await makeDossier(`5500000${i}`, `Co ${i}`);
      await linkPartyToDossier(centre.id, d);
    }
    const g = await buildPartyGraph(centre.id, { depth: 1, limit: 3 });
    expect(g.nodes.length).toBeLessThanOrEqual(3);
    expect(g.counts.truncated).toBe(true);
  });

  // ─── response shape ───────────────────────────────────────────────────────

  it('returns the correct top-level shape', async () => {
    const p = await makeParty();
    const g = await buildPartyGraph(p.id);
    expect(g).toMatchObject({
      centerPartyId: p.id,
      depth: expect.any(Number),
      limit: expect.any(Number),
      nodes: expect.any(Array),
      edges: expect.any(Array),
      counts: expect.objectContaining({
        nodes: expect.any(Number),
        edges: expect.any(Number),
        dossiers: expect.any(Number),
        parties: expect.any(Number),
        truncated: expect.any(Boolean),
      }),
    });
  });
});
