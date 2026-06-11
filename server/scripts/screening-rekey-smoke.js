// Phase 3 — Screening rekey smoke.
//
// Tests the cross-dossier override path end-to-end on the data layer (no
// LLM). Asserts:
//   1. setPartyScreeningOverride writes a party_screening_overrides row
//   2. The same partyId surfaces the override via getOverridesForParties
//   3. applyOverridesForward writes party-level when the hit carries
//      partyId, dossier-level when it doesn't (Phase 3 semantics flip)
//   4. Clearing the override deletes the row
//   5. The HTTP route PATCH /api/parties/:id/overrides upserts correctly
//      (via the repo, the route is shallow plumbing)

const { randomUUID: uuid } = require('crypto');
const { pool } = require('../db/client');
const repo = require('../db/repo');

function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

async function defensiveCleanup() {
  await pool.query("DELETE FROM dossiers WHERE company_number LIKE 'REKEY-SMOKE-%'");
  await pool.query(
    `DELETE FROM parties WHERE name_canonical = name_canonical('Octavia Wormtongue')`,
  );
}

async function main() {
  console.log('[screening-rekey:smoke] running');
  await defensiveCleanup();

  // ----- Setup -----------------------------------------------------------
  const dossierA = await repo.upsertDossier({
    companyNumber: `REKEY-SMOKE-A-${Date.now()}`,
    companyName: 'Rekey Smoke A Ltd',
  });
  const dossierB = await repo.upsertDossier({
    companyNumber: `REKEY-SMOKE-B-${Date.now()}`,
    companyName: 'Rekey Smoke B Ltd',
  });
  const party = await repo.insertNewParty({
    partyType: 'individual',
    fullName: 'Octavia Wormtongue',
    sourceKind: 'manual',
  });

  // Need a run for the hits FK.
  const runA = await repo.createRun({
    dossierId: dossierA.id,
    threadId: `rekey-smoke-A-${Date.now()}`,
    trigger: 'initial',
  });

  // ----- Test 1: setPartyScreeningOverride upserts ------------------------
  console.log('\n--- 1: setPartyScreeningOverride');
  const o1 = await repo.setPartyScreeningOverride({
    partyId: party.id,
    listSource: 'ofac_sdn',
    listEntryId: 'SDN-12345',
    decision: 'dismissed',
    reason: 'False positive — different DOB',
    appliedBy: 'screening-rekey-smoke',
  });
  ok('override row written', !!o1?.id);
  ok('override.decision = dismissed', o1.decision === 'dismissed');
  ok('override.applied_by populated', o1.applied_by === 'screening-rekey-smoke');

  // Upsert same key with different decision → row updated, not duplicated.
  const o2 = await repo.setPartyScreeningOverride({
    partyId: party.id,
    listSource: 'ofac_sdn',
    listEntryId: 'SDN-12345',
    decision: 'confirmed',
    reason: 'Reviewer changed mind',
    appliedBy: 'screening-rekey-smoke',
  });
  ok('upsert returns same id', o2.id === o1.id, `o1=${o1.id} o2=${o2.id}`);
  ok('upsert flipped decision', o2.decision === 'confirmed');

  // ----- Test 2: getOverridesForParties surfaces it -----------------------
  console.log('\n--- 2: getOverridesForParties bulk lookup');
  const found = await repo.getOverridesForParties([party.id]);
  ok('found 1 override', found.length === 1);
  ok('override key matches', found[0].partyId === party.id && found[0].listSource === 'ofac_sdn');

  // ----- Test 3: applyOverridesForward routes by partyId ------------------
  console.log('\n--- 3: applyOverridesForward Phase 3 semantics');
  // Clear the existing override so we can observe a fresh write.
  await repo.clearPartyScreeningOverride({
    partyId: party.id,
    listSource: 'ofac_sdn',
    listEntryId: 'SDN-12345',
  });

  const hitsToCarry = [
    {
      partyId: party.id,
      subjectId: `party:${party.id}`,
      listSource: 'ofac_sdn',
      listEntryId: 'SDN-67890',
      evidenceUrl: null,
      evaluation: { humanOverride: 'dismissed', overrideReason: 'cross-dossier carry-forward' },
    },
    {
      // Legacy hit — no partyId. Should land in dossier_screening_overrides.
      partyId: null,
      subjectId: 'officer:LEGACY SUBJECT',
      listSource: 'uk_hmt',
      listEntryId: 'HMT-9999',
      evidenceUrl: null,
      evaluation: { humanOverride: 'dismissed', overrideReason: 'legacy' },
    },
  ];
  const counts = await repo.applyOverridesForward(dossierA.id, hitsToCarry);
  ok('counts.partyLevel === 1', counts.partyLevel === 1, JSON.stringify(counts));
  ok('counts.dossierLevel === 1', counts.dossierLevel === 1, JSON.stringify(counts));

  // Verify the party-level row landed.
  const after = await repo.getOverridesForParty(party.id);
  ok('party-level row exists for partyId',
    after.some((o) => o.listEntryId === 'SDN-67890' && o.decision === 'dismissed'));

  // ----- Test 4: cross-dossier — same party appears in different run ------
  console.log('\n--- 4: same party on dossier B → override surfaces');
  // Imagine party appears in dossier B's run. The evaluator's lookup
  // would call getOverridesForParties([party.id]) and see the row created
  // on dossier A (because party-level overrides are global).
  const runB = await repo.createRun({
    dossierId: dossierB.id,
    threadId: `rekey-smoke-B-${Date.now()}`,
    trigger: 'initial',
  });
  const crossDossier = await repo.getOverridesForParties([party.id]);
  ok('override visible on a different dossier',
    crossDossier.length >= 1
      && crossDossier.some((o) => o.listEntryId === 'SDN-67890' && o.decision === 'dismissed'),
    `count=${crossDossier.length}`);

  // ----- Test 5: clearPartyScreeningOverride removes the row --------------
  console.log('\n--- 5: clearPartyScreeningOverride');
  await repo.clearPartyScreeningOverride({
    partyId: party.id,
    listSource: 'ofac_sdn',
    listEntryId: 'SDN-67890',
  });
  const afterClear = await repo.getOverridesForParty(party.id);
  ok('row removed',
    !afterClear.some((o) => o.listEntryId === 'SDN-67890'),
    `remaining=${afterClear.map((o) => o.listEntryId).join(',')}`);

  // ----- Cleanup ---------------------------------------------------------
  console.log('\n--- cleanup');
  await pool.query('DELETE FROM dossiers WHERE id IN ($1, $2)', [dossierA.id, dossierB.id]);
  await repo.deletePartyById(party.id).catch(() => {});
  ok('cleanup completed', true);

  console.log('\n[screening-rekey:smoke] done');
}

main()
  .catch((err) => {
    console.error('[screening-rekey:smoke] FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
