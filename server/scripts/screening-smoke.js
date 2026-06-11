#!/usr/bin/env node
// M1 smoke test: prove sanctions data is loaded and queryable.
require('dotenv').config();
const repo = require('../db/repo');
const sanctions = require('../services/sanctions');
const { pool } = require('../db/client');

let failures = 0;
function assert(cond, msg) {
  if (cond) {
    console.log(`  ok   ${msg}`);
  } else {
    console.error(`  FAIL ${msg}`);
    failures += 1;
  }
}

async function main() {
  console.log('[screening:smoke] running asserts');

  const lists = await repo.listSanctionsLists();
  const sources = new Set(lists.map((l) => l.source));
  assert(sources.has('ofac_sdn'), 'ofac_sdn version row exists');
  assert(sources.has('uk_hmt'), 'uk_hmt version row exists');

  const counts = await sanctions.countEntriesBySource();
  const byId = Object.fromEntries(counts.map((c) => [c.source, c.count]));
  assert((byId.ofac_sdn || 0) > 0, `ofac_sdn entries non-empty (got ${byId.ofac_sdn || 0})`);
  assert((byId.uk_hmt || 0) > 0, `uk_hmt entries non-empty (got ${byId.uk_hmt || 0})`);

  // Search via repo + via sanctions barrel.
  const repoHits = await repo.searchSanctionsByNormalizedName('PUTIN');
  assert(repoHits.length > 0, `repo.searchSanctionsByNormalizedName('PUTIN') returned ${repoHits.length} candidates`);

  const matches = await sanctions.search('Vladimir Putin', { threshold: 0.7 });
  assert(matches.length > 0, `sanctions.search('Vladimir Putin') matched ${matches.length} entries`);
  if (matches.length) {
    const top = matches[0];
    assert(top.score >= 0.7, `top match score ${top.score.toFixed(3)} >= 0.7`);
  }

  console.log(`[screening:smoke] ${failures === 0 ? 'all assertions passed' : `${failures} FAILED`}`);
  if (failures) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('[screening:smoke] crashed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
