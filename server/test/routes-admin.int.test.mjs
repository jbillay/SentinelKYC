// Phase 3 — admin config routes: risk matrix versions/activate, agent config
// save + enable toggle. Validation is server-authoritative; dev-bypass admin
// satisfies the admin guards. No LLM.
import { it, expect, beforeAll, afterAll } from 'vitest';
import { createRequire } from 'node:module';
import { describeIntegration, api, asAdmin, seedReference, closePool } from './helpers/appHarness.mjs';

const require = createRequire(import.meta.url);

describeIntegration('routes: admin config', () => {
  beforeAll(async () => {
    await seedReference();
    await asAdmin((await api()).get('/api/agents')); // warm app
  }, 30_000);
  afterAll(closePool);

  it('GET /api/risk/matrix/versions lists versions', async () => {
    const res = await asAdmin((await api()).get('/api/risk/matrix/versions'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it('POST /api/risk/matrix/versions validates and creates; bad body → 400', async () => {
    const { defaultMatrixBody } = require('../services/risk/matrix');
    const good = await asAdmin((await api()).post('/api/risk/matrix/versions'))
      .send({ body: defaultMatrixBody(), notes: 'integration test version' });
    expect(good.status).toBe(201); // created (not activated)

    const bad = await asAdmin((await api()).post('/api/risk/matrix/versions'))
      .send({ body: { weights: { geographic: 5 } } }); // weights out of range / incomplete
    expect(bad.status).toBe(400);
    expect(bad.body.validationErrors?.length).toBeGreaterThan(0);
  });

  it('GET /api/agents/:id returns detail; unknown → 404', async () => {
    const ok = await asAdmin((await api()).get('/api/agents/screening'));
    expect(ok.status).toBe(200);
    expect(ok.body).toHaveProperty('id', 'screening');

    const missing = await asAdmin((await api()).get('/api/agents/nope'));
    expect(missing.status).toBe(404);
  });

  it('POST /api/agents/:id/config saves a valid body and rejects an invalid one', async () => {
    const ok = await asAdmin((await api()).post('/api/agents/document-manager/config'))
      .send({ body: { enabled: true, pageCapEnabled: true, pageCap: 5, pageSelection: 'relevance' }, notes: 'test' });
    expect(ok.status).toBe(200);
    expect(ok.body.ok).toBe(true);

    const bad = await asAdmin((await api()).post('/api/agents/document-manager/config'))
      .send({ body: { enabled: true, pageCapEnabled: true, pageCap: 999, pageSelection: 'relevance' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('invalid_config');
  });

  it('POST /api/agents/:id/enabled toggles, refuses a required agent, and validates the flag', async () => {
    const off = await asAdmin((await api()).post('/api/agents/screening/enabled')).send({ enabled: false });
    expect(off.status).toBe(200);
    // restore so other tests / runs see it enabled
    await asAdmin((await api()).post('/api/agents/screening/enabled')).send({ enabled: true });

    const required = await asAdmin((await api()).post('/api/agents/entity-resolution/enabled')).send({ enabled: false });
    expect(required.status).toBe(400);
    expect(required.body.error).toBe('agent_required');

    const badFlag = await asAdmin((await api()).post('/api/agents/screening/enabled')).send({ enabled: 'yes' });
    expect(badFlag.status).toBe(400);
  });
});
