// Phase 5 / Q-N — qa_narrative graph node.
//
// Runs after qa_check in both compiledGraph and compiledScreeningOnlyGraph.
// Asks the reasoning LLM for a regulator-defensible recommendation narrative,
// paragraph count scaled to the post-knockout risk tier (Low=2 / Medium=4 /
// High=6), writes the result to state.qaNarrative + persists it to
// runs.qa_narrative via repo.setRunQaNarrative, and emits one decision
// fragment.
//
// Hard-fail policy (per the design decision): the LLM step has no template
// fallback. Any error (missing tier, prompt-load failure, Ollama unreachable,
// schema parse error, empty output) is thrown out of the node body. The
// withFragment wrapper converts the throw into a `failed` decision fragment
// plus a state.errors entry; the SSE runtime then closes the run with
// status='failed' on the error path. The fragment summary is intentionally
// specific so the analyst can see WHY in the trail.

const { traceEvent } = require('../state');
const { withFragment } = require('../fragments');
const { generateQaNarrative } = require('../../services/qa/narrative');

const qaNarrative = withFragment('qa_narrative', async function qaNarrative(state) {
  if (!state.qaResult) {
    throw new Error('qa_narrative: qaResult missing — qa_check must run first');
  }
  if (!state.riskAssessment) {
    throw new Error('qa_narrative: riskAssessment missing — assess_risk must run first');
  }

  const narrative = await generateQaNarrative({
    kycCard: state.kycCard,
    screeningReport: state.screeningReport,
    riskAssessment: state.riskAssessment,
    qaResult: state.qaResult,
  });
  // Persistence to runs.qa_narrative happens in the SSE writer (server/sse/runtime.js)
  // off the chunk's qaNarrative key — mirrors how qaResult is persisted.

  const headline = `QA narrative generated — ${narrative.paragraphCount}-paragraph (${narrative.tier}) recommendation`;

  return {
    qaNarrative: narrative,
    trace: [
      traceEvent('qa_narrative', headline, {
        tier: narrative.tier,
        paragraphCount: narrative.paragraphCount,
        model: narrative.model,
        promptVersionId: narrative.promptVersionId,
        chars: narrative.text.length,
      }),
    ],
    __fragment: {
      summary: headline,
      kind: 'decision',
      inputs: {
        tier: narrative.tier,
        paragraphCount: narrative.paragraphCount,
        hasKycCard: !!state.kycCard,
        hasScreeningReport: !!state.screeningReport,
        hasRiskAssessment: !!state.riskAssessment,
        hasQaResult: !!state.qaResult,
        promptVersionId: narrative.promptVersionId,
      },
      outputs: {
        model: narrative.model,
        chars: narrative.text.length,
        generatedAt: narrative.generatedAt,
        // The narrative text is also stored on the run row; including it on
        // the fragment lets the trail surface it without a second fetch.
        text: narrative.text,
      },
    },
  };
});

module.exports = { qaNarrative };
