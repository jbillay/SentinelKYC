// Integration tests for routes/prompts.js (versioned prompt registry CRUD).
// Admin role required for mutating operations; reads are open to any role.
import { it, expect, beforeAll, afterAll } from 'vitest';
import {
  describeIntegration,
  api,
  asAdmin,
  seedReference,
  closePool,
} from './helpers/appHarness.mjs';

describeIntegration('routes: prompts', () => {
  beforeAll(async () => {
    await seedReference();
    await asAdmin((await api()).get('/api/prompts'));
  }, 30_000);

  afterAll(closePool);

  it('GET /api/prompts returns all seeded prompt keys', async () => {
    const res = await asAdmin((await api()).get('/api/prompts'));
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThan(0);
    expect(res.body[0]).toHaveProperty('key');
    expect(res.body[0]).toHaveProperty('label');
  });

  it('GET /api/prompts/:key returns detail for a known key', async () => {
    const res = await asAdmin((await api()).get('/api/prompts/kyc.synthesis'));
    expect(res.status).toBe(200);
    expect(res.body.key).toBe('kyc.synthesis');
    expect(res.body).toHaveProperty('active');
    expect(res.body).toHaveProperty('versions');
    expect(Array.isArray(res.body.versions)).toBe(true);
  });

  it('GET /api/prompts/:key returns 404 for an unknown key', async () => {
    const res = await asAdmin((await api()).get('/api/prompts/nonexistent.key'));
    expect(res.status).toBe(404);
  });

  it('POST /api/prompts/:key/versions creates a new version (admin only)', async () => {
    const body = 'Updated synthesis prompt body for testing purposes.';
    const res = await asAdmin((await api())
      .post('/api/prompts/kyc.synthesis/versions')
      .send({ body, notes: 'test version' }));
    expect(res.status).toBe(201);
    expect(res.body.promptKey).toBe('kyc.synthesis');
    expect(res.body.body).toBe(body);
    expect(res.body.id).toBeTruthy();
  });

  it('POST /api/prompts/:key/versions rejects empty body with 400', async () => {
    const res = await asAdmin((await api())
      .post('/api/prompts/kyc.synthesis/versions')
      .send({ body: '  ', notes: 'blank' }));
    expect(res.status).toBe(400);
  });

  it('POST /api/prompts/:key/versions returns 404 for an unknown key', async () => {
    const res = await asAdmin((await api())
      .post('/api/prompts/nonexistent.key/versions')
      .send({ body: 'something' }));
    expect(res.status).toBe(404);
  });

  it('GET /api/prompts/:key/versions/:id returns a specific version', async () => {
    // First create a version to get an id.
    const create = await asAdmin((await api())
      .post('/api/prompts/kyc.synthesis/versions')
      .send({ body: 'version body for get test' }));
    expect(create.status).toBe(201);
    const versionId = create.body.id;

    const res = await asAdmin((await api()).get(`/api/prompts/kyc.synthesis/versions/${versionId}`));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(versionId);
    expect(res.body.body).toBe('version body for get test');
  });

  it('GET /api/prompts/:key/versions/:id returns 404 for an unknown version', async () => {
    const res = await asAdmin((await api())
      .get('/api/prompts/kyc.synthesis/versions/00000000-0000-4000-8000-000000000000'));
    expect(res.status).toBe(404);
  });

  it('POST /api/prompts/:key/active activates a version', async () => {
    // Create a new version then make it active.
    const create = await asAdmin((await api())
      .post('/api/prompts/kyc.synthesis/versions')
      .send({ body: 'body for active test' }));
    expect(create.status).toBe(201);
    const versionId = create.body.id;

    const res = await asAdmin((await api())
      .post('/api/prompts/kyc.synthesis/active')
      .send({ versionId }));
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.active.id).toBe(versionId);
  });

  it('POST /api/prompts/:key/active rejects missing versionId', async () => {
    const res = await asAdmin((await api())
      .post('/api/prompts/kyc.synthesis/active')
      .send({}));
    expect(res.status).toBe(400);
  });

  it('GET /api/prompts requires auth', async () => {
    const res = await (await api()).get('/api/prompts');
    expect(res.status).toBe(401);
  });
});
