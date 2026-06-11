#!/usr/bin/env node
// M3 smoke: exercise evaluate_sanctions_hits with a stubbed LLM. We replace
// services/llm.extractStructured in require.cache before loading the node,
// so the test is offline-fast (<1s) and deterministic. Real M2 fixture gets
// us realistic hits; the LLM contract is what we're verifying here.
//
// Asserts:
//  - one parent fragment (parentFragmentId == null) on the eval node, kind=decision
//  - N child fragments (parentFragmentId === parent.id), one per hit
//  - failure path: a hit that triggers a stub error becomes a `failed` child,
//    siblings still complete, parent stays `ok`
//  - screeningEvaluations array length matches successful hits
//  - state.fragments is in parent-then-children order (FK insert order)

require('dotenv').config();

const path = require('path');

// Stub services/llm BEFORE the eval node loads. Resolve through node's
// resolver so the cache key matches the require() call inside the node.
const llmPath = require.resolve('../services/llm');
const realLlm = require(llmPath);
const stubLlm = {
  ...realLlm,
  // The stub: read the input JSON, fail if subject.name === 'BOOM_SUBJECT',
  // else return a confirmed verdict for entries containing 'PUTIN', a
  // dismissed verdict otherwise.
  async extractStructured(input /* , schema, prompt */) {
    const parsed = JSON.parse(input);
    if (parsed.subject?.name === 'BOOM_SUBJECT') {
      throw new Error('stub: forced LLM failure');
    }
    const isPutin = /PUTIN/i.test(parsed.entry?.primaryName || '');
    return {
      decision: isPutin ? 'confirmed' : 'dismissed',
      llmScore: isPutin ? 0.95 : 0.4,
      reasoning: isPutin
        ? 'Name and DOB year align with the listed entry.'
        : 'Name overlap appears coincidental; no corroborating identifiers.',
      matchedFields: isPutin ? ['name', 'dob'] : ['name'],
      conflictingFields: isPutin ? [] : ['dob'],
    };
  },
};
require.cache[llmPath] = { ...require.cache[llmPath], exports: stubLlm };

const { compileScreeningList } = require('../graph/nodes/screening/compileScreeningList');
const { screenSanctions } = require('../graph/nodes/screening/screenSanctions');
const { evaluateSanctionsHits } = require('../graph/nodes/screening/evaluateSanctionsHits');
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
    ],
  },
  psc: {
    items: [
      { name: 'PUTIN VLADIMIR', kind: 'individual-person-with-significant-control' },
    ],
  },
  kycCard: {
    identity: { name: 'TEST FIXTURE LTD', companyNumber: '00000001' },
    shareholders: [{ name: 'Vladimir Putin', type: 'individual' }],
  },
};

