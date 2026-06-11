// Phase 2 (v0.1) — stamp node wired in place of qa_check → qa_narrative when
// the QA agent is disabled. The decision routing still needs a caseStatus,
// and a disabled QA gate must fail toward human review: standard_review,
// never auto-approve. No narrative is generated (qa_narrative is part of the
// QA agent). The qaResult carries skipped:true so the UI can distinguish
// "QA agent disabled" from "QA ran and failed".

const { traceEvent } = require('../state');
const { withFragment } = require('../fragments');

const SUMMARY = 'QA agent disabled — case routed to standard review by default.';

const qaSkipped = withFragment('qa_skipped', async function qaSkipped(state) {
  const skippedAgents = Object.entries(state.agentStatus || {})
    .filter(([, status]) => status === 'skipped')
    .map(([id]) => id);

  const qaResult = {
    passed: false,
    skipped: true,
    ...(skippedAgents.length ? { skippedAgents } : {}),
    completeness: { passed: true, missing: [], warnings: [] },
    consistency: { passed: true, issues: [] },
    routing: { caseStatus: 'standard_review', qaSummary: SUMMARY },
    highlightedIssues: [],
    qaSummary: SUMMARY,
    tier: state.riskAssessment?.tier ?? null,
    evaluatedAt: new Date().toISOString(),
  };

  return {
    qaResult,
    trace: [traceEvent('qa_skipped', SUMMARY)],
    __fragment: {
      status: 'skipped',
      summary: SUMMARY,
      outputs: { caseStatus: 'standard_review', skippedAgents },
    },
  };
});

module.exports = { qaSkipped };
