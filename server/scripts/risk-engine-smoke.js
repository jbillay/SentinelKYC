// Phase 3 / R2 — risk calculation-engine smoke.
// Fixture-driven: no Companies House, no Postgres, no Ollama. Exercises the
// engine (services/risk/index.js#assessRisk) against three scenarios and
// asserts score / tier / outcome / knockouts, that factor contributions sum to
// the score, and that the receipt is deterministic (modulo the wall-clock
// `calculatedAt`). Every fixture's country is in the static lookup table, so no
// LLM normalization is triggered — the smoke stays offline.
//
// Run: `npm run risk:engine-smoke` — standalone, no DB needed.

const { assessRisk } = require('../services/risk');
const matrixBody = require('../services/risk/defaults/matrix.json');

const MATRIX = { versionId: 'fixture-v1', version: 1, body: matrixBody };

function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

function sumContributions(result) {
  return result.factors.reduce((a, f) => a + f.contribution, 0);
}

function baseProfileGbSoftware() {
  return {
    company_name: 'Northbridge Software Ltd',
    company_number: '08123456',
    type: 'ltd',
    company_status: 'active',
    date_of_creation: '2012-06-01',
    registered_office_address: { country: 'United Kingdom', locality: 'London', postal_code: 'EC1A 1BB' },
    sic_codes: ['62012'],
  };
}

function baseKycGbSoftware() {
  return {
    identity: { name: 'Northbridge Software Ltd', companyNumber: '08123456' },
    shareholders: [{ name: 'Alice Johnson', type: 'individual', percentage: 100 }],
  };
}

function basePscGbSoftware() {
  return { items: [{ name: 'Alice Johnson', kind: 'individual-person-with-significant-control' }] };
}

// --- scenario (a): clean GB software co → Low ---------------------------------
async function scenarioCleanGb() {
  console.log('[risk:engine-smoke] (a) clean GB software co');
  const result = await assessRisk({
    profile: baseProfileGbSoftware(),
    kycCard: baseKycGbSoftware(),
    psc: basePscGbSoftware(),
    screeningReport: { summary: { subjectCount: 2, confirmedHits: 0, needsReview: 0, dismissedHits: 0, overallRisk: 'low' } },
    previousAssessment: null,
    matrix: MATRIX,
  });

  ok('tier is Low', result.tier === 'Low', `got ${result.tier}`);
  ok('outcome is Low', result.outcome === 'Low', `got ${result.outcome}`);
  ok('score is 8.5', result.score === 8.5, `got ${result.score}`);
  ok('no knockouts triggered', result.knockoutsTriggered.length === 0, JSON.stringify(result.knockoutsTriggered));
  ok('contributions sum to score (±0.01)', Math.abs(sumContributions(result) - result.score) <= 0.01,
     `sum=${sumContributions(result)} score=${result.score}`);
  ok('geographic matched GB', result.factors[0].attribute.iso2 === 'GB' && result.factors[0].attribute.matched);
  ok('industry matched 62 prefix', result.factors[3].attribute.prefix === '62', `got ${result.factors[3].attribute.prefix}`);
  ok('matrixVersionId threaded through', result.matrixVersionId === 'fixture-v1');
  ok('deltaFromPrevious is null (no previous)', result.deltaFromPrevious === null);
  return result;
}