async function main() {
  console.log('[m3-smoke] running asserts');

  // Build subjects + hits exactly as M2 does.
  const compiled = await compileScreeningList(STATE);
  const subjects = compiled.screeningSubjects || [];
  const screened = await screenSanctions({ ...STATE, screeningSubjects: subjects });
  const hits = screened.screeningHits || [];
  console.log(`  fixture: ${subjects.length} subjects → ${hits.length} hits`);
  assert(hits.length > 0, 'M2 produced at least one hit to evaluate');

  // Sanity check: every hit must carry a hitId (used as PK in screening_hits
  // and FK target in screening_evaluations).
  assert(
    hits.every((h) => typeof h.hitId === 'string' && h.hitId.length === 36),
    'every hit has a UUID hitId',
  );

  // Happy path
  const evalState = {
    ...STATE,
    screeningSubjects: subjects,
    screeningHits: hits,
  };
  const evaluated = await evaluateSanctionsHits(evalState);
  const fragments = evaluated.fragments || [];
  const evaluations = evaluated.screeningEvaluations || [];

  console.log(`  fragments: ${fragments.length}, evaluations: ${evaluations.length}`);

  const parents = fragments.filter((f) => !f.parentFragmentId);
  const children = fragments.filter((f) => f.parentFragmentId);

  assert(parents.length === 1, `exactly one parent fragment (got ${parents.length})`);
  assert(parents[0]?.kind === 'decision', 'parent fragment kind = decision');
  assert(parents[0]?.nodeId === 'evaluate_sanctions_hits', 'parent fragment nodeId set');
  assert(children.length === hits.length, `one child fragment per hit (${children.length}/${hits.length})`);
  assert(
    children.every((c) => c.parentFragmentId === parents[0]?.id),
    'every child references the parent id',
  );
  assert(
    children.every((c) => c.kind === 'decision'),
    'all children are decision fragments',
  );

  // Insert order matters for FK — parent must come first in the array so the
  // SSE persistence loop writes it before any child.
  assert(fragments[0]?.id === parents[0]?.id, 'parent fragment is at index 0');

  // Stub returns 'confirmed' for any Putin entry, 'dismissed' otherwise.
  // All real hits in the M2 fixture are Putin matches, so we expect all confirmed.
  assert(
    evaluations.length === hits.length,
    `evaluations length matches hit count (${evaluations.length}/${hits.length})`,
  );
  assert(
    evaluations.every((e) => e.decision === 'confirmed'),
    'all stub evaluations confirmed (Putin matches)',
  );
  assert(
    evaluations.every((e) => typeof e.fragmentId === 'string'),
    'every evaluation carries a fragmentId',
  );
  assert(
    evaluations.every((e) => children.some((c) => c.id === e.fragmentId)),
    'every evaluation.fragmentId points at an emitted child fragment',
  );

  // Failure-isolation path: inject a hit whose subject name triggers the stub error.
  const boomHit = {
    ...hits[0],
    hitId: '00000000-0000-4000-8000-00000000beef',
    subjectId: 'profile:BOOM_SUBJECT',
    subjectName: 'BOOM_SUBJECT',
  };
  const boomState = {
    ...evalState,
    screeningSubjects: [
      ...subjects,
      { id: 'profile:BOOM_SUBJECT', name: 'BOOM_SUBJECT', normalizedName: 'BOOM SUBJECT', kind: 'company', source: 'profile' },
    ],
    screeningHits: [boomHit, ...hits],
  };
  const boomEvaluated = await evaluateSanctionsHits(boomState);
  const boomFragments = boomEvaluated.fragments || [];
  const boomChildren = boomFragments.filter((f) => f.parentFragmentId);
  const failed = boomChildren.filter((c) => c.status === 'failed');
  const ok = boomChildren.filter((c) => c.status === 'ok');

  assert(failed.length === 1, `one failed child fragment (got ${failed.length})`);
  assert(ok.length === hits.length, `siblings still completed (${ok.length}/${hits.length})`);
  assert(
    boomFragments.find((f) => !f.parentFragmentId)?.status === 'ok',
    'parent fragment stays ok even when one child fails',
  );
  assert(
    boomEvaluated.screeningEvaluations.length === hits.length,
    'failed hit produces no evaluation row',
  );

  // Empty-input path: no hits → skipped fragment, no children, no evaluations.
  const emptyEvaluated = await evaluateSanctionsHits({
    ...STATE,
    screeningSubjects: subjects,
    screeningHits: [],
  });
  const emptyFrags = emptyEvaluated.fragments || [];
  assert(emptyFrags.length === 1, 'empty input produces a single fragment');
  assert(emptyFrags[0]?.status === 'skipped', 'empty input fragment status = skipped');
  assert(
    !emptyEvaluated.screeningEvaluations || emptyEvaluated.screeningEvaluations.length === 0,
    'empty input emits no evaluations',
  );

  console.log(`[m3-smoke] ${failures === 0 ? 'all assertions passed' : `${failures} FAILED`}`);
  if (failures) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('[m3-smoke] crashed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
