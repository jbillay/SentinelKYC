// Phase 2 — graph-integrated resolver smoke.
//
// Exercises the resolve_parties node + downstream compile_screening_list +
// screen_sanctions hit shape, in a state-in / state-out way (no CH API
// calls, no LLM, no OCR — we'd be testing the whole graph then). Asserts:
//
//   1. resolve_parties populates state.parties + state.partyLinks
//   2. resolve_parties rewrites shareholderGraph node IDs to `party:<uuid>`
//   3. compile_screening_list emits subjects with subjectId='party:<uuid>'
//      and partyId set
//   4. screen_sanctions hit objects carry partyId
//   5. SSE persistence path lands the partyId in screening_hits.party_id
//      (we don't run SSE here, just call appendScreeningHit directly with
//      the hit shape we'd produce)

const { randomUUID: uuid } = require('crypto');
const { pool } = require('../db/client');
const repo = require('../db/repo');
const { resolveParties: resolvePartiesNode } = require('../graph/nodes/resolveParties');
const { compileScreeningList } = require('../graph/nodes/screening/compileScreeningList');

function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

// Synth state matching what synthesize_card would produce by the time
// resolve_parties fires.
function buildFixtureState() {
  return {
    companyNumber: `GRAPH-SMOKE-${Date.now()}`,
    profile: {
      company_name: 'Graph Smoke Co Ltd',
      company_number: `GRAPH-SMOKE-${Date.now()}`,
    },
    officers: {
      items: [
        {
          name: 'TestOfficer, Imogene',
          officer_role: 'director',
          appointed_on: '2022-01-10',
          nationality: 'British',
          country_of_residence: 'England',
          date_of_birth: { year: 1975, month: 8 },
          links: { officer: { appointments: '/officers/appt_imogene_001/appointments' } },
        },
      ],
    },
    psc: {
      items: [
        {
          name: 'TestOfficer Imogene',
          kind: 'individual-person-with-significant-control',
          notified_on: '2022-02-01',
          natures_of_control: ['ownership-of-shares-25-to-50-percent'],
          nationality: 'British',
          date_of_birth: { year: 1975, month: 8 },
        },
      ],
    },
    filingHistory: null,
    documents: [],
    kycCard: {
      identity: { name: 'Graph Smoke Co Ltd', companyNumber: `GRAPH-SMOKE-${Date.now()}` },
      officers: [{ name: 'TestOfficer, Imogene', role: 'director', appointedOn: '2022-01-10' }],
      psc: [{ name: 'TestOfficer Imogene', kind: 'individual-person-with-significant-control' }],
      shareholders: [],
      documents: [],
      redFlags: [],
      sourceTrace: {},
    },
    // Pre-built shareholderGraph as synthesize_card would emit it (using
    // legacy normalized-name node IDs).
    shareholderGraph: {
      nodes: [
        { data: { id: 'co:GRAPH-SMOKE', label: 'Graph Smoke Co Ltd', kind: 'company' } },
        { data: { id: 'p:TESTOFFICER IMOGENE', label: 'TestOfficer Imogene', kind: 'individual' } },
        { data: { id: 'o:TESTOFFICER, IMOGENE', label: 'TestOfficer, Imogene', kind: 'individual' } },
      ],
      edges: [
        { data: { id: 'e0', source: 'p:TESTOFFICER IMOGENE', target: 'co:GRAPH-SMOKE', rel: 'owns' } },
        { data: { id: 'e1', source: 'o:TESTOFFICER, IMOGENE', target: 'co:GRAPH-SMOKE', rel: 'officer' } },
      ],
    },
    fragments: [],
    trace: [],
    errors: [],
    parties: [],
    partyLinks: [],
    screeningSubjects: [],
    screeningHits: [],
    screeningEvaluations: [],
  };
}

async function defensiveCleanup() {
  await pool.query("DELETE FROM dossiers WHERE company_number LIKE 'GRAPH-SMOKE-%'");
  await pool.query(
    `DELETE FROM parties WHERE name_canonical IN (
       name_canonical('TestOfficer Imogene')
     )`,
  );
}

