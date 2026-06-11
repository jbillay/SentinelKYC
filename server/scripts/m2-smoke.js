#!/usr/bin/env node
// M2 smoke: exercise compile_screening_list + screen_sanctions in isolation
// using a fixture state. The two nodes are deterministic and don't touch CH
// or Ollama, so this is the right boundary to test without paying for a
// 30-minute OCR run.
//
// Asserts:
//  - subjects compiled correctly from a synthetic profile + officers + PSCs
//    + extracted shareholders (deduped on normalized name).
//  - screen_sanctions returns at least one hit when one of the subjects is
//    a known sanctioned individual.
//  - both nodes return a `__fragment` (compile = decision, screen = audit).
//  - hit shape matches what the SSE delta + repo.appendScreeningHit expect.

require('dotenv').config();

const { compileScreeningList } = require('../graph/nodes/screening/compileScreeningList');
const { screenSanctions } = require('../graph/nodes/screening/screenSanctions');
const { pool } = require('../db/client');

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log(`  ok   ${msg}`);
  else {
    console.error(`  FAIL ${msg}`);
    failures += 1;
  }
}

const STATE = {
  companyNumber: '00000001',
  profile: { company_name: 'TEST FIXTURE LTD', company_number: '00000001' },
  officers: {
    items: [
      { name: 'Putin, Vladimir', officer_role: 'director', date_of_birth: { year: 1952, month: 10 } },
      { name: 'Smith, John', officer_role: 'director' },
      { name: 'Bloggs, Resigned', officer_role: 'director', resigned_on: '2020-01-01' },
    ],
  },
  psc: {
    items: [
      { name: 'PUTIN VLADIMIR', kind: 'individual-person-with-significant-control' },
      { name: 'ACME CORPORATE PSC', kind: 'corporate-entity-person-with-significant-control' },
    ],
  },
  kycCard: {
    identity: { name: 'TEST FIXTURE LTD', companyNumber: '00000001' },
    shareholders: [
      // duplicate of an existing PSC after normalization — should be deduped
      { name: 'Vladimir Putin', type: 'individual' },
      // brand-new shareholder
      { name: 'OFFSHORE TRUSTEES PTE', type: 'corporate' },
    ],
  },
};

async function main() {
  console.log('[m2-smoke] running asserts');

  const compiled = await compileScreeningList(STATE);
  const subjects = compiled.screeningSubjects || [];
  const subjectNames = subjects.map((s) => s.name);
  console.log('  subjects:', subjectNames);

  // 1 company + 2 active officers + 2 PSCs + 2 shareholders = 7.
  //
  // The shareholder-stage dedup compares exact normalized-name strings.
  // 'Vladimir Putin' normalizes to 'VLADIMIR PUTIN'; PSC 'PUTIN VLADIMIR'
  // normalizes to 'PUTIN VLADIMIR'. Same person, different token order —
  // so the strict-string dedup keeps both. Acceptable for v1 because the
  // matcher (tokenSetRatio) is order-insensitive at screening time, so
  // both subjects still match the same sanctions entry; the only cost is
  // a duplicate hit row. If this becomes a UI annoyance we can token-sort
  // the dedup key in compile_screening_list.
  assert(subjects.length === 7, `compiled 7 subjects, got ${subjects.length}`);
  assert(subjects.find((s) => s.kind === 'company'), 'company subject present');
  assert(
    subjects.filter((s) => s.source === 'officer').length === 2,
    '2 active officers (resigned excluded)',
  );
  assert(
    subjects.filter((s) => s.source === 'psc').length === 2,
    '2 PSCs',
  );
  assert(
    subjects.filter((s) => s.source === 'shareholder').length === 2,
    '2 shareholders (token-order dedup limitation: Vladimir Putin ≠ PUTIN VLADIMIR)',
  );

  // withFragment strips __fragment from the returned partial state and folds
  // the built fragment into `fragments: [...]` instead. Verify via that side.
  assert(
    Array.isArray(compiled.fragments) && compiled.fragments.length === 1,
    'compileScreeningList produced one fragment',
  );
  assert(
    compiled.fragments?.[0]?.kind === 'decision',
    'compileScreeningList fragment kind = decision',
  );

  // Screen against real sanctions data — Putin should match.
  const screened = await screenSanctions({ ...STATE, screeningSubjects: subjects });
  const hits = screened.screeningHits || [];
  console.log(
    '  hits:',
    hits.map((h) => `${h.subjectName} → ${h.listSource}/${h.rawEntry?.primaryName} (${h.matchScore})`),
  );
  assert(hits.length > 0, `screenSanctions produced ${hits.length} hits`);
  assert(
    hits.some((h) => h.listSource === 'ofac_sdn' && /putin/i.test(h.rawEntry?.primaryName || '')),
    'at least one OFAC hit on Vladimir Putin',
  );
  assert(
    Array.isArray(screened.fragments) && screened.fragments.length === 1,
    'screenSanctions produced one fragment',
  );
  assert(
    screened.fragments?.[0]?.kind === 'audit',
    'screenSanctions fragment kind = audit',
  );
  if (hits.length) {
    const h0 = hits[0];
    assert(typeof h0.hitId === 'string' && h0.hitId.length, 'hit.hitId set');
    assert(typeof h0.subjectId === 'string', 'hit.subjectId set');
    assert(typeof h0.matchScore === 'number', 'hit.matchScore is a number');
    assert(h0.rawEntry && typeof h0.rawEntry === 'object', 'hit.rawEntry is an object');
  }

  console.log(`[m2-smoke] ${failures === 0 ? 'all assertions passed' : `${failures} FAILED`}`);
  if (failures) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('[m2-smoke] crashed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
