// P1 R5 — corroborated EXACT auto-link smoke.
//
// Asserts the resolver's corroboration gate on the matcher's EXACT branch:
//   1. Same name, different DOB year   → 2 parties + review item (dob_mismatch)
//   2. Same name, same DOB + overlapping nationality → 1 party (auto-link)
//   3. Same name, no DOB on either side → 2 parties + review (no_corroborating_signal)
//   4. Corporate, same name → still auto-links (gate is individuals-only)
//   5. PARTY_REQUIRE_CORROBORATION=false → legacy behaviour (bare-name auto-link)
// Plus the pure corroborate() table cases.
//
// Needs Postgres only. Wired as `npm run party-corroboration:smoke`.

const { pool } = require('../db/client');
const repo = require('../db/repo');
const { resolveParties } = require('../services/party/resolver');
const { corroborate } = require('../services/party/corroborate');

function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

const NAMES = [
  'Corrob Dobmismatch',
  'Corrob Autolink',
  'Corrob Bareback',
  'Corrob Flagoff',
  'Corrob Corporate Holdings Ltd',
];

async function defensiveCleanup() {
  await pool.query("DELETE FROM dossiers WHERE company_number LIKE 'CORROB-SMOKE-%'");
  await pool.query(
    `DELETE FROM parties WHERE name_canonical IN (${NAMES.map((_, i) => `name_canonical($${i + 1})`).join(', ')})`,
    NAMES,
  );
}

function officerOf(name, { year, month, nationality, role = 'director' } = {}) {
  const o = {
    name,
    officer_role: role,
    appointed_on: '2020-01-01',
    links: { officer: { appointments: '' } }, // no strong key → matcher path
  };
  if (year) o.date_of_birth = { year, month };
  if (nationality) o.nationality = nationality;
  return o;
}

async function partyCountByName(name) {
  const { rows } = await pool.query(
    'select count(*)::int as n from parties where name_canonical = name_canonical($1) and merged_into_party_id is null',
    [name],
  );
  return rows[0].n;
}

