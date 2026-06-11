// Phase 5 — pure-fn round-trip over three fixture projections.
// No DB. No LLM. Asserts the engine routes on the final risk tier (not
// score thresholds) and emits deterministic qaResult shapes.

const { evaluateQa } = require('../services/qa');
const matrixLib = require('../services/risk/matrix');

// Matrix arg is currently unused by the engine (routing reads tier from
// state.riskAssessment) but kept for API symmetry with the graph node.
const FIXTURE_MATRIX = { body: {} };

function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Fixture 1 — clean Low-tier case → auto_approved
// ---------------------------------------------------------------------------
function cleanLowState() {
  return {
    profile: { company_name: 'Acme Ltd', company_status: 'active' },
    psc: {
      items: [
        { name: 'Alice Founder', kind: 'individual-person-with-significant-control' },
      ],
    },
    kycCard: {
      identity: { name: 'Acme Ltd', companyNumber: '12345678', status: 'active' },
      shareholders: [
        { name: 'Alice Founder', type: 'individual', percentage: 100 },
      ],
    },
    screeningReport: {
      summary: { subjectCount: 2, confirmedHits: 0, needsReview: 0, dismissedHits: 0, overallRisk: 'low' },
      perSubject: [
        { subjectId: 'profile:ACME LIMITED', name: 'Acme Ltd', kind: 'company', source: 'profile', worstStatus: 'clean' },
        { subjectId: 'psc:ALICE FOUNDER', name: 'Alice Founder', kind: 'individual', source: 'psc', worstStatus: 'clean' },
      ],
      byList: {},
    },
    riskAssessment: {
      score: 12,
      tier: 'Low',
      outcome: 'Low',
      rationale: 'UK-registered private limited company, single individual UBO, no screening hits.',
      knockoutsTriggered: [],
    },
    documents: [
      { category: 'confirmation-statement', status: 'processed', processedBy: 'ocr' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Fixture 2 — clean Medium-tier case → streamlined_review
// ---------------------------------------------------------------------------
function cleanMediumState() {
  return {
    profile: { company_name: 'Globex Holdings Ltd', company_status: 'active' },
    psc: {
      items: [
        { name: 'Globex Parent SARL', kind: 'corporate-entity-person-with-significant-control' },
      ],
    },
    kycCard: {
      identity: { name: 'Globex Holdings Ltd', companyNumber: '99999999', status: 'active' },
      shareholders: [
        { name: 'Globex Parent SARL', type: 'corporate', percentage: 100 },
      ],
    },
    screeningReport: {
      summary: { subjectCount: 2, confirmedHits: 0, needsReview: 0, dismissedHits: 0, overallRisk: 'low' },
      perSubject: [
        { subjectId: 'profile:GLOBEX HOLDINGS LIMITED', name: 'Globex Holdings Ltd', kind: 'company', source: 'profile', worstStatus: 'clean' },
        { subjectId: 'psc:GLOBEX PARENT SARL', name: 'Globex Parent SARL', kind: 'corporate', source: 'psc', worstStatus: 'clean' },
      ],
      byList: {},
    },
    riskAssessment: {
      score: 58,
      tier: 'Medium',
      outcome: 'Medium',
      rationale: 'Corporate PSC adds structural complexity; holdings activity bumps industry score.',
      knockoutsTriggered: [],
    },
    documents: [
      { category: 'confirmation-statement', status: 'processed', processedBy: 'ocr' },
      { category: 'accounts', status: 'processed', processedBy: 'text' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Fixture 3 — clean High-tier case → standard_review (passed, but tier=High)
// ---------------------------------------------------------------------------
function cleanHighState() {
  return {
    profile: { company_name: 'High Risk Trading Ltd', company_status: 'active' },
    psc: {
      items: [
        { name: 'Offshore Parent BV', kind: 'corporate-entity-person-with-significant-control' },
      ],
    },
    kycCard: {
      identity: { name: 'High Risk Trading Ltd', companyNumber: '88888888', status: 'active' },
      shareholders: [
        { name: 'Offshore Parent BV', type: 'corporate', percentage: 100 },
      ],
    },
    screeningReport: {
      summary: { subjectCount: 2, confirmedHits: 0, needsReview: 0, dismissedHits: 0, overallRisk: 'low' },
      perSubject: [
        { subjectId: 'profile:HIGH RISK TRADING LIMITED', name: 'High Risk Trading Ltd', kind: 'company', source: 'profile', worstStatus: 'clean' },
        { subjectId: 'psc:OFFSHORE PARENT BV', name: 'Offshore Parent BV', kind: 'corporate', source: 'psc', worstStatus: 'clean' },
      ],
      byList: {},
    },
    riskAssessment: {
      score: 84,
      tier: 'High',
      outcome: 'High',
      rationale: 'High-risk jurisdiction combined with opaque ownership.',
      knockoutsTriggered: [],
    },
    documents: [
      { category: 'confirmation-statement', status: 'processed', processedBy: 'ocr' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Fixture 4 — sanctions hit + ubo gap → standard_review with consistency
// issues (ubo_not_screened only; tier=High matches the knockout so the
// tier_too_low_* checks do NOT fire).
// ---------------------------------------------------------------------------
function failSanctionsState() {
  return {
    profile: { company_name: 'Suspect Ltd', company_status: 'active' },
    psc: {
      items: [
        { name: 'John Sanctioned', kind: 'individual-person-with-significant-control' },
        { name: 'Hidden UBO Corp', kind: 'corporate-entity-person-with-significant-control' },
      ],
    },
    kycCard: {
      identity: { name: 'Suspect Ltd', companyNumber: '00000001', status: 'active' },
      shareholders: [
        { name: 'John Sanctioned', type: 'individual' },
      ],
    },
    screeningReport: {
      summary: { subjectCount: 2, confirmedHits: 1, needsReview: 0, dismissedHits: 0, overallRisk: 'high' },
      // NOTE: "Hidden UBO Corp" intentionally NOT in perSubject — should trigger ubo_not_screened.
      perSubject: [
        { subjectId: 'profile:SUSPECT LIMITED', name: 'Suspect Ltd', kind: 'company', source: 'profile', worstStatus: 'clean' },
        { subjectId: 'psc:JOHN SANCTIONED', name: 'John Sanctioned', kind: 'individual', source: 'psc', worstStatus: 'confirmed' },
      ],
      byList: {},
    },
    riskAssessment: {
      // tier=High via the screening knockout — what we expect in real life.
      score: 42,
      tier: 'High',
      outcome: 'High',
      rationale: 'Confirmed sanctions hit triggered the screening_high_override knockout.',
      knockoutsTriggered: ['screeningHighOverride'],
    },
    documents: [
      { category: 'confirmation-statement', status: 'processed', processedBy: 'ocr' },
      { category: 'accounts', status: 'failed', error: 'OCR timed out' },
    ],
  };
}

// ---------------------------------------------------------------------------
// Fixture 5 — broken-knockout state: confirmed sanctions hit but tier is
// Medium. Both tier_too_low_for_sanction_hit and tier_too_low_for_knockout
// should fire.
// ---------------------------------------------------------------------------
function brokenKnockoutState() {
  return {
    profile: { company_name: 'Inconsistent Ltd', company_status: 'active' },
    psc: { items: [{ name: 'Jane Smith', kind: 'individual-person-with-significant-control' }] },
    kycCard: {
      identity: { name: 'Inconsistent Ltd', companyNumber: '11111111', status: 'active' },
      shareholders: [{ name: 'Jane Smith', type: 'individual', percentage: 100 }],
    },
    screeningReport: {
      summary: { subjectCount: 2, confirmedHits: 1, needsReview: 0, dismissedHits: 0, overallRisk: 'high' },
      perSubject: [
        { subjectId: 'profile:INCONSISTENT LIMITED', name: 'Inconsistent Ltd', kind: 'company', source: 'profile', worstStatus: 'clean' },
        { subjectId: 'psc:JANE SMITH', name: 'Jane Smith', kind: 'individual', source: 'psc', worstStatus: 'confirmed' },
      ],
      byList: {},
    },
    riskAssessment: {
      // BROKEN: confirmed hit + knockout triggered but tier is Medium.
      score: 40,
      tier: 'Medium',
      outcome: 'Medium',
      rationale: '(intentionally broken fixture)',
      knockoutsTriggered: ['screeningHighOverride'],
    },
    documents: [],
  };
}

async function main() {
  console.log('[qa:engine-smoke] running engine over 5 fixtures');

  // 1. clean Low → auto_approved
  console.log('[qa:engine-smoke] fixture 1: clean Low');
  const r1 = evaluateQa({ state: cleanLowState(), matrix: FIXTURE_MATRIX });
  ok('fixture 1 passed', r1.passed);
  ok('fixture 1 completeness has no missing', r1.completeness.missing.length === 0,
    JSON.stringify(r1.completeness.missing));
  ok('fixture 1 consistency has no issues', r1.consistency.issues.length === 0,
    JSON.stringify(r1.consistency.issues.map((i) => i.code)));
  ok('fixture 1 routed to auto_approved', r1.routing.caseStatus === 'auto_approved',
    `got=${r1.routing.caseStatus}`);
  ok('fixture 1 qaSummary mentions auto-approved', /auto-approved/.test(r1.qaSummary));
  ok('fixture 1 tier is Low', r1.tier === 'Low');
  ok('fixture 1 evaluatedAt is an ISO string',
    typeof r1.evaluatedAt === 'string' && !!Date.parse(r1.evaluatedAt));

  // 2. clean Medium → streamlined_review
  console.log('[qa:engine-smoke] fixture 2: clean Medium');
  const r2 = evaluateQa({ state: cleanMediumState(), matrix: FIXTURE_MATRIX });
  ok('fixture 2 passed', r2.passed);
  ok('fixture 2 routed to streamlined_review',
    r2.routing.caseStatus === 'streamlined_review',
    `got=${r2.routing.caseStatus}`);
  ok('fixture 2 qaSummary mentions streamlined', /streamlined/.test(r2.qaSummary));
  ok('fixture 2 tier is Medium', r2.tier === 'Medium');

  // 3. clean High → standard_review (passed but High)
  console.log('[qa:engine-smoke] fixture 3: clean High');
  const r3 = evaluateQa({ state: cleanHighState(), matrix: FIXTURE_MATRIX });
  ok('fixture 3 passed', r3.passed);
  ok('fixture 3 routed to standard_review',
    r3.routing.caseStatus === 'standard_review',
    `got=${r3.routing.caseStatus}`);
  ok('fixture 3 qaSummary mentions standard review', /standard review/.test(r3.qaSummary));
  ok('fixture 3 tier is High', r3.tier === 'High');

  // 4. sanctions + ubo gap → standard_review (failed)
  console.log('[qa:engine-smoke] fixture 4: sanctions + ubo gap');
  const r4 = evaluateQa({ state: failSanctionsState(), matrix: FIXTURE_MATRIX });
  ok('fixture 4 NOT passed', !r4.passed);
  ok('fixture 4 routed to standard_review',
    r4.routing.caseStatus === 'standard_review',
    `got=${r4.routing.caseStatus}`);
  const codes4 = r4.consistency.issues.map((i) => i.code);
  ok('fixture 4 issues include ubo_not_screened',
    codes4.includes('ubo_not_screened'),
    JSON.stringify(codes4));
  ok('fixture 4 does NOT include tier_too_low_for_sanction_hit (tier=High is correct)',
    !codes4.includes('tier_too_low_for_sanction_hit'),
    JSON.stringify(codes4));
  ok('fixture 4 does NOT include tier_too_low_for_knockout (tier=High is correct)',
    !codes4.includes('tier_too_low_for_knockout'),
    JSON.stringify(codes4));

  // missingSubjects carries the original name (not normalized)
  const uboIssue = r4.consistency.issues.find((i) => i.code === 'ubo_not_screened');
  ok('fixture 4 ubo_not_screened evidence has Hidden UBO Corp',
    Array.isArray(uboIssue?.evidence?.missingSubjects)
    && uboIssue.evidence.missingSubjects.includes('Hidden UBO Corp'),
    JSON.stringify(uboIssue?.evidence));

  // Document failure surfaces as a warning, not a missing field
  ok('fixture 4 completeness.warnings includes failed document',
    r4.completeness.warnings.some((w) => w === 'document_status:accounts:failed'),
    JSON.stringify(r4.completeness.warnings));
  ok('fixture 4 completeness.passed (failures are warnings, not missing)',
    r4.completeness.passed,
    `missing=${JSON.stringify(r4.completeness.missing)}`);

  // highlightedIssues contains UI-ready records
  ok('fixture 4 highlightedIssues includes anchor and severity',
    r4.highlightedIssues.length > 0
    && r4.highlightedIssues.every((h) => h.anchor && h.severity && h.message),
    `count=${r4.highlightedIssues.length}`);

  // 5. broken-knockout state → tier_too_low_* checks fire
  console.log('[qa:engine-smoke] fixture 5: broken knockout (tier=Medium with confirmed hit)');
  const r5 = evaluateQa({ state: brokenKnockoutState(), matrix: FIXTURE_MATRIX });
  ok('fixture 5 NOT passed', !r5.passed);
  ok('fixture 5 routed to standard_review',
    r5.routing.caseStatus === 'standard_review',
    `got=${r5.routing.caseStatus}`);
  const codes5 = r5.consistency.issues.map((i) => i.code);
  ok('fixture 5 issues include tier_too_low_for_sanction_hit',
    codes5.includes('tier_too_low_for_sanction_hit'),
    JSON.stringify(codes5));
  ok('fixture 5 issues include tier_too_low_for_knockout',
    codes5.includes('tier_too_low_for_knockout'),
    JSON.stringify(codes5));

  // ---------------------------------------------------------------------------
  // validateMatrix — qaThresholds should be gone; default body still validates;
  // a body with a leftover qaThresholds key (legacy DB row) also validates.
  // ---------------------------------------------------------------------------
  console.log('[qa:engine-smoke] validateMatrix — qaThresholds removed');
  const goodBody = matrixLib.defaultMatrixBody();
  ok('default matrix body has no qaThresholds key', goodBody.qaThresholds === undefined,
    `keys=${Object.keys(goodBody).join(',')}`);
  const goodErrs = matrixLib.validateMatrix(goodBody);
  ok('default matrix body passes validateMatrix',
    goodErrs.length === 0, goodErrs.join('; '));

  const legacyBody = matrixLib.defaultMatrixBody();
  legacyBody.qaThresholds = { autoApproveMax: 25, sanctionHitMinScore: 90 };
  const legacyErrs = matrixLib.validateMatrix(legacyBody);
  ok('legacy body with leftover qaThresholds still validates (back-compat)',
    legacyErrs.length === 0, legacyErrs.join('; '));

  // ---------------------------------------------------------------------------
  // Determinism — same input twice yields same output (modulo evaluatedAt)
  // ---------------------------------------------------------------------------
  const a = evaluateQa({ state: cleanLowState(), matrix: FIXTURE_MATRIX });
  const b = evaluateQa({ state: cleanLowState(), matrix: FIXTURE_MATRIX });
  const stripTs = (o) => ({ ...o, evaluatedAt: undefined });
  ok('engine is deterministic (excluding evaluatedAt)',
    JSON.stringify(stripTs(a)) === JSON.stringify(stripTs(b)));

  console.log('[qa:engine-smoke] done');
}

main().catch((err) => {
  console.error('[qa:engine-smoke] FAILED:', err);
  process.exitCode = 1;
});
