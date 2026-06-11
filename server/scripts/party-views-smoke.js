// Smoke test for the party-views feature backend:
//   * getPartyDetail enrichment (links carry caseStatus + riskTier;
//     riskSummary + isWatched present)
//   * getPartyScreeningSummary shape
//   * watchlist add / isWatched / list / remove round-trip
//
// Read-mostly: the only writes are to party_watchlist for an existing party,
// and they are reversed at the end so the script is idempotent.

require('dotenv').config();
const repo = require('../db/repo');
const { pool } = require('../db/client');

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) {
    pass += 1;
    console.log(`  ✓ ${label}${extra ? ` — ${extra}` : ''}`);
  } else {
    fail += 1;
    console.log(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

(async () => {
  console.log('[party-views:smoke] running');

  const page = await repo.listPartiesPage({ limit: 1 });
  if (!page.length) {
    console.log('  ! no parties in DB — run a dossier first. Skipping.');
    await pool.end();
    return;
  }
  const partyId = page[0].id;
  console.log(`[party-views:smoke] using party ${partyId} (${page[0].full_name})`);

  // 1. getPartyDetail enrichment
  const detail = await repo.getPartyDetail(partyId);
  ok(!!detail, 'getPartyDetail returns a detail');
  ok(Array.isArray(detail.links), 'detail.links is an array');
  ok('riskSummary' in detail, 'detail has riskSummary');
  ok(
    detail.riskSummary && typeof detail.riskSummary.dossierCount === 'number',
    'riskSummary.dossierCount is a number',
    String(detail.riskSummary?.dossierCount),
  );
  ok('worstTier' in (detail.riskSummary || {}), 'riskSummary has worstTier', String(detail.riskSummary?.worstTier));
  ok(typeof detail.isWatched === 'boolean', 'detail.isWatched is boolean', String(detail.isWatched));
  if (detail.links.length) {
    const l = detail.links[0];
    ok('caseStatus' in l, 'link carries caseStatus', String(l.caseStatus));
    ok('riskTier' in l, 'link carries riskTier', String(l.riskTier));
  } else {
    console.log('  ! party has no links — caseStatus/riskTier per-link checks skipped');
  }

  // 2. getPartyScreeningSummary shape
  const screening = await repo.getPartyScreeningSummary(partyId);
  ok(!!screening, 'getPartyScreeningSummary returns an object');
  ok(screening.counts && typeof screening.counts.total === 'number', 'screening.counts.total is a number', String(screening.counts?.total));
  ok(Array.isArray(screening.hits), 'screening.hits is an array', `n=${screening.hits?.length}`);
  ok(!!screening.byList?.ofac_sdn, 'screening.byList has ofac_sdn bucket');
  ok(['confirmed', 'needs_review', 'dismissed', 'clean'].includes(screening.worstStatus), 'worstStatus is valid', screening.worstStatus);
  if (screening.hits.length) {
    ok('effectiveDecision' in screening.hits[0], 'hit carries effectiveDecision', screening.hits[0].effectiveDecision);
  }

  // 3. Watchlist round-trip
  const before = await repo.isPartyWatched(partyId);
  const added = await repo.addPartyToWatchlist({ partyId, reason: 'smoke test', addedBy: 'smoke' });
  ok(!!added?.id, 'addPartyToWatchlist returns a row');
  ok((await repo.isPartyWatched(partyId)) === true, 'isPartyWatched true after add');
  const watched = await repo.listWatchedParties({ limit: 100 });
  ok(watched.some((w) => w.party_id === partyId), 'listWatchedParties includes the party');
  // idempotent
  const added2 = await repo.addPartyToWatchlist({ partyId, reason: 'smoke test 2', addedBy: 'smoke' });
  ok(!!added2?.id, 'add is idempotent (upsert)');

  // restore prior state
  if (!before) {
    const removed = await repo.removePartyFromWatchlist(partyId);
    ok(removed === true, 'removePartyFromWatchlist true');
    ok((await repo.isPartyWatched(partyId)) === false, 'isPartyWatched false after remove');
  } else {
    console.log('  ! party was already watched before the test — leaving it watched');
  }

  console.log(`[party-views:smoke] done — ${pass} passed, ${fail} failed`);
  await pool.end();
  process.exitCode = fail ? 1 : 0;
})().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
