// Test helper — a stand-in for services/adverseMedia/gdelt.
//
// Mocks searchGdelt so adverse-media tests cover the cache layer (party-key →
// name-key → fetch) and the per-subject evaluation logic without live HTTP or
// the 6s rate-limit semaphore. See docs/architecture/TEST_STRATEGY.md §5.3.
//
//   import { vi } from 'vitest';
//   import { createGdeltMock, article } from './helpers/mockGdelt.js';
//   const gdelt = createGdeltMock({ 'John Smith': [article({ title: 'X fined' })] });
//   vi.mock('../services/adverseMedia/gdelt', () => gdelt.module);
import { vi } from 'vitest';

/** Build a normalized article matching gdelt.normalizeArticle() output. */
export function article(over = {}) {
  return {
    title: 'Mock headline',
    snippet: '', // GDELT ArtList has no description — always ''
    url: 'https://example.test/article',
    publishedAt: '2025-01-15T12:00:00Z',
    source: 'example.test',
    ...over,
  };
}

/**
 * @param {Record<string, any[]> | ((name:string)=>any[])} [byName]
 *   Articles to return per subject name (object keyed by name, or a function).
 */
export function createGdeltMock(byName = {}) {
  const calls = [];
  const searchGdelt = vi.fn(async (name) => {
    calls.push(name);
    if (typeof byName === 'function') return byName(name) || [];
    return byName[name] || [];
  });

  const module = {
    searchGdelt,
    // Re-export the pure helpers unchanged — tests of these import the real file.
    buildQuery: (n) => `"${n}"`,
    normalizeArticle: (i) => article(i),
    parseSeenDate: (s) => s || null,
  };

  return { calls, searchGdelt, module };
}
