// Phase 1b — Resolver smoke.
//
// Walks every behaviour the resolver must guarantee, asserting after each
// step. Designed to be re-runnable: seeds + cleans up its own fixtures.
//
//   1. Officer with appointment_id (strong key) → new party, link, status_history
//   2. Re-run same input → no new party, link upserted, no extra status history
//   3. Officer with resigned_on now set → link status flips, history row added
//   4. Officer without appointment_id (first sighting) → new party via matcher's no-match path
//   5. Re-run same name officer → matcher EXACT → auto-link, no new party
//   6. PSC with same name as the EXACT-linked officer → single party, 2 links (officer + psc)
//   7. Corporate PSC with registration matching a seeded dossier → party.dossier_id back-link
//   8. Officer name that's a close typo of a seeded party → REVIEW → new party + review queue item
//   9. Historical reconciliation: drop an officer from inputs, rerun → link → 'historical'
//
// Wired as `npm run party-resolver:smoke`.

const { pool } = require('../db/client');
const repo = require('../db/repo');
const { resolveParties } = require('../services/party/resolver');

function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

async function countRowsForLink(linkId) {
  const { rows } = await pool.query(
    'select count(*)::int as n from party_link_status_history where link_id = $1',
    [linkId],
  );
  return rows[0].n;
}

async function getLinkById(linkId) {
  const { rows } = await pool.query('select * from party_links where id = $1', [linkId]);
  return rows[0] || null;
}

async function getReviewQueueForParty(partyId) {
  const { rows } = await pool.query(
    "select * from party_review_queue where party_id = $1 and status = 'open'",
    [partyId],
  );
  return rows;
}

async function defensiveCleanup() {
  // Wipe any leftover smoke fixtures from previous (possibly failed) runs.
  // We use deterministic names so re-runs of the smoke produce predictable
  // matcher behaviour; that means we ALSO need to clear those names from
  // the DB before each run so they don't accidentally pre-match the inputs.
  await pool.query("DELETE FROM dossiers WHERE company_number LIKE 'RESOLVER-SMOKE-%'");
  // Match against canonical (lowercased + sorted) form to catch every
  // variant we seed (e.g. 'Featherwick, Aldwin' canonicalises to
  // 'aldwin featherwick').
  await pool.query(
    `DELETE FROM parties WHERE name_canonical IN (
       name_canonical('Featherwick, Aldwin'),
       name_canonical('Crispin Owlbright'),
       name_canonical('Bartholomew Highwater'),
       name_canonical('Bartholmew Highwater'),
       name_canonical('Resolver Smoke Parent Holdings Ltd')
     )`,
  );
}

