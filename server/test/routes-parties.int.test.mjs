// Phase 3 — party routes: list/detail, matcher, watchlist, overrides, graph.
// All DB-backed; no LLM. Auth via dev bypass (admin satisfies the reviewer
// guards on the mutations).
import { it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  describeIntegration,
  api,
  asAdmin,
  getRepo,
  truncateRunData,
  closePool,
} from './helpers/appHarness.mjs';

describeIntegration('routes: parties', () => {
  let repo;
  beforeAll(async () => {
    repo = getRepo();
    await asAdmin((await api()).get('/api/parties')); // warm app
  }, 30_000);
  afterAll(closePool);
  beforeEach(truncateRunData);

  async function makeParty(over = {}) {
    return repo.insertParty({ partyType: 'individual', fullName: 'John Smith', surname: 'Smith', ...over });
  }

  it('GET /api/parties returns the paginated list', async () => {
    let res = await asAdmin((await api()).get('/api/parties'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ parties: [], count: 0 });

    await makeParty();
    res = await asAdmin((await api()).get('/api/parties'));
    expect(res.body.count).toBe(1);
    // listPartiesPage returns a raw SQL projection (snake_case columns).
    expect(res.body.parties[0].full_name).toBe('John Smith');
  });

  it('GET /api/parties/:id returns detail, 404, or 400 for a bad id', async () => {
    const p = await makeParty();
    const ok = await asAdmin((await api()).get(`/api/parties/${p.id}`));
    expect(ok.status).toBe(200);
    // getPartyDetail → { party, links, reviewItems, riskSummary, isWatched }
    expect(ok.body.party.fullName).toBe('John Smith');

    const missing = await asAdmin((await api()).get('/api/parties/11111111-1111-4111-8111-111111111111'));
    expect(missing.status).toBe(404);

    const bad = await asAdmin((await api()).get('/api/parties/not-a-uuid'));
    expect(bad.status).toBe(400);
  });

  it('POST /api/parties/match returns candidates and validates input', async () => {
    await makeParty();
    const ok = await asAdmin((await api()).post('/api/parties/match')).send({ name: 'John Smith' });
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveProperty('inputCanonical');
    expect(Array.isArray(ok.body.candidates)).toBe(true);

    const bad = await asAdmin((await api()).post('/api/parties/match')).send({ name: '' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_payload');
  });

  it('watchlist POST/GET/DELETE round-trips', async () => {
    const p = await makeParty();
    const add = await asAdmin((await api()).post(`/api/parties/${p.id}/watchlist`)).send({ reason: 'PEP' });
    expect(add.status).toBe(200);
    expect(add.body.ok).toBe(true);

    const list = await asAdmin((await api()).get('/api/parties/watchlist'));
    expect(list.status).toBe(200);
    expect(list.body.count).toBe(1);

    const del = await asAdmin((await api()).delete(`/api/parties/${p.id}/watchlist`));
    expect(del.status).toBe(200);
    expect(del.body.removed).toBe(true);
  });

  it('PATCH /api/parties/:id/overrides sets, validates, and clears', async () => {
    const p = await makeParty();
    const set = await asAdmin((await api()).patch(`/api/parties/${p.id}/overrides`))
      .send({ listSource: 'ofac_sdn', decision: 'dismissed', reason: 'false positive' });
    expect(set.status).toBe(200);
    expect(set.body.override.decision).toBe('dismissed');

    const badDecision = await asAdmin((await api()).patch(`/api/parties/${p.id}/overrides`))
      .send({ listSource: 'ofac_sdn', decision: 'maybe' });
    expect(badDecision.status).toBe(400);

    const missingList = await asAdmin((await api()).patch(`/api/parties/${p.id}/overrides`))
      .send({ decision: 'confirmed' });
    expect(missingList.status).toBe(400);

    const clear = await asAdmin((await api()).patch(`/api/parties/${p.id}/overrides`))
      .send({ listSource: 'ofac_sdn', decision: null });
    expect(clear.status).toBe(200);
    expect(clear.body.override).toBeNull();
  });

  it('GET /api/parties/:id/graph returns a graph or 404', async () => {
    const p = await makeParty();
    const ok = await asAdmin((await api()).get(`/api/parties/${p.id}/graph`));
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveProperty('nodes');
    expect(ok.body).toHaveProperty('edges');

    const missing = await asAdmin((await api()).get('/api/parties/11111111-1111-4111-8111-111111111111/graph'));
    expect(missing.status).toBe(404);
  });
});
