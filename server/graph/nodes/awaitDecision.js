// Phase 5 follow-up — await_decision graph node.
//
// Runs after qa_check in both compiledGraph and compiledScreeningOnlyGraph.
// Pauses the run via interrupt() until the reviewer takes a terminal action
// (approve / reject / escalate / request_info) through the /decision endpoint.
//
// Apply-then-resume contract:
//   1. First invocation calls interrupt() with the snapshot the reviewer
//      needs to make a call (qaResult, riskAssessment, kycCard, screening
//      summary, dossier metadata). The thread pauses; the SSE writer
//      surfaces an `interrupt` event with `kind: 'final_decision'`.
//   2. The /decision endpoint:
//        a. Validates the decision payload (Zod, server twin).
//        b. Calls applyDecision — a single DB transaction that flips
//           dossiers.case_status + writes the immutable human_action audit
//           fragment with sequence = max+1.
//        c. Sends Command({ resume: { decisionApplied: true, action,
//           caseStatus, userId, fragmentId } }) to the graph.
//   3. This node is re-entered with the resume payload. It emits a trace
//      event and returns to END. It deliberately does NOT use withFragment
//      and does NOT push to state.fragments — the human_action fragment
//      written by applyDecision in step 2b is the canonical audit record,
//      and any in-graph fragment would collide on `sequence` (state-index
//      vs DB max+1 conventions don't line up after the out-of-band insert).

const { interrupt, isGraphInterrupt } = require('@langchain/langgraph');
const { traceEvent, errorEvent } = require('../state');
const repo = require('../../db/repo');
const { log } = require('../../services/log');

const TERMINAL_ACTIONS = new Set(['approve', 'reject', 'escalate', 'request_info']);
const TERMINAL_CASE_STATUS = new Set(['approved', 'rejected']);

const ACTION_TO_CASE_STATUS = {
  approve: 'approved',
  reject: 'rejected',
  escalate: 'escalated',
  request_info: 'info_requested',
};

async function awaitDecision(state) {
  // Issue 1B — terminal-dossier short-circuit.
  // Re-runs (refresh / rescreen) against an already-finalised dossier still
  // route through qa_check → await_decision, but the dossier's case_status
  // is sticky by design (CLAUDE.md: re-runs don't un-finalise). Pausing for
  // a decision against a terminal dossier is impossible — applyDecision
  // would reject every action with invalid_transition. Skip the interrupt
  // entirely and let the graph close cleanly.
  let dossierCaseStatus = null;
  if (state.companyNumber) {
    try {
      const dossier = await repo.getDossier(state.companyNumber);
      dossierCaseStatus = dossier?.caseStatus || null;
    } catch (err) {
      // Lookup failure isn't fatal — fall through and pause. The /decision
      // endpoint will still guard against an invalid transition.
      log.warn(`[await_decision] dossier lookup failed: ${err.message}`);
    }
  }
  if (dossierCaseStatus && TERMINAL_CASE_STATUS.has(dossierCaseStatus)) {
    return {
      trace: [
        traceEvent('await_decision', `dossier already finalised (${dossierCaseStatus}) — skipping reviewer pause`, {
          caseStatus: dossierCaseStatus,
        }),
      ],
    };
  }

  let resumePayload;
  try {
    resumePayload = interrupt({
      kind: 'final_decision',
      qaResult: state.qaResult || null,
      qaNarrative: state.qaNarrative || null,
      riskAssessment: state.riskAssessment || null,
      kycCard: state.kycCard || null,
      screeningReport: state.screeningReport || null,
      companyNumber: state.companyNumber || null,
      // Issue 1A — surface the real dossier case_status so the Run page's
      // FinalDecisionPanel doesn't render with a hardcoded "pending" that
      // can disagree with the DB and produce 409s on Approve.
      caseStatus: dossierCaseStatus,
    });
  } catch (err) {
    // interrupt() throws GraphInterrupt — must propagate so LangGraph can pause.
    if (isGraphInterrupt(err)) throw err;
    throw err;
  }

  // R4b idempotency contract: the resume path is side-effect free — no
  // fragment, no DB write, trace only (the human_action row written by
  // applyDecision is canonical). A replayed resume (the boot reconciler
  // re-driving an owed resume after a crash) therefore cannot duplicate audit
  // state; it just re-emits the trace and runs to the same clean terminus.
  const action = resumePayload?.action;
  if (!resumePayload?.decisionApplied || !TERMINAL_ACTIONS.has(action)) {
    return {
      errors: [errorEvent('await_decision', 'resume payload missing decisionApplied/action')],
      trace: [traceEvent('await_decision', 'invalid resume payload', { action })],
    };
  }

  const caseStatus = resumePayload.caseStatus || ACTION_TO_CASE_STATUS[action];
  const userId = resumePayload.userId || 'unknown';

  return {
    trace: [
      traceEvent('await_decision', `reviewer ${action}`, {
        action,
        caseStatus,
        userId,
        fragmentId: resumePayload.fragmentId || null,
      }),
    ],
  };
}

module.exports = { awaitDecision, ACTION_TO_CASE_STATUS };
