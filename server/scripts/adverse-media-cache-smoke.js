// P1 G1 — party-level adverse-media cache smoke (no network, no DB).
//
// Stubs the GDELT client (require-cache injection) and asserts the two-layer
// cache contract in services/adverseMedia/index.js:
//   1. First search for a party → one real fetch; both caches written.
//   2. Same party, DIFFERENT surface spelling → party-cache hit, zero fetches
//      (the win the name-keyed cache can't deliver).
//   3. Same name, no partyId → name-cache hit (legacy path intact).
//   4. Different party + different name → real fetch (no false sharing).
//   5. Name-cache hit with a partyId promotes into the party cache.

const path = require('path');

// Stub gdelt BEFORE index.js is required.
const gdeltPath = require.resolve('../services/adverseMedia/gdelt');
let fetchCount = 0;
require.cache[gdeltPath] = {
  id: gdeltPath,
  filename: gdeltPath,
  loaded: true,
  exports: {
    searchGdelt: async (name) => {
      fetchCount += 1;
      return [{ title: `stub article for ${name}`, url: 'https://example.test/a' }];
    },
  },
};

const adverseMedia = require('../services/adverseMedia');

function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  console.log('[adverse-media-cache:smoke] running');
  const stamp = Date.now(); // unique names — kv_cache persists across runs
  const partyA = `00000000-0000-4000-8000-${String(stamp).slice(-12)}`;
  const partyB = `00000000-0000-4000-8001-${String(stamp).slice(-12)}`;

  // 1. cold fetch, party-keyed
  const r1 = await adverseMedia.search(`John Smith ${stamp}`, { partyId: partyA });
  ok('cold search fetches from GDELT', r1.cacheHit === false && fetchCount === 1, `fetches=${fetchCount}`);

  // 2. same party, different alias spelling → party cache, no fetch
  const r2 = await adverseMedia.search(`Smith, John ${stamp}`, { partyId: partyA });
  ok('same party + alias spelling → party-cache hit, zero fetches',
    r2.cacheHit === true && r2.cacheLayer === 'party' && fetchCount === 1,
    `layer=${r2.cacheLayer} fetches=${fetchCount}`);

  // 3. same name, no partyId → name cache (legacy path)
  const r3 = await adverseMedia.search(`John Smith ${stamp}`);
  ok('same name without partyId → name-cache hit',
    r3.cacheHit === true && r3.cacheLayer === 'name' && fetchCount === 1,
    `layer=${r3.cacheLayer} fetches=${fetchCount}`);

  // 4. different party + different name → real fetch
  const r4 = await adverseMedia.search(`Aurelia Quince ${stamp}`, { partyId: partyB });
  ok('unrelated party fetches fresh', r4.cacheHit === false && fetchCount === 2, `fetches=${fetchCount}`);

  // 5. name-hit with partyId promotes into the party cache
  const partyC = `00000000-0000-4000-8002-${String(stamp).slice(-12)}`;
  const r5a = await adverseMedia.search(`Aurelia Quince ${stamp}`, { partyId: partyC });
  ok('name-cache hit serves a new party without a fetch',
    r5a.cacheHit === true && r5a.cacheLayer === 'name' && fetchCount === 2,
    `layer=${r5a.cacheLayer} fetches=${fetchCount}`);
  const r5b = await adverseMedia.search(`Quince, Aurelia ${stamp}`, { partyId: partyC });
  ok('…and the promotion makes the alias spelling a party-cache hit',
    r5b.cacheHit === true && r5b.cacheLayer === 'party' && fetchCount === 2,
    `layer=${r5b.cacheLayer} fetches=${fetchCount}`);

  ok('total GDELT fetches across 6 searches = 2', fetchCount === 2, `fetches=${fetchCount}`);
  console.log('[adverse-media-cache:smoke] done');
}

main().catch((err) => {
  console.error('[adverse-media-cache:smoke] FAILED:', err);
  process.exitCode = 1;
});
