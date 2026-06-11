// Pure scoring functions for the eval harness (R3). NO I/O, NO requires beyond
// this file — so it can be unit-tested offline (scripts/eval-score-smoke.js)
// without a DB, an LLM, or any fixture.
//
// Three scorers + their aggregators:
//   - extraction    → per-field precision/recall + exact-record match rate
//   - sanctions     → confusion matrix + precision/recall on `confirmed`
//   - adverse media → decision accuracy + category macro-F1 + severity accuracy

const DECISIONS = ['confirmed', 'dismissed', 'needs_review'];
const AM_CATEGORIES = [
  'financial_crime',
  'fraud',
  'corruption',
  'tax_evasion',
  'regulatory_action',
  'litigation',
  'other',
];

function round(n, dp = 4) {
  if (!Number.isFinite(n)) return null;
  const f = 10 ** dp;
  return Math.round(n * f) / f;
}

function normStr(v) {
  return String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

// Field-equality used by extraction scoring. Numbers compare numerically with a
// small tolerance (OCR'd figures, percentages); everything else as normalised
// strings. enum/boolean fall through to the string path.
function valuesEqual(expected, predicted) {
  if (expected === null || expected === undefined) return true; // nothing asserted
  if (typeof expected === 'number') {
    const p = typeof predicted === 'number' ? predicted : Number(predicted);
    if (!Number.isFinite(p)) return false;
    return Math.abs(expected - p) <= Math.max(0.01, Math.abs(expected) * 1e-6);
  }
  return normStr(expected) === normStr(predicted);
}

function precisionRecallF1(tp, fp, fn) {
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 1 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision: round(precision), recall: round(recall), f1: round(f1) };
}

function mean(nums) {
  const vals = nums.filter((n) => Number.isFinite(n));
  if (!vals.length) return null;
  return round(vals.reduce((a, b) => a + b, 0) / vals.length);
}

// --- extraction -----------------------------------------------------------

// Score one extraction case. `expected` and `predicted` are the full extracted
// objects (predicted comes from extractStructured). `scoring` is the case's
// recordSets + scalarFields config.
function scoreExtractionCase(expected, predicted, scoring = {}) {
  predicted = predicted || {};
  const recordSets = scoring.recordSets || [];
  const scalarFields = scoring.scalarFields || [];

  const counts = {
    recordTP: 0,
    recordFP: 0,
    recordFN: 0,
    fieldCorrect: 0,
    fieldTotal: 0,
    exactRecords: 0,
    expectedRecords: 0,
    scalarCorrect: 0,
    scalarTotal: 0,
  };

  for (const rs of recordSets) {
    const key = rs.key || 'name';
    const fields = rs.fields || [];
    const expRecords = Array.isArray(expected[rs.field]) ? expected[rs.field] : [];
    const predRecords = Array.isArray(predicted[rs.field]) ? predicted[rs.field] : [];

    // Index predicted by normalised key; a key may appear once (first wins).
    const predByKey = new Map();
    for (const r of predRecords) {
      const k = normStr(r?.[key]);
      if (k && !predByKey.has(k)) predByKey.set(k, r);
    }
    const matchedPredKeys = new Set();

    counts.expectedRecords += expRecords.length;

    for (const exp of expRecords) {
      const k = normStr(exp?.[key]);
      const pred = predByKey.get(k);
      if (pred) {
        counts.recordTP += 1;
        matchedPredKeys.add(k);
        // per-field accuracy on this matched record
        let allFieldsOk = true;
        for (const f of fields) {
          if (exp[f] === undefined || exp[f] === null) continue; // not asserted
          counts.fieldTotal += 1;
          if (valuesEqual(exp[f], pred[f])) counts.fieldCorrect += 1;
          else allFieldsOk = false;
        }
        if (allFieldsOk) counts.exactRecords += 1;
      } else {
        counts.recordFN += 1;
      }
    }
    // predicted records with no matching expected key = false positives
    for (const k of predByKey.keys()) {
      if (!matchedPredKeys.has(k)) counts.recordFP += 1;
    }
  }

  for (const f of scalarFields) {
    if (expected[f] === undefined || expected[f] === null) continue;
    counts.scalarTotal += 1;
    if (valuesEqual(expected[f], predicted[f])) counts.scalarCorrect += 1;
  }

  const recordPRF = precisionRecallF1(counts.recordTP, counts.recordFP, counts.recordFN);
  return {
    counts,
    recordPrecision: recordPRF.precision,
    recordRecall: recordPRF.recall,
    recordF1: recordPRF.f1,
    fieldAccuracy: counts.fieldTotal === 0 ? null : round(counts.fieldCorrect / counts.fieldTotal),
    exactRecordMatchRate:
      counts.expectedRecords === 0 ? null : round(counts.exactRecords / counts.expectedRecords),
    scalarAccuracy: counts.scalarTotal === 0 ? null : round(counts.scalarCorrect / counts.scalarTotal),
  };
}

function aggregateExtraction(perCase) {
  const sum = {
    recordTP: 0,
    recordFP: 0,
    recordFN: 0,
    fieldCorrect: 0,
    fieldTotal: 0,
    exactRecords: 0,
    expectedRecords: 0,
    scalarCorrect: 0,
    scalarTotal: 0,
  };
  for (const c of perCase) {
    for (const k of Object.keys(sum)) sum[k] += c.metrics.counts[k] || 0;
  }
  const recordPRF = precisionRecallF1(sum.recordTP, sum.recordFP, sum.recordFN);
  return {
    caseCount: perCase.length,
    counts: sum,
    recordPrecision: recordPRF.precision,
    recordRecall: recordPRF.recall,
    recordF1: recordPRF.f1,
    fieldAccuracy: sum.fieldTotal === 0 ? null : round(sum.fieldCorrect / sum.fieldTotal),
    exactRecordMatchRate:
      sum.expectedRecords === 0 ? null : round(sum.exactRecords / sum.expectedRecords),
    scalarAccuracy: sum.scalarTotal === 0 ? null : round(sum.scalarCorrect / sum.scalarTotal),
  };
}

