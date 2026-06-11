// Phase 5 — Cross-dossier graph smoke.
//
// Seeds a "hub" party that appears on two different dossiers, plus a
// distinct "peripheral" party on each dossier. Asserts that
// buildPartyGraph from the hub at depth=2 returns:
//   * the hub (centre)
//   * both dossiers
//   * both peripheral parties
//   * correctly-typed edges
//
// Also checks the depth=1 cut (peripherals NOT included) and the
// truncation flag when limit is set below the natural node count.

const { randomUUID: uuid } = require('crypto');
const { pool } = require('../db/client');
const repo = require('../db/repo');
const { buildPartyGraph } = require('../services/party/graph');

function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

async function defensiveCleanup() {
  await pool.query("DELETE FROM dossiers WHERE company_number LIKE 'PGRAPH-SMOKE-%'");
  await pool.query(
    `DELETE FROM parties WHERE name_canonical IN (
       name_canonical('Hubert Centerton'),
       name_canonical('Alex Peripheral'),
       name_canonical('Brenda Peripheral')
     )`,
  );
}

async function main() {
  console.log('[party-graph:smoke] running');
  await defensiveCleanup();

  // ----- Setup ---------------------------------------------------------
  const dossierA = await repo.upsertDossier({
    companyNumber: `PGRAPH-SMOKE-A-${Date.now()}`,
    companyName: 'Graph Smoke A Ltd',
  });
  const dossierB = await repo.upsertDossier({
    companyNumber: `PGRAPH-SMOKE-B-${Date.now()}`,
    companyName: 'Graph Smoke B Ltd',
  });
  const runA = await repo.createRun({
    dossierId: dossierA.id,
    threadId: `pgraph-A-${Date.now()}`,
    trigger: 'initial',
  });
  const runB = await repo.createRun({
    dossierId: dossierB.id,
    threadId: `pgraph-B-${Date.now()}`,
    trigger: 'initial',
  });

  const hub = await repo.insertNewParty({
    partyType: 'individual',
    fullName: 'Hubert Centerton',
    sourceKind: 'manual',
  });
  const peripheralA = await repo.insertNewParty({
    partyType: 'individual',
    fullName: 'Alex Peripheral',
    sourceKind: 'manual',
  });
  const peripheralB = await repo.insertNewParty({
    partyType: 'individual',
    fullName: 'Brenda Peripheral',
    sourceKind: 'manual',
  });

  // Hub appears as officer on both dossiers; peripherals appear as PSC on
  // their own dossier only.
  await repo.upsertPartyLink({
    partyId: hub.id,
    dossierId: dossierA.id,
    role: 'officer',
    roleDetail: 'director',
    status: 'active',
    appointedOn: '2023-01-01',
    runId: runA.id,
    matchConfidence: 1.0,
    matchEvidence: { kind: 'manual' },
  });
  await repo.upsertPartyLink({
    partyId: hub.id,
    dossierId: dossierB.id,
    role: 'officer',
    roleDetail: 'director',
    status: 'active',
    appointedOn: '2023-02-01',
    runId: runB.id,
    matchConfidence: 1.0,
    matchEvidence: { kind: 'manual' },
  });
  await repo.upsertPartyLink({
    partyId: peripheralA.id,
    dossierId: dossierA.id,
    role: 'psc',
    status: 'active',
    notifiedOn: '2023-01-15',
    runId: runA.id,
    matchConfidence: 1.0,
    matchEvidence: { kind: 'manual' },
  });
  await repo.upsertPartyLink({
    partyId: peripheralB.id,
    dossierId: dossierB.id,
    role: 'psc',
    status: 'active',
    notifiedOn: '2023-02-15',
    runId: runB.id,
    matchConfidence: 1.0,
    matchEvidence: { kind: 'manual' },
  });

  // ----- Test 1: depth=2 returns the full neighbourhood ---------------
  console.log('\n--- 1: depth=2 from hub returns centre + 2 dossiers + 2 peripherals');
  const g2 = await buildPartyGraph(hub.id, { depth: 2 });
  ok('5 nodes total', g2.nodes.length === 5, `got=${g2.nodes.length}`);
  ok('2 dossier nodes', g2.counts.dossiers === 2, `got=${g2.counts.dossiers}`);
  ok('3 party nodes (hub + 2 peripherals)', g2.counts.parties === 3, `got=${g2.counts.parties}`);
  ok('centre flag set on hub',
    g2.nodes.find((n) => n.data.id === `party:${hub.id}`)?.data?.isCenter === true);
  ok('4 edges (hub→A, hub→B, perA→A, perB→B)',
    g2.edges.length === 4, `got=${g2.edges.length}`);

  const edgeShapes = g2.edges.map((e) => `${e.data.source.slice(0, 6)}→${e.data.target.slice(0, 8)}`);
  ok('hub has edges to both dossiers',
    g2.edges.filter((e) => e.data.source === `party:${hub.id}`).length === 2,
    JSON.stringify(edgeShapes));

  // ----- Test 2: depth=1 omits peripherals ----------------------------
  console.log('\n--- 2: depth=1 from hub omits peripheral parties');
  const g1 = await buildPartyGraph(hub.id, { depth: 1 });
  ok('3 nodes (hub + 2 dossiers)', g1.nodes.length === 3, `got=${g1.nodes.length}`);
  ok('no party nodes beyond hub',
    g1.counts.parties === 1, `got=${g1.counts.parties}`);
  ok('2 edges (hub→A, hub→B)', g1.edges.length === 2, `got=${g1.edges.length}`);

  // ----- Test 3: limit truncation flagged -----------------------------
  console.log('\n--- 3: limit=2 truncates the neighbourhood');
  const gT = await buildPartyGraph(hub.id, { depth: 2, limit: 2 });
  ok('exactly 2 nodes returned', gT.nodes.length === 2, `got=${gT.nodes.length}`);
  ok('truncated flag set', gT.counts.truncated === true);

  // ----- Test 4: centre-party linked_dossier_count populated ----------
  console.log('\n--- 4: centre node linked_dossier_count');
  const centre = g2.nodes.find((n) => n.data.id === `party:${hub.id}`);
  ok('hub linkedDossierCount === 2',
    centre.data.linkedDossierCount === 2,
    `got=${centre.data.linkedDossierCount}`);
  const perANode = g2.nodes.find((n) => n.data.id === `party:${peripheralA.id}`);
  ok('peripheral linkedDossierCount === 1',
    perANode.data.linkedDossierCount === 1,
    `got=${perANode.data.linkedDossierCount}`);

  // ----- Test 5: not_found ---------------------------------------------
  console.log('\n--- 5: missing party id → GraphBuildError');
  let threw = false;
  try {
    await buildPartyGraph(uuid());
  } catch (err) {
    threw = err.code === 'not_found';
  }
  ok('threw not_found', threw);

  // ----- Cleanup -------------------------------------------------------
  console.log('\n--- cleanup');
  await pool.query('DELETE FROM dossiers WHERE id IN ($1, $2)', [dossierA.id, dossierB.id]);
  await repo.deletePartyById(hub.id).catch(() => {});
  await repo.deletePartyById(peripheralA.id).catch(() => {});
  await repo.deletePartyById(peripheralB.id).catch(() => {});
  ok('cleanup completed', true);

  console.log('\n[party-graph:smoke] done');
}

main()
  .catch((err) => {
    console.error('[party-graph:smoke] FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