async function main() {
  console.log('[party-corroboration:smoke] running');
  delete process.env.PARTY_REQUIRE_CORROBORATION; // default-on path
  await defensiveCleanup();

  const dossier = await repo.upsertDossier({
    companyNumber: `CORROB-SMOKE-${Date.now()}`,
    companyName: 'Corroboration Smoke Ltd',
  });

  // ----- 0: pure corroborate() table --------------------------------------
  console.log('\n--- 0: pure corroborate() table');
  ok('dob year mismatch → not ok',
    corroborate({ dateOfBirthYear: 1980 }, { dateOfBirthYear: 1981 }).reason === 'dob_mismatch');
  ok('dob month mismatch (same year) → not ok',
    corroborate({ dateOfBirthYear: 1980, dateOfBirthMonth: 5 }, { dateOfBirthYear: 1980, dateOfBirthMonth: 6 }).reason === 'dob_mismatch');
  ok('dob match → ok with signals',
    JSON.stringify(corroborate({ dateOfBirthYear: 1980, dateOfBirthMonth: 5 }, { dateOfBirthYear: 1980, dateOfBirthMonth: 5 }).signalsUsed) === JSON.stringify(['dob_year', 'dob_month']));
  ok('nationality disjoint → not ok',
    corroborate({ nationality: ['British'] }, { nationality: ['French'] }).reason === 'nationality_disjoint');
  ok('nationality overlap (case-insensitive) → ok',
    corroborate({ nationality: ['BRITISH'] }, { nationality: ['british', 'irish'] }).ok === true);
  ok('no signal on either side → no_corroborating_signal',
    corroborate({ fullName: 'X' }, { fullName: 'X' }).reason === 'no_corroborating_signal');
  ok('dob match beats missing nationality',
    corroborate({ dateOfBirthYear: 1980, nationality: [] }, { dateOfBirthYear: 1980 }).ok === true);

  // ----- 1: same name, different DOB year → demoted ------------------------
  console.log('\n--- 1: same name, different DOB year → 2 parties + review');
  const nameA = NAMES[0];
  await resolveParties({
    dossierId: dossier.id, runId: null,
    officers: [officerOf(nameA, { year: 1960, month: 1, nationality: 'British' })],
    psc: [], shareholders: [],
  });
  const rA = await resolveParties({
    dossierId: dossier.id, runId: null,
    officers: [officerOf(nameA, { year: 1990, month: 7, nationality: 'British', role: 'secretary' })],
    psc: [], shareholders: [],
  });
  ok('second resolution created a NEW party', rA.counts.newParties === 1, JSON.stringify(rA.counts));
  ok('counted as exactDemotedToReview', rA.counts.exactDemotedToReview === 1, JSON.stringify(rA.counts));
  ok('two distinct parties exist', (await partyCountByName(nameA)) === 2);
  const demoted = rA.parties.map((p) => p.id);
  const demotedParty = await repo.findPartyById(demoted[demoted.length - 1]);
  ok('demoted party flagged needs_review', demotedParty.needsReview === true);
  ok('review reason explains the demotion',
    /EXACT name match demoted: dob_mismatch/.test(demotedParty.reviewReason || ''),
    `got="${demotedParty.reviewReason}"`);

  // ----- 2: same name + same DOB + overlapping nationality → auto-link -----
  console.log('\n--- 2: same name + matching DOB/nationality → single party');
  const nameB = NAMES[1];
  await resolveParties({
    dossierId: dossier.id, runId: null,
    officers: [officerOf(nameB, { year: 1970, month: 3, nationality: 'French' })],
    psc: [], shareholders: [],
  });
  const rB = await resolveParties({
    dossierId: dossier.id, runId: null,
    officers: [officerOf(nameB, { year: 1970, month: 3, nationality: 'French', role: 'secretary' })],
    psc: [], shareholders: [],
  });
  ok('no new party (corroborated auto-link)', rB.counts.newParties === 0, JSON.stringify(rB.counts));
  ok('counted as autoLinkedCorroborated', rB.counts.autoLinkedCorroborated === 1, JSON.stringify(rB.counts));
  ok('single party for the name', (await partyCountByName(nameB)) === 1);

  // ----- 3: same name, no DOB on either side → review ----------------------
  console.log('\n--- 3: bare-name EXACT (no signals) → 2 parties + review');
  const nameC = NAMES[2];
  await resolveParties({
    dossierId: dossier.id, runId: null,
    officers: [officerOf(nameC)], psc: [], shareholders: [],
  });
  const rC = await resolveParties({
    dossierId: dossier.id, runId: null,
    officers: [officerOf(nameC, { role: 'secretary' })], psc: [], shareholders: [],
  });
  ok('bare-name EXACT created a new party', rC.counts.newParties === 1, JSON.stringify(rC.counts));
  ok('counted as exactDemotedToReview', rC.counts.exactDemotedToReview === 1, JSON.stringify(rC.counts));
  ok('two distinct parties exist', (await partyCountByName(nameC)) === 2);

  // ----- 4: corporate EXACT → still auto-links (control) -------------------
  console.log('\n--- 4: corporate same-name EXACT → still auto-links');
  const nameE = NAMES[4];
  const corpPsc = (notified) => ({
    name: nameE,
    kind: 'corporate-entity-person-with-significant-control',
    notified_on: notified,
    // No registration number → no strong key → matcher path.
    identification: {},
  });
  await resolveParties({ dossierId: dossier.id, runId: null, officers: [], psc: [corpPsc('2021-01-01')], shareholders: [] });
  const rE = await resolveParties({ dossierId: dossier.id, runId: null, officers: [], psc: [corpPsc('2022-02-02')], shareholders: [] });
  ok('no new corporate party (EXACT auto-link kept)', rE.counts.newParties === 0, JSON.stringify(rE.counts));
  ok('single corporate party', (await partyCountByName(nameE)) === 1);

  // ----- 5: flag off → legacy bare-name auto-link --------------------------
  console.log('\n--- 5: PARTY_REQUIRE_CORROBORATION=false → legacy behaviour');
  process.env.PARTY_REQUIRE_CORROBORATION = 'false';
  const nameD = NAMES[3];
  await resolveParties({
    dossierId: dossier.id, runId: null,
    officers: [officerOf(nameD)], psc: [], shareholders: [],
  });
  const rD = await resolveParties({
    dossierId: dossier.id, runId: null,
    officers: [officerOf(nameD, { role: 'secretary' })], psc: [], shareholders: [],
  });
  ok('flag off: bare-name EXACT auto-links', rD.counts.newParties === 0, JSON.stringify(rD.counts));
  ok('flag off: single party', (await partyCountByName(nameD)) === 1);
  delete process.env.PARTY_REQUIRE_CORROBORATION;

  // ----- cleanup -----------------------------------------------------------
  await defensiveCleanup();
  console.log('[party-corroboration:smoke] done');
}

main()
  .catch((err) => {
    console.error('[party-corroboration:smoke] FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
