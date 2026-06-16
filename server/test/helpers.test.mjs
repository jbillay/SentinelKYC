// Phase 0 — proves the shared mock helpers behave so later phases can rely on
// them. These exercise the helpers themselves (test infra), not product code.
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { createLlmMock } from './helpers/mockLlm.mjs';
import { createRegistryMock } from './helpers/mockRegistry.mjs';
import { createGdeltMock, article } from './helpers/mockGdelt.mjs';
import { hasDb } from './helpers/testDb.mjs';

describe('mockLlm', () => {
  it('routes extractStructured by prompt substring and falls back to default', async () => {
    const llm = createLlmMock({
      extract: { 'kyc.synthesis': { ok: true }, default: { ok: false } },
    });
    expect(await llm.extractStructured({}, null, 'prompt: kyc.synthesis v2')).toEqual({ ok: true });
    expect(await llm.extractStructured({}, null, 'prompt: ocr.page')).toEqual({ ok: false });
    expect(llm.calls.extractStructured).toHaveLength(2);
  });

  it('validates a scripted response against the provided zod schema', async () => {
    const llm = createLlmMock({ extract: { default: { name: 'X' } } });
    const schema = z.object({ name: z.string() });
    await expect(llm.extractStructured({}, schema, 'p')).resolves.toEqual({ name: 'X' });

    const bad = createLlmMock({ extract: { default: { name: 123 } } });
    await expect(bad.extractStructured({}, schema, 'p')).rejects.toBeTruthy();
  });

  it('reports provider health', async () => {
    expect((await createLlmMock().checkProviders()).ok).toBe(true);
    expect((await createLlmMock({ healthy: false }).checkProviders()).ok).toBe(false);
  });
});

describe('mockRegistry', () => {
  it('serves fixture data through the registry surface', async () => {
    const reg = createRegistryMock({
      profile: { company_name: 'ACME' },
      officers: { items: [{ name: 'A' }] },
    });
    expect((await reg.getProfile('01234567')).company_name).toBe('ACME');
    expect((await reg.getOfficers('01234567')).items).toHaveLength(1);
    expect(await reg.getOwnership('01234567')).toEqual({ items: [] });
  });
});

describe('mockGdelt', () => {
  it('returns scripted articles per subject name and records calls', async () => {
    const gdelt = createGdeltMock({ 'John Smith': [article({ title: 'fined' })] });
    expect(await gdelt.searchGdelt('John Smith')).toHaveLength(1);
    expect(await gdelt.searchGdelt('Nobody')).toEqual([]);
    expect(gdelt.calls).toEqual(['John Smith', 'Nobody']);
  });
});

describe('testDb', () => {
  it('exposes a boolean hasDb derived from DATABASE_URL', () => {
    expect(typeof hasDb).toBe('boolean');
  });
});
