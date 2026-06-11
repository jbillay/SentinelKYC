// Phase 5 / Q3 — qa_check graph node.
//
// Runs after assess_risk in both compiledGraph and compiledScreeningOnlyGraph.
// Loads the active risk matrix (passed through for symmetry with the rebase
// endpoint), runs the pure QA engine, emits a single decision fragment +
// writes state.qaResult.
//
// Routing is tier-based (Low → auto_approved, Medium → streamlined_review,
// High → standard_review). See services/qa/routingEngine.js.
//
// Never throws. QA failures are routing signals, not runtime errors; the
// `failed` fragment status is a UI hint that the case landed in
// standard_review.

const { traceEvent } = require('../state');
const { withFragment } = require('../fragments');
const { evaluateQa } = require('../../services/qa');
const { loadActiveMatrix } = require('../../services/risk/matrix');

const qaCheck = withFragment('qa_check', async function qaCheck(state) {
  const matrix = await loadActiveMatrix();
  const qaResult = evaluateQa({ state, matrix });

  const issueCount = qaResult.consistency.issues.length;
  const missingCount = qaResult.completeness.missing.length;
  const warningCount = qaResult.completeness.warnings.length;

  return {
    qaResult,
    trace: [
      traceEvent('qa_check', qaResult.routing.qaSummary, {
        passed: qaResult.passed,
        caseStatus: qaResult.routing.caseStatus,
        tier: qaResult.tier,
        missing: missingCount,
        issues: issueCount,
        warnings: warningCount,
      }),
    ],
    __fragment: {
      summary: qaResult.routing.qaSummary,
      kind: 'decision',
      status: qaResult.passed ? 'ok' : 'failed',
      inputs: {
        hasProfile: !!state.profile,
        hasKycCard: !!state.kycCard,
        hasScreeningReport: !!state.screeningReport,
        hasRiskAssessment: !!state.riskAssessment,
        riskTier: state.riskAssessment?.tier ?? null,
        riskScore: state.riskAssessment?.score ?? null,
      },
      outputs: { qaResult },
    },
  };
});

module.exports = { qaCheck };