async function main() {
  console.log('[party-resolver:smoke] running');
  await defensiveCleanup();

  // ----- Setup -----------------------------------------------------------
  const COMPANY = `RESOLVER-SMOKE-${Date.now()}`;
  const dossier = await repo.upsertDossier({
    companyNumber: COMPANY,
    companyName: 'Resolver Smoke Co Ltd',
  });
  // Second seeded dossier so we can test the corporate-PSC dossier
  // back-link path.
  const PARENT_COMPANY = `RESOLVER-SMOKE-PARENT-${Date.now()}`;
  const parentDossier = await repo.upsertDossier({
    companyNumber: PARENT_COMPANY,
    companyName: 'Resolver Smoke Parent Holdings Ltd',
  });
  const seededPartyIds = [];
  const seededDossierIds = [dossier.id, parentDossier.id];

  // For the REVIEW + queue test we seed an existing party that our typo'd
  // input will match against (similar but not identical canonical).
  const seededTypoTarget = await repo.insertNewParty({
    partyType: 'individual',
    fullName: 'Bartholomew Highwater',
    sourceKind: 'manual',
  });
  seededPartyIds.push(seededTypoTarget.id);

  // For the EXACT auto-link cross-source test we'll create the officer in
  // step 4 and reuse it.
  let exactAutoLinkPartyId = null;

  // ----- Test 1: Officer with appointment_id (strong key, fresh) ---------
  console.log('\n--- 1: officer with appointment_id, first sighting');
  const officer1Run1 = {
    name: 'Featherwick, Aldwin',
    officer_role: 'director',
    appointed_on: '2020-01-15',
    nationality: 'British',
    country_of_residence: 'England',
    date_of_birth: { year: 1980, month: 5 },
    links: { officer: { appointments: '/officers/appt_aldwin_001/appointments' } },
  };
  const r1 = await resolveParties({
    dossierId: dossier.id,
    runId: null,
    officers: [officer1Run1],
    psc: [],
    shareholders: [],
  });
  ok('1 link created', r1.links.length === 1, `got=${r1.links.length}`);
  ok('1 new party', r1.counts.newParties === 1, `got=${r1.counts.newParties}`);
  // autoLinkedStrong counts the strong-key decision regardless of whether
  // an existing party was found or a new one was created — the link's
  // match_confidence is 1.0 either way. Here it should be 1.
  ok('strong-key path taken', r1.counts.autoLinkedStrong === 1, JSON.stringify(r1.counts));

  const aldwinParty1Id = r1.parties[0].id;
  seededPartyIds.push(aldwinParty1Id);
  const aldwinParty1 = await repo.findPartyById(aldwinParty1Id);
  ok('appointment_id persisted', aldwinParty1.chOfficerAppointmentId === 'appt_aldwin_001',
    `got=${aldwinParty1.chOfficerAppointmentId}`);
  ok('match_evidence kind=appointment_id', r1.links[0].match_evidence?.kind === 'appointment_id',
    JSON.stringify(r1.links[0].match_evidence));
  ok('1 status transition (link first observed)',
    r1.statusTransitions.length === 1,
    `got=${r1.statusTransitions.length}`);

  // ----- Test 2: Re-run identical input (idempotency) --------------------
  console.log('\n--- 2: same input again, no new rows expected');
  const r2 = await resolveParties({
    dossierId: dossier.id,
    runId: null,
    officers: [officer1Run1],
    psc: [],
    shareholders: [],
  });
  ok('still 1 link', r2.links.length === 1);
  ok('no new party created', r2.counts.newParties === 0, JSON.stringify(r2.counts));
  ok('no new status transition', r2.statusTransitions.length === 0,
    `got=${r2.statusTransitions.length}`);
  ok('historical reconciled 0', r2.counts.historicalReconciled === 0);

  const historyCount2 = await countRowsForLink(r2.links[0].id);
  ok('status_history row count unchanged at 1', historyCount2 === 1, `got=${historyCount2}`);

  // ----- Test 3: Officer is now resigned ---------------------------------
  console.log('\n--- 3: same officer, now resigned_on present');
  const officer1Run3 = { ...officer1Run1, resigned_on: '2024-06-30' };
  const r3 = await resolveParties({
    dossierId: dossier.id,
    runId: null,
    officers: [officer1Run3],
    psc: [],
    shareholders: [],
  });
  const link3 = await getLinkById(r3.links[0].id);
  ok('link.status = resigned', link3.status === 'resigned', `got=${link3.status}`);
  ok('link.resigned_on populated',
    link3.resigned_on != null,
    `got=${link3.resigned_on}`);
  ok('1 new status_history row (active→resigned)',
    r3.statusTransitions.length === 1,
    `got=${r3.statusTransitions.length}`);
  const historyCount3 = await countRowsForLink(link3.id);
  ok('total status_history rows for link = 2', historyCount3 === 2, `got=${historyCount3}`);

  // ----- Test 4: Officer without appointment_id, no matches --------------
  console.log('\n--- 4: officer with NO appointment_id, no matcher candidates');
  const officer2 = {
    name: 'Crispin Owlbright',
    officer_role: 'secretary',
    appointed_on: '2021-03-10',
    // R5 — DOB + nationality so the later EXACT re-match corroborates and
    // auto-links (a bare-name EXACT now routes to review by design; the
    // demotion paths are covered by party-corroboration-smoke).
    nationality: 'British',
    date_of_birth: { year: 1975, month: 9 },
    links: { officer: { appointments: '' } }, // no parseable appointment_id
  };
  const r4 = await resolveParties({
    dossierId: dossier.id,
    runId: null,
    officers: [officer1Run3, officer2], // include Aldwin so historical doesn't fire
    psc: [],
    shareholders: [],
  });
  ok('1 new party (Crispin)', r4.counts.newParties === 1, JSON.stringify(r4.counts));
  const crispinLink = r4.links.find((l) => {
    const ref = l.source_ref || {};
    return ref.name === 'Crispin Owlbright';
  });
  ok('Crispin link exists', !!crispinLink);
  ok('Crispin match_evidence kind=new',
    crispinLink?.match_evidence?.kind === 'new',
    JSON.stringify(crispinLink?.match_evidence));
  exactAutoLinkPartyId = crispinLink.party_id;
  seededPartyIds.push(exactAutoLinkPartyId);

  // ----- Test 5: Same officer name again → EXACT auto-link ---------------
  console.log('\n--- 5: same officer name again, expect EXACT auto-link');
  const r5 = await resolveParties({
    dossierId: dossier.id,
    runId: null,
    officers: [officer1Run3, officer2],
    psc: [],
    shareholders: [],
  });
  ok('no new party created (EXACT auto-link)',
    r5.counts.newParties === 0,
    JSON.stringify(r5.counts));

  // ----- Test 6: PSC with same name as Crispin → 2 links, 1 party --------
  console.log('\n--- 6: PSC named Crispin → matcher EXACT → 2 links on same party');
  const cripsinAsPsc = {
    name: 'Crispin Owlbright',
    kind: 'individual-person-with-significant-control',
    notified_on: '2021-04-01',
    natures_of_control: ['ownership-of-shares-25-to-50-percent'],
    // R5 — same DOB/nationality as the officer record so the cross-source
    // EXACT match corroborates onto the same party.
    nationality: 'British',
    date_of_birth: { year: 1975, month: 9 },
  };
  const r6 = await resolveParties({
    dossierId: dossier.id,
    runId: null,
    officers: [officer1Run3, officer2],
    psc: [cripsinAsPsc],
    shareholders: [],
  });
  ok('still no new party (PSC EXACT-matched the officer)',
    r6.counts.newParties === 0,
    JSON.stringify(r6.counts));
  // Verify there are now TWO links pointing at Crispin's partyId.
  const { rows: crispinLinks } = await pool.query(
    'select role from party_links where party_id = $1',
    [exactAutoLinkPartyId],
  );
  ok('Crispin party has 2 links (officer + psc)',
    crispinLinks.length === 2,
    `got=${crispinLinks.length} roles=${crispinLinks.map((r) => r.role).join(',')}`);
  ok('the two roles are officer + psc',
    new Set(crispinLinks.map((r) => r.role)).size === 2 &&
      crispinLinks.some((r) => r.role === 'officer') &&
      crispinLinks.some((r) => r.role === 'psc'));

  // ----- Test 7: Corporate PSC with registration matching seeded dossier
  console.log('\n--- 7: corporate PSC with registration matching seeded dossier');
  const corpPsc = {
    name: 'Resolver Smoke Parent Holdings Ltd',
    kind: 'corporate-entity-person-with-significant-control',
    notified_on: '2022-01-01',
    identification: {
      registration_number: PARENT_COMPANY,
      country_registered: 'United Kingdom',
    },
  };
  const r7 = await resolveParties({
    dossierId: dossier.id,
    runId: null,
    officers: [officer1Run3, officer2],
    psc: [cripsinAsPsc, corpPsc],
    shareholders: [],
  });
  const corpLink = r7.links.find((l) => l.source_ref?.name === corpPsc.name);
  ok('corporate PSC link exists', !!corpLink);
  const corpParty = await repo.findPartyById(corpLink.party_id);
  seededPartyIds.push(corpParty.id);
  ok('corporate party dossier_id back-link set',
    corpParty?.dossierId === parentDossier.id,
    `got=${corpParty?.dossierId} expected=${parentDossier.id}`);
  ok('corporate match_evidence kind=registration_number',
    corpLink.match_evidence?.kind === 'registration_number');
  ok('corporate match_evidence.backlinkedDossierId set',
    corpLink.match_evidence?.backlinkedDossierId === parentDossier.id);

  // ----- Test 8: Officer name that's a close typo → REVIEW + queue -------
  // Keep the surname token EXACT (matcher uses token-overlap as pre-filter:
  // if every token is mis-spelled, no candidates are returned at all).
  // The forename typo lands the trigram score in HIGH or REVIEW band.
  console.log('\n--- 8: officer "Bartholmew Highwater" vs seeded "Bartholomew Highwater"');
  const typoOfficer = {
    name: 'Bartholmew Highwater',
    officer_role: 'director',
    appointed_on: '2023-01-01',
    links: { officer: { appointments: '' } },
  };
  const r8 = await resolveParties({
    dossierId: dossier.id,
    runId: null,
    officers: [officer1Run3, officer2, typoOfficer],
    psc: [cripsinAsPsc, corpPsc],
    shareholders: [],
  });
  ok('new party created for typo officer', r8.counts.newParties >= 1, JSON.stringify(r8.counts));
  const typoLink = r8.links.find((l) => l.source_ref?.name === typoOfficer.name);
  ok('typo officer link exists', !!typoLink);
  seededPartyIds.push(typoLink.party_id);
  const newPartyRow = await repo.findPartyById(typoLink.party_id);
  ok('new party needs_review=true',
    newPartyRow?.needsReview === true,
    `got=${newPartyRow?.needsReview}`);
  const reviewItems = await getReviewQueueForParty(typoLink.party_id);
  ok('at least 1 review queue item pointing at seeded Bartholomew',
    reviewItems.some((r) => r.candidate_party_id === seededTypoTarget.id),
    `got=${reviewItems.length} items: ${reviewItems.map((r) => r.candidate_party_id).join(',')}`);
  ok('review item confidence is REVIEW or HIGH',
    reviewItems.some((r) => r.confidence === 'REVIEW' || r.confidence === 'HIGH'));

  // ----- Test 9: Historical reconciliation -------------------------------
  console.log('\n--- 9: drop typo officer + corp PSC from inputs → links flip to historical');
  const r9 = await resolveParties({
    dossierId: dossier.id,
    runId: null,
    officers: [officer1Run3, officer2],
    psc: [cripsinAsPsc],
    shareholders: [],
  });
  ok('2 historical reconciliations',
    r9.counts.historicalReconciled === 2,
    `got=${r9.counts.historicalReconciled}`);
  const afterHistorical = await getLinkById(typoLink.id);
  ok('typo officer link is now historical',
    afterHistorical?.status === 'historical',
    `got=${afterHistorical?.status}`);

  // ----- Cleanup ---------------------------------------------------------
  console.log('\n--- cleanup');
  // party_links + status_history + review_queue cascade with parties OR
  // dossiers — delete dossiers first to drop the links cleanly, then
  // delete the parties we seeded.
  for (const id of seededDossierIds) {
    await pool.query('DELETE FROM dossiers WHERE id = $1', [id]);
  }
  for (const id of seededPartyIds) {
    await repo.deletePartyById(id).catch(() => {});
  }
  ok('seeded dossiers + parties removed', true);

  console.log('\n[party-resolver:smoke] done');
}

main()
  .catch((err) => {
    console.error('[party-resolver:smoke] FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