async function main() {
  console.log('[graph-resolver:smoke] running');
  await defensiveCleanup();

  // ----- Setup -----------------------------------------------------------
  const dossier = await repo.upsertDossier({
    companyNumber: `GRAPH-SMOKE-${Date.now()}`,
    companyName: 'Graph Smoke Co Ltd',
  });
  const runId = uuid();
  // The graph passes dossierId/runId via config.configurable.
  const graphConfig = {
    configurable: { dossierId: dossier.id, runId: null },
  };

  // ----- Test 1: resolve_parties produces state.parties + partyLinks -----
  console.log('\n--- 1: resolve_parties node, fixture state-in');
  const state = buildFixtureState();
  state.profile.company_number = dossier.companyNumber;
  state.kycCard.identity.companyNumber = dossier.companyNumber;
  state.companyNumber = dossier.companyNumber;

  const r1 = await resolvePartiesNode(state, graphConfig);

  ok('state.parties populated', Array.isArray(r1.parties) && r1.parties.length === 1,
    `got=${r1.parties?.length}`);
  ok('state.partyLinks populated', Array.isArray(r1.partyLinks) && r1.partyLinks.length === 2,
    `got=${r1.partyLinks?.length} (expect 2 — officer + psc on same party)`);
  ok('decision fragment emitted',
    Array.isArray(r1.fragments) && r1.fragments.some((f) => f.nodeId === 'resolve_parties'),
    `nodeIds=${r1.fragments?.map((f) => f.nodeId).join(',')}`);
  const partyId = r1.parties[0].id;

  // ----- Test 2: shareholderGraph rewritten to use party:<uuid> ----------
  console.log('\n--- 2: shareholderGraph node IDs rewritten');
  const graph = r1.shareholderGraph;
  ok('shareholderGraph present in output', !!graph);
  const expectedId = `party:${partyId}`;
  // The rewrite collapses same-canonical duplicates (officer + PSC surface
  // forms of the same human) into ONE party node — exactly one person node
  // must survive, carrying the party:<uuid> id.
  const personNodes = graph.nodes.filter((n) => n.data.kind !== 'company');
  ok('officer+psc collapsed into a single party node',
    personNodes.length === 1,
    `got=${personNodes.length} labels=${personNodes.map((n) => n.data.label).join('|')}`);
  ok('person node remapped to party:<uuid>',
    personNodes[0]?.data?.id === expectedId,
    `got=${personNodes[0]?.data?.id} expected=${expectedId}`);
  ok('company node unchanged',
    graph.nodes.find((n) => n.data.kind === 'company')?.data?.id?.startsWith('co:'),
    'company node id kept legacy co:* prefix');

  // ----- Test 3: compile_screening_list emits party-keyed subjects -------
  console.log('\n--- 3: compile_screening_list builds party-keyed subjects');
  // Merge the resolver's outputs back into state.
  const stateAfterResolver = {
    ...state,
    parties: r1.parties,
    partyLinks: r1.partyLinks,
    shareholderGraph: r1.shareholderGraph,
  };
  const r3 = await compileScreeningList(stateAfterResolver, graphConfig);
  const subjects = r3.screeningSubjects || [];
  ok('subjects emitted', subjects.length >= 2,
    `got=${subjects.length} (company + 1 party = 2 at minimum)`);
  const companySubject = subjects.find((s) => s.kind === 'company');
  const partySubjects = subjects.filter((s) => s.kind !== 'company');
  ok('company subject present', !!companySubject);
  ok('party subjects use party:<uuid> ids',
    partySubjects.every((s) => s.id.startsWith('party:')),
    `ids=${partySubjects.map((s) => s.id).join(',')}`);
  ok('party subjects have partyId set',
    partySubjects.every((s) => s.partyId === partyId),
    `partyIds=${partySubjects.map((s) => s.partyId).join(',')}`);
  ok('two distinct subject sources (officer + psc on same party)',
    new Set(partySubjects.map((s) => s.source)).size === 2,
    `sources=${partySubjects.map((s) => s.source).join(',')}`);
  ok('compile fragment summary mentions party-keyed',
    (r3.fragments || []).some((f) => /party-keyed/.test(f.summary || '')),
    `summaries=${(r3.fragments || []).map((f) => f.summary).join(' | ')}`);

  // ----- Test 4: hit shape — synthesise a hit as screen_sanctions would --
  console.log('\n--- 4: screening_hits.party_id round-trip');
  // Create a fake run so the hit FK is valid.
  const run = await repo.createRun({
    dossierId: dossier.id,
    threadId: `graph-smoke-${Date.now()}`,
    trigger: 'initial',
  });
  const officerSubject = partySubjects.find((s) => s.source === 'officer');
  const hit = await repo.appendScreeningHit({
    runId: run.id,
    partyId: officerSubject.partyId,
    subjectId: officerSubject.id,
    subjectName: officerSubject.name,
    subjectKind: officerSubject.kind,
    subjectSource: officerSubject.source,
    listSource: 'ofac_sdn',
    listEntryId: 'GRAPH-SMOKE-FAKE-ENTRY',
    matchScore: 0.92,
    rawEntry: { primaryName: 'Test entry' },
  });
  ok('screening_hit row inserted', !!hit?.id, `id=${hit?.id}`);
  ok('screening_hit.party_id persisted',
    hit?.partyId === officerSubject.partyId,
    `got=${hit?.partyId}`);

  // ----- Cleanup ---------------------------------------------------------
  console.log('\n--- cleanup');
  await pool.query('DELETE FROM dossiers WHERE id = $1', [dossier.id]);
  await repo.deletePartyById(partyId).catch(() => {});
  ok('cleanup completed', true);

  console.log('\n[graph-resolver:smoke] done');
}

main()
  .catch((err) => {
    console.error('[graph-resolver:smoke] FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
