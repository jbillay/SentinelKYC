// Phase 5 — QA engine barrel + one-shot evaluateQa.
//
// Pure. Takes a graph state and the active risk matrix; returns the
// qaResult object persisted on runs.qa_result. No I/O. No LLM.
//
// Routing is tier-based (see routingEngine.js): the final tier already
// incorporates screening knockouts, so we don't need score thresholds.
// The `matrix` arg is still accepted for API symmetry (and future use by
// completeness / consistency checks) but its qaThresholds field is gone.

const { projectCase } = require('./projectCase');
const { checkCompleteness } = require('./completenessCheck');
const { checkConsistency } = require('./consistencyCheck');
const { route } = require('./routingEngine');
const { buildHighlightedIssues } = require('./issueMap');

function evaluateQa({ state, matrix } = {}) {
  const projection = projectCase(state || {});
  const completeness = checkCompleteness(projection);
  const consistency = checkConsistency(projection);

  const passed = completeness.passed && consistency.passed;
  const tier = state?.riskAssessment?.tier ?? null;
  // Phase 2 — agents disabled for this run (seeded by runDispatch). Skipped
  // screening/risk force standard review inside route(); the list is also
  // surfaced on the qaResult so the UI can explain the routing.
  const skippedAgents = Object.entries(state?.agentStatus || {})
    .filter(([, status]) => status === 'skipped')
    .map(([id]) => id);
  const routing = route({
    passed,
    tier,
    completenessMissing: completeness.missing,
    consistencyIssues: consistency.issues,
    skippedAgents,
  });

  const highlightedIssues = buildHighlightedIssues({
    missing: completeness.missing,
    warnings: completeness.warnings,
    issues: consistency.issues,
  });

  return {
    passed,
    completeness,
    consistency,
    routing,
    highlightedIssues,
    qaSummary: routing.qaSummary,
    tier,
    ...(skippedAgents.length ? { skippedAgents } : {}),
    evaluatedAt: new Date().toISOString(),
  };
}

module.exports = {
  evaluateQa,
  projectCase,
  checkCompleteness,
  checkConsistency,
  route,
  buildHighlightedIssues,
};