// --- sanctions ------------------------------------------------------------

function scoreSanctionsCase(expected, predicted) {
  const exp = expected.decision;
  const pred = predicted ? predicted.decision : null;
  return { expected: exp, predicted: pred, correct: exp === pred };
}

function emptyConfusion() {
  const m = {};
  for (const e of DECISIONS) {
    m[e] = {};
    for (const p of DECISIONS) m[e][p] = 0;
  }
  return m;
}

function aggregateSanctions(perCase) {
  const confusion = emptyConfusion();
  let correct = 0;
  let scored = 0;
  // binary view: "confirmed" = positive
  let tp = 0;
  let fp = 0;
  let fn = 0;
  for (const c of perCase) {
    const { expected, predicted } = c.metrics;
    if (!DECISIONS.includes(predicted)) continue; // failed / unparseable prediction
    scored += 1;
    confusion[expected][predicted] += 1;
    if (expected === predicted) correct += 1;
    const expPos = expected === 'confirmed';
    const predPos = predicted === 'confirmed';
    if (expPos && predPos) tp += 1;
    else if (!expPos && predPos) fp += 1;
    else if (expPos && !predPos) fn += 1;
  }
  const confirmed = precisionRecallF1(tp, fp, fn);
  return {
    caseCount: perCase.length,
    scored,
    accuracy: scored === 0 ? null : round(correct / scored),
    confusion,
    confirmed: { ...confirmed, tp, fp, fn },
  };
}

// --- adverse media --------------------------------------------------------

function scoreAdverseMediaCase(expected, predicted) {
  const p = predicted || {};
  return {
    expectedDecision: expected.decision,
    predictedDecision: p.decision ?? null,
    decisionCorrect: expected.decision === p.decision,
    expectedCategory: expected.category ?? null,
    predictedCategory: p.category ?? null,
    categoryCorrect: expected.category == null ? null : expected.category === p.category,
    expectedSeverity: expected.severity ?? null,
    predictedSeverity: p.severity ?? null,
    severityCorrect: expected.severity == null ? null : expected.severity === p.severity,
  };
}

function macroCategoryF1(perCase) {
  // Only cases that asserted a category contribute.
  const labelled = perCase.filter((c) => c.metrics.expectedCategory != null);
  if (!labelled.length) return null;
  const present = new Set();
  for (const c of labelled) {
    present.add(c.metrics.expectedCategory);
    if (c.metrics.predictedCategory) present.add(c.metrics.predictedCategory);
  }
  const cats = AM_CATEGORIES.filter((c) => present.has(c));
  const f1s = [];
  for (const cat of cats) {
    let tp = 0;
    let fp = 0;
    let fn = 0;
    for (const c of labelled) {
      const exp = c.metrics.expectedCategory === cat;
      const pred = c.metrics.predictedCategory === cat;
      if (exp && pred) tp += 1;
      else if (!exp && pred) fp += 1;
      else if (exp && !pred) fn += 1;
    }
    f1s.push(precisionRecallF1(tp, fp, fn).f1);
  }
  return mean(f1s);
}

function aggregateAdverseMedia(perCase) {
  const decScored = perCase.filter((c) => DECISIONS.includes(c.metrics.predictedDecision));
  const decisionAccuracy =
    decScored.length === 0
      ? null
      : round(decScored.filter((c) => c.metrics.decisionCorrect).length / decScored.length);

  const catLabelled = perCase.filter((c) => c.metrics.categoryCorrect !== null);
  const categoryAccuracy =
    catLabelled.length === 0
      ? null
      : round(catLabelled.filter((c) => c.metrics.categoryCorrect).length / catLabelled.length);

  const sevLabelled = perCase.filter((c) => c.metrics.severityCorrect !== null);
  const severityAccuracy =
    sevLabelled.length === 0
      ? null
      : round(sevLabelled.filter((c) => c.metrics.severityCorrect).length / sevLabelled.length);

  return {
    caseCount: perCase.length,
    decisionAccuracy,
    categoryAccuracy,
    categoryMacroF1: macroCategoryF1(perCase),
    severityAccuracy,
  };
}

// Dispatch helpers used by the runner.
function scoreCase(type, caseObj, predicted) {
  if (type === 'extraction') return scoreExtractionCase(caseObj.expected, predicted, caseObj.scoring);
  if (type === 'sanctions') return scoreSanctionsCase(caseObj.expected, predicted);
  if (type === 'adverse_media') return scoreAdverseMediaCase(caseObj.expected, predicted);
  throw new Error(`scoreCase: unknown type ${type}`);
}

function aggregate(type, perCase) {
  if (type === 'extraction') return aggregateExtraction(perCase);
  if (type === 'sanctions') return aggregateSanctions(perCase);
  if (type === 'adverse_media') return aggregateAdverseMedia(perCase);
  throw new Error(`aggregate: unknown type ${type}`);
}

module.exports = {
  DECISIONS,
  AM_CATEGORIES,
  round,
  normStr,
  valuesEqual,
  precisionRecallF1,
  mean,
  scoreExtractionCase,
  aggregateExtraction,
  scoreSanctionsCase,
  aggregateSanctions,
  scoreAdverseMediaCase,
  aggregateAdverseMedia,
  macroCategoryF1,
  scoreCase,
  aggregate,
};
