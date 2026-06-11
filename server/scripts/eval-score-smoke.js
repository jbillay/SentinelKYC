#!/usr/bin/env node
// Pure smoke for the R3 eval harness — no DB, no LLM, no network. Verifies:
//   1. score.js math (extraction P/R/F1 + field/exact, sanctions confusion +
//      confirmed P/R/F1, adverse-media accuracy + category F1).
//   2. "A deliberately-worse prediction scores lower than a good one" — the
//      core honesty property the harness exists to provide.
//   3. Every committed golden case parses against labels.schema (the gate).
//
// Run: npm run eval:score-smoke   (node-only, always runnable)

const fs = require('fs');
const path = require('path');
const score = require('../eval/score');
const { validateCase, CASE_TYPES } = require('../eval/labels.schema');

let failures = 0;
function ok(cond, msg) {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ ${msg}`);
    failures += 1;
  }
}

console.log('[1] extraction scoring');
{
  const expected = {
    statementDate: '2023-03-14',
    shareholders: [
      { name: 'John A. Smith', type: 'individual', shares: 60, percentage: 60 },
      { name: 'Mary Patel', type: 'individual', shares: 30, percentage: 30 },
    ],
  };
  const scoring = {
    recordSets: [{ field: 'shareholders', key: 'name', fields: ['type', 'shares', 'percentage'] }],
    scalarFields: ['statementDate'],
  };

  const perfect = score.scoreExtractionCase(expected, expected, scoring);
  ok(perfect.recordF1 === 1, 'perfect prediction → record F1 = 1');
  ok(perfect.fieldAccuracy === 1, 'perfect prediction → field accuracy = 1');
  ok(perfect.exactRecordMatchRate === 1, 'perfect prediction → exact-record rate = 1');
  ok(perfect.scalarAccuracy === 1, 'perfect prediction → scalar accuracy = 1');

  // Degraded: drop one shareholder, get one field wrong, miss the scalar.
  const degradedPred = {
    statementDate: '2023-01-01',
    shareholders: [{ name: 'John A. Smith', type: 'individual', shares: 99, percentage: 60 }],
  };
  const degraded = score.scoreExtractionCase(expected, degradedPred, scoring);
  ok(degraded.recordRecall < 1, 'missing record → recall < 1');
  ok(degraded.recordF1 < perfect.recordF1, 'degraded prediction scores lower F1 than perfect');
  ok(degraded.fieldAccuracy < 1, 'wrong field → field accuracy < 1');
  ok(degraded.exactRecordMatchRate < 1, 'wrong field → exact-record rate < 1');
  ok(degraded.scalarAccuracy === 0, 'wrong scalar → scalar accuracy = 0');

  // numeric tolerance: 1250000 vs 1250000.0 should match; commas handled by caller
  const accExp = { turnover: 1250000, netAssets: 750000 };
  const accScoring = { recordSets: [], scalarFields: ['turnover', 'netAssets'] };
  const accPerfect = score.scoreExtractionCase(accExp, { turnover: 1250000, netAssets: 750000 }, accScoring);
  ok(accPerfect.scalarAccuracy === 1, 'numeric scalars compare numerically');
}

console.log('[2] sanctions scoring');
{
  const cases = [
    { expected: { decision: 'confirmed' }, predicted: { decision: 'confirmed' } },
    { expected: { decision: 'dismissed' }, predicted: { decision: 'dismissed' } },
    { expected: { decision: 'needs_review' }, predicted: { decision: 'needs_review' } },
  ];
  const perfectPer = cases.map((c) => ({ id: 'x', metrics: score.scoreSanctionsCase(c.expected, c.predicted) }));
  const perfectAgg = score.aggregateSanctions(perfectPer);
  ok(perfectAgg.accuracy === 1, 'all-correct → accuracy = 1');
  ok(perfectAgg.confirmed.f1 === 1, 'all-correct → confirmed F1 = 1');
  ok(perfectAgg.confusion.confirmed.confirmed === 1, 'confusion matrix counts the confirmed→confirmed cell');

  // Degraded: the confirmed case is predicted dismissed (a false negative on confirmed).
  const degradedCases = [
    { expected: { decision: 'confirmed' }, predicted: { decision: 'dismissed' } },
    { expected: { decision: 'dismissed' }, predicted: { decision: 'dismissed' } },
    { expected: { decision: 'needs_review' }, predicted: { decision: 'needs_review' } },
  ];
  const degPer = degradedCases.map((c) => ({ id: 'x', metrics: score.scoreSanctionsCase(c.expected, c.predicted) }));
  const degAgg = score.aggregateSanctions(degPer);
  ok(degAgg.accuracy < perfectAgg.accuracy, 'missing a confirmed → accuracy drops');
  ok(degAgg.confirmed.recall < 1, 'missed confirmed → confirmed recall < 1');
  ok(degAgg.confirmed.fn === 1, 'missed confirmed → one false negative');

  // unparseable prediction is excluded from `scored`
  const withNull = score.aggregateSanctions([
    { id: 'x', metrics: score.scoreSanctionsCase({ decision: 'confirmed' }, null) },
  ]);
  ok(withNull.scored === 0, 'null prediction is not scored');
}

console.log('[3] adverse-media scoring');
{
  const cases = [
    { expected: { decision: 'confirmed', category: 'fraud', severity: 'high' }, predicted: { decision: 'confirmed', category: 'fraud', severity: 'high' } },
    { expected: { decision: 'dismissed' }, predicted: { decision: 'dismissed' } },
    { expected: { decision: 'needs_review', category: 'financial_crime' }, predicted: { decision: 'needs_review', category: 'financial_crime' } },
  ];
  const per = cases.map((c) => ({ id: 'x', metrics: score.scoreAdverseMediaCase(c.expected, c.predicted) }));
  const agg = score.aggregateAdverseMedia(per);
  ok(agg.decisionAccuracy === 1, 'all-correct → decision accuracy = 1');
  ok(agg.categoryMacroF1 === 1, 'all-correct → category macro-F1 = 1');
  ok(agg.severityAccuracy === 1, 'all-correct → severity accuracy = 1');

  const degCases = [
    { expected: { decision: 'confirmed', category: 'fraud', severity: 'high' }, predicted: { decision: 'dismissed', category: 'other', severity: 'low' } },
    { expected: { decision: 'dismissed' }, predicted: { decision: 'dismissed' } },
    { expected: { decision: 'needs_review', category: 'financial_crime' }, predicted: { decision: 'needs_review', category: 'financial_crime' } },
  ];
  const degPer = degCases.map((c) => ({ id: 'x', metrics: score.scoreAdverseMediaCase(c.expected, c.predicted) }));
  const degAgg = score.aggregateAdverseMedia(degPer);
  ok(degAgg.decisionAccuracy < agg.decisionAccuracy, 'wrong decision → decision accuracy drops');
  ok(degAgg.categoryMacroF1 < agg.categoryMacroF1, 'wrong category → category macro-F1 drops');
}

console.log('[4] golden corpus validates against labels.schema');
{
  const root = path.join(__dirname, '..', 'eval', 'golden');
  const counts = {};
  for (const type of CASE_TYPES) {
    const dir = path.join(root, type);
    counts[type] = 0;
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const obj = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      try {
        const parsed = validateCase(obj);
        ok(parsed.type === type, `${type}/${f} parses and has matching type`);
        counts[type] += 1;
      } catch (err) {
        ok(false, `${type}/${f} failed validation: ${err.message}`);
      }
    }
  }
  for (const type of CASE_TYPES) {
    ok(counts[type] >= 1, `at least one ${type} golden case present (found ${counts[type]})`);
  }

  // A malformed case must throw (the gate works).
  let threw = false;
  try {
    validateCase({ id: 'bad', type: 'sanctions' });
  } catch (e) {
    threw = true;
  }
  ok(threw, 'malformed case is rejected by validateCase');
}

console.log('');
if (failures) {
  console.error(`eval-score-smoke FAILED — ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log('eval-score-smoke OK — all assertions passed');
