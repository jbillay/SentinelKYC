// Integration tests for routes/health.js and routes/meta.js.
// The health endpoint is intentionally light — it reads cached in-memory state
// (the LLM probe runs on a timer, not inline) so it's always fast.
import { it, expect, beforeAll, afterAll } from 'vitest';
import {
  describeIntegration,
  api,
  asAdmin,
  seedReference,
  closePool,
} from './helpers/appHarness.mjs';

describeIntegration('routes: health + meta', () => {
  beforeAll(async () => {
    await seedReference();
    await asAdmin((await api()).get('/api/health'));
  }, 30_000);

  afterAll(closePool);

  it('GET /api/health is accessible without auth and returns the expected shape', async () => {
    const res = await (await api()).get('/api/health');
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('ok');
    expect(res.body).toHaveProperty('llm');
    expect(res.body).toHaveProperty('server');
    expect(res.body.server).toHaveProperty('uptime');
    // The legacy ollama projection is gone — the llm block is the only LLM surface.
    expect(res.body).not.toHaveProperty('ollama');
  });

  it('GET /api/health includes the agents block once seedReference has run', async () => {
    const res = await asAdmin((await api()).get('/api/health'));
    expect(res.status).toBe(200);
    // agents block is best-effort; it IS present when the agent config is seeded.
    expect(Array.isArray(res.body.agents)).toBe(true);
    expect(res.body.agents.length).toBe(6);
    expect(res.body.agents[0]).toHaveProperty('id');
    expect(res.body.agents[0]).toHaveProperty('enabled');
  });

  it('GET /api/health.llm block has the per-task shape', async () => {
    const res = await (await api()).get('/api/health');
    expect(res.body.llm).toHaveProperty('ok');
    expect(res.body.llm).toHaveProperty('ocr');
    expect(res.body.llm).toHaveProperty('reasoning');
  });

  it('GET /api/docs/openapi.json requires auth', async () => {
    const res = await (await api()).get('/api/docs/openapi.json');
    // Without auth → 401 (the docs route is guarded by requireAuth).
    expect(res.status).toBe(401);
  });

  it('GET /api/docs/openapi.json with auth returns the spec', async () => {
    const res = await asAdmin((await api()).get('/api/docs/openapi.json'));
    expect(res.status).toBe(200);
    expect(res.body.openapi).toMatch(/^3\./);
    expect(res.body.info).toHaveProperty('title');
  });
});
