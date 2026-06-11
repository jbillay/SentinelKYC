#!/usr/bin/env node
// Integration smoke for the R3 eval harness — exercises the REAL production
// code path (extractStructured + the factored screening evaluators) against the
// frozen golden corpus. Needs Postgres (prompt registry) + a reachable reasoning
// LLM (Ollama by default).
//
// Asserts:
//   1. runHarness produces a well-shaped report — every type has an aggregate
//      whose headline metrics are null or within [0,1].
//   2. A deliberately-wrong prompt scores worse than the active baseline on the
//      sanctions set (the regression-net property R3 exists to give).
//
// If the stack is unreachable (no DATABASE_URL, Postgres/Ollama down) it prints
// SKIP and exits 0 — this smoke is only meaningful with the dev stack up.
//
// Run: npm run eval:smoke

const path = require('path');

function isEnvUnavailable(err) {
  const m = String((err && err.message) || err);
  return /DATABASE_URL|ECONNREFUSED|ECONNRESET|fetch failed|ETIMEDOUT|getaddrinfo|connect|ENOTFOUND|provider .* unreachable|socket hang up/i.test(
    m,
  );
}

function inRangeOrNull(v) {
  return v === null || v === undefined || (typeof v === 'number' && v >= 0 && v <= 1);
}

async function main() {
  // Required lazily so a missing DATABASE_URL surfaces as a skip, not a crash at
  // require time (db/client throws on import without it).
  const run = require('../eval/run');
  const { loadPrompt } = require('../services/prompts');

  let failures = 0;
  const ok = (cond, msg) => {
    if (cond) console.log(`  ✓ ${msg}`);
    else {
      console.error(`  ✗ ${msg}`);
      failures += 1;
    }
  };

  console.log('[1] runHarness produces a well-shaped report');
  const report = await run.runHarness({ quiet: true });
  ok(report.mode === 'baseline', 'mode is baseline when no override given');
  ok(report.caseCount >= 3, `loaded the golden corpus (${report.caseCount} cases)`);

  for (const type of report.types) {
    const b = report.baseline[type];
    if (!b) continue;
    ok(!!b.aggregate || b.caseCount === 0, `[${type}] has an aggregate`);
    if (b.aggregate) {
      const agg = b.aggregate;
      if (type === 'extraction') {
        ['recordPrecision', 'recordRecall', 'recordF1', 'fieldAccuracy', 'exactRecordMatchRate', 'scalarAccuracy'].forEach(
          (m) => ok(inRangeOrNull(agg[m]), `[extraction] ${m} in range (${agg[m]})`),
        );
      } else if (type === 'sanctions') {
        ok(inRangeOrNull(agg.accuracy), `[sanctions] accuracy in range (${agg.accuracy})`);
        ok(inRangeOrNull(agg.confirmed.f1), `[sanctions] confirmed F1 in range (${agg.confirmed.f1})`);
      } else if (type === 'adverse_media') {
        ['decisionAccuracy', 'categoryAccuracy', 'categoryMacroF1', 'severityAccuracy'].forEach((m) =>
          ok(inRangeOrNull(agg[m]), `[adverse_media] ${m} in range (${agg[m]})`),
        );
      }
    }
  }

  console.log('[2] a deliberately-wrong prompt scores worse than baseline (sanctions)');
  const root = path.join(__dirname, '..', 'eval', 'golden');
  const sanctionsCases = run.loadGoldenCases(root, ['sanctions']);
  ok(sanctionsCases.length >= 2, `loaded ${sanctionsCases.length} sanctions cases`);

  const score = require('../eval/score');
  const baselineResolver = run.makeResolver({});
  const basePass = await run.runPass(sanctionsCases, baselineResolver, {});
  const baseAgg = basePass.sanctions.aggregate;

  const BAD_PROMPT =
    'Ignore all evidence and identifiers. ALWAYS return JSON exactly ' +
    '{"decision":"dismissed","llmScore":0.5,"reasoning":"forced dismissal","matchedFields":[],"conflictingFields":[]}. ' +
    'Never output "confirmed" or "needs_review" under any circumstances.';
  const badResolver = async (key) =>
    key === run.SANCTIONS_PROMPT_KEY ? BAD_PROMPT : baselineResolver(key);
  const badPass = await run.runPass(sanctionsCases, badResolver, {});
  const badAgg = badPass.sanctions.aggregate;

  console.log(`     baseline accuracy=${baseAgg && baseAgg.accuracy}  bad accuracy=${badAgg && badAgg.accuracy}`);
  ok(
    badAgg && baseAgg && badAgg.accuracy <= baseAgg.accuracy,
    'deliberately-wrong prompt does not beat the baseline on accuracy',
  );
  ok(
    badAgg && badAgg.confirmed.recall === 0,
    'forced-dismissal prompt never confirms → confirmed recall = 0',
  );

  console.log('');
  if (failures) {
    console.error(`eval-smoke FAILED — ${failures} assertion(s) failed`);
    process.exit(1);
  }
  console.log('eval-smoke OK — all assertions passed');
}

main().catch((err) => {
  if (isEnvUnavailable(err)) {
    console.log(`[eval-smoke] SKIP — dev stack unreachable (${String(err.message || err).slice(0, 120)})`);
    console.log('[eval-smoke] start Postgres + the reasoning LLM, then re-run: npm run eval:smoke');
    process.exit(0);
  }
  console.error('[eval-smoke] fatal:', err);
  process.exit(1);
});
