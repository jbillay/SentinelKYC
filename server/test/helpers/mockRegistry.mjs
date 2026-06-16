// Test helper — a fixture-backed stand-in for services/registry (the data port).
//
// Graph nodes import the registry, not services/ch.js, so mocking this one
// module covers Companies House + any enrichment vendor without live HTTP.
// Fixtures live in test/fixtures/ch/*.json (sanitised real-shape responses).
// See docs/architecture/TEST_STRATEGY.md §5.2.
//
//   import { vi } from 'vitest';
//   import { createRegistryMock } from './helpers/mockRegistry.js';
//   const reg = createRegistryMock({ profile, officers, psc, search });
//   vi.mock('../services/registry', () => reg.module);
import { vi } from 'vitest';

/**
 * @param {object} [data]
 * @param {any[]}  [data.search]    search() results
 * @param {object} [data.profile]   getProfile() result
 * @param {object} [data.officers]  getOfficers() result
 * @param {object} [data.psc]       getOwnership() result (PSC list)
 * @param {object} [data.filings]   getFilings() result
 * @param {Buffer} [data.documentBinary]  getDocumentBinary() bytes
 */
export function createRegistryMock(data = {}) {
  const {
    search = [],
    profile = null,
    officers = { items: [] },
    psc = { items: [] },
    filings = { items: [] },
    documentBinary = Buffer.from('%PDF-1.4 mock'),
  } = data;

  const module = {
    search: vi.fn(async () => search),
    getProfile: vi.fn(async () => profile),
    getOfficers: vi.fn(async () => officers),
    getOwnership: vi.fn(async () => psc),
    getFilings: vi.fn(async () => filings),
    getDocumentMeta: vi.fn(async () => ({})),
    getDocumentBinary: vi.fn(async () => documentBinary),
    downloadDocumentToFile: vi.fn(async (_id, dest) => dest),
    documentIdFromMetadataLink: vi.fn((link) => String(link || '').split('/').pop()),
    listProviders: vi.fn(() => [{ id: 'companies-house', name: 'Companies House', role: 'base' }]),
  };

  return { module, ...module };
}