// --- scenario (b): Panamanian holding co, 4 corp PSC layers, gambling → High --
async function scenarioPanamaHolding() {
  console.log('[risk:engine-smoke] (b) Panamanian holding co, 4 corporate PSC layers, gambling');
  const result = await assessRisk({
    profile: {
      company_name: 'Istmo Holdings SA',
      company_number: 'FC012345',
      type: 'oversea-company',
      company_status: 'active',
      registered_office_address: { country: 'Panama' },
      sic_codes: ['92000', '64209'],
    },
    kycCard: {
      identity: { name: 'Istmo Holdings SA', companyNumber: 'FC012345' },
      shareholders: [
        { name: 'Cascade Topco Ltd', type: 'corporate', percentage: 100 },
        { name: 'Offshore Trust Services Ltd', type: 'corporate' },
      ],
    },
    psc: {
      items: [
        { name: 'Cascade Topco Ltd', kind: 'corporate-entity-person-with-significant-control' },
        { name: 'Cascade Midco Ltd', kind: 'corporate-entity-person-with-significant-control' },
        { name: 'Cascade Bidco SA', kind: 'legal-person-person-with-significant-control' },
        { name: 'Cascade Nominees Ltd', kind: 'corporate-entity-person-with-significant-control' },
      ],
    },
    screeningReport: { summary: { subjectCount: 6, confirmedHits: 0, needsReview: 0, dismissedHits: 0, overallRisk: 'low' } },
    previousAssessment: { score: 30 },
    matrix: MATRIX,
  });

  ok('tier is High', result.tier === 'High', `got ${result.tier}`);
  ok('outcome is High', result.outcome === 'High', `got ${result.outcome}`);
  ok('score is 82', result.score === 82, `got ${result.score}`);
  ok('no knockouts triggered (screening clean)', result.knockoutsTriggered.length === 0, JSON.stringify(result.knockoutsTriggered));
  ok('contributions sum to score (±0.01)', Math.abs(sumContributions(result) - result.score) <= 0.01,
     `sum=${sumContributions(result)} score=${result.score}`);
  ok('geographic matched PA', result.factors[0].attribute.iso2 === 'PA' && result.factors[0].attribute.matched);
  ok('structuralComplexity counted 4 corporate PSCs', result.factors[2].attribute.corporatePscCount === 4,
     `got ${result.factors[2].attribute.corporatePscCount}`);
  ok('structuralComplexity estimated 6 ownership layers', result.factors[2].attribute.shareholderLayers === 6,
     `got ${result.factors[2].attribute.shareholderLayers}`);
  ok('structuralComplexity baseScore is 100 (max of 75,100)', result.factors[2].baseScore === 100,
     `got ${result.factors[2].baseScore}`);
  ok('industry matched 9200 (gambling) at 90', result.factors[3].baseScore === 90 && result.factors[3].attribute.prefix === '9200',
     `prefix=${result.factors[3].attribute.prefix} score=${result.factors[3].baseScore}`);
  ok('deltaFromPrevious is 52 (82 - 30)', result.deltaFromPrevious === 52, `got ${result.deltaFromPrevious}`);
  ok('deltaFlagged true (|52| >= 15)', result.deltaFlagged === true);
  return result;
}

// --- scenario (c): clean co + confirmed sanctions → outcome Prohibited --------
async function scenarioConfirmedSanctions() {
  console.log('[risk:engine-smoke] (c) clean GB co + confirmed sanctions hit');
  const result = await assessRisk({
    profile: baseProfileGbSoftware(),
    kycCard: baseKycGbSoftware(),
    psc: basePscGbSoftware(),
    screeningReport: { summary: { subjectCount: 2, confirmedHits: 1, needsReview: 0, dismissedHits: 0, overallRisk: 'high' } },
    previousAssessment: { score: 8.5 },
    matrix: MATRIX,
  });

  ok('outcome is Prohibited', result.outcome === 'Prohibited', `got ${result.outcome}`);
  ok('tier forced to High', result.tier === 'High', `got ${result.tier}`);
  ok('score still 8.5 (knockouts do not change the score)', result.score === 8.5, `got ${result.score}`);
  ok('screeningProhibited knockout triggered', result.knockoutsTriggered.includes('screeningProhibited'),
     JSON.stringify(result.knockoutsTriggered));
  ok('screeningHighOverride knockout also triggered', result.knockoutsTriggered.includes('screeningHighOverride'),
     JSON.stringify(result.knockoutsTriggered));
  ok('contributions sum to score (±0.01)', Math.abs(sumContributions(result) - result.score) <= 0.01,
     `sum=${sumContributions(result)} score=${result.score}`);
  ok('deltaFromPrevious is 0', result.deltaFromPrevious === 0, `got ${result.deltaFromPrevious}`);
  ok('deltaFlagged false', result.deltaFlagged === false);
  return result;
}

// --- determinism: identical inputs → byte-identical receipt (modulo timestamp)
async function scenarioDeterminism() {
  console.log('[risk:engine-smoke] determinism');
  const args = {
    profile: baseProfileGbSoftware(),
    kycCard: baseKycGbSoftware(),
    psc: basePscGbSoftware(),
    screeningReport: { summary: { subjectCount: 2, confirmedHits: 0, needsReview: 0, dismissedHits: 0, overallRisk: 'low' } },
    previousAssessment: { score: 12 },
    matrix: MATRIX,
  };
  const a = await assessRisk(args);
  const b = await assessRisk(args);
  const strip = (r) => JSON.stringify({ ...r, calculatedAt: null, receipt: { ...r.receipt, calculatedAt: null } });
  ok('two runs on identical inputs are byte-identical (excluding calculatedAt)', strip(a) === strip(b));
  ok('receipt has the four factors with evidence', Array.isArray(a.receipt.factors) && a.receipt.factors.length === 4 && a.receipt.factors.every((f) => f.evidence));
  ok('receipt records matrix version', a.receipt.matrix.versionId === 'fixture-v1' && a.receipt.matrix.version === 1);
}

async function main() {
  await scenarioCleanGb();
  await scenarioPanamaHolding();
  await scenarioConfirmedSanctions();
  await scenarioDeterminism();
  console.log(`[risk:engine-smoke] ${process.exitCode ? 'FAILED' : 'done'}`);
}

main().catch((err) => {
  console.error('[risk:engine-smoke] FAILED:', err);
  process.exitCode = 1;
});
