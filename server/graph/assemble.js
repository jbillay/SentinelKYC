// Phase 2 (v0.1) — graph assembler. Replaces the two hard-wired StateGraphs
// with one assembly function parameterized by preset + the enabled-agent set.
//
//   preset 'full'      — START → entity-resolution head → [document-manager]
//                        → synthesize_card → [ubo-structure] → [screening]
//                        → [risk-assessment] → qa tail → END
//   preset 'screening' — the rescreen flow: START → [ubo-structure] →
//                        [screening] → [risk-assessment] → qa tail → END,
//                        seeded with profile/officers/psc/kycCard from a
//                        prior run (see /api/dossiers/:cn/rescreen).
//
// Bracketed segments drop out when their agent is disabled; the spine is
// re-stitched around them. The qa tail is qa_check → qa_narrative →
// (auto_finalize | await_decision) when QA is enabled, or the qa_skipped
// stamp → await_decision when it isn't (fail toward human review).
//
// Degraded-mode contract: the assembler only shapes topology. The per-run
// record of WHICH agents were skipped lives in state.agentStatus, seeded by
// runDispatch#executeRunJob from the same enabled map that selected the
// graph — consumers must read state, never the live config (which can change
// mid-run).
//
// synthesize_card, await_confirmation/decision, and auto_finalize are
// orchestrator-owned (always present). Entity resolution is `required` in
// v0.1 — disabling it would need a manual-dossier-entry UI (deferred).

const { StateGraph, START, END } = require('@langchain/langgraph');

const { stateSchema } = require('./state');
const { gatherInput } = require('./nodes/gatherInput');
const { searchCh } = require('./nodes/searchCh');
const { entityResolution } = require('./nodes/entityResolution');
const { awaitConfirmation } = require('./nodes/awaitConfirmation');
const { fetchApis } = require('./nodes/fetchApis');
const { selectDocuments } = require('./nodes/selectDocuments');
const { downloadDocuments } = require('./nodes/downloadDocuments');
const { processDocuments } = require('./nodes/processDocuments');
const { synthesizeCard } = require('./nodes/synthesizeCard');
const { resolveParties } = require('./nodes/resolveParties');
const { compileScreeningList } = require('./nodes/screening/compileScreeningList');
const { screenSanctions } = require('./nodes/screening/screenSanctions');
const { evaluateSanctionsHits } = require('./nodes/screening/evaluateSanctionsHits');
const { screenAdverseMedia } = require('./nodes/screening/screenAdverseMedia');
const { evaluateAdverseMedia } = require('./nodes/screening/evaluateAdverseMedia');
const { compileScreeningReport } = require('./nodes/screening/compileScreeningReport');
const { assessRisk } = require('./nodes/assessRisk');
const { qaCheck } = require('./nodes/qaCheck');
const { qaNarrative } = require('./nodes/qaNarrative');
const { qaSkipped } = require('./nodes/qaSkipped');
const { awaitDecision } = require('./nodes/awaitDecision');
const { autoFinalize } = require('./nodes/autoFinalize');

function routeAfterResolution(state) {
  const status = state.resolution?.status;
  if (status === 'needs_more_info' || status === 'not_found') return '__end__';
  return 'await_confirmation';
}

// The conditional after fetch_apis names its continue-target dynamically:
// select_documents when the document manager is enabled, synthesize_card
// when it isn't.
function makeRouteAfterFetch(continueTarget) {
  return function routeAfterFetch(state) {
    if (state.resolution?.status === 'not_found' || state.profile == null) {
      return '__end__';
    }
    return continueTarget;
  };
}

// Branch after the QA narrative. auto_approved bypasses the human pause via
// auto_finalize; everything else pauses at await_decision (interrupt #2).
function routeAfterQa(state) {
  const tier = state.qaResult?.routing?.caseStatus;
  if (tier === 'auto_approved') return 'auto_finalize';
  return 'await_decision';
}

// Append the assessment chain (ubo → screening → risk → qa tail → END) onto
// `g` starting from `entry` (a node name already added, or START). Shared by
// both presets — the only difference between them is the head.
function wireAssessmentChain(g, entry, enabled) {
  const has = (id) => enabled[id] !== false;
  let prev = entry;

  if (has('ubo-structure')) {
    g.addNode('resolve_parties', resolveParties);
    g.addEdge(prev, 'resolve_parties');
    prev = 'resolve_parties';
  }

  if (has('screening')) {
    g.addNode('compile_screening_list', compileScreeningList)
      .addNode('screen_sanctions', screenSanctions)
      .addNode('evaluate_sanctions_hits', evaluateSanctionsHits)
      .addNode('screen_adverse_media', screenAdverseMedia)
      .addNode('evaluate_adverse_media', evaluateAdverseMedia)
      .addNode('compile_screening_report', compileScreeningReport);
    g.addEdge(prev, 'compile_screening_list');
    // Two parallel branches; LangGraph joins at compile_screening_report
    // (waits for all incoming edges; concat reducers merge cleanly).
    g.addEdge('compile_screening_list', 'screen_sanctions');
    g.addEdge('compile_screening_list', 'screen_adverse_media');
    g.addEdge('screen_sanctions', 'evaluate_sanctions_hits');
    g.addEdge('screen_adverse_media', 'evaluate_adverse_media');
    g.addEdge('evaluate_sanctions_hits', 'compile_screening_report');
    g.addEdge('evaluate_adverse_media', 'compile_screening_report');
    prev = 'compile_screening_report';
  }

  if (has('risk-assessment')) {
    g.addNode('assess_risk', assessRisk);
    g.addEdge(prev, 'assess_risk');
    prev = 'assess_risk';
  }

  g.addNode('await_decision', awaitDecision);
  if (has('qa')) {
    g.addNode('qa_check', qaCheck)
      .addNode('qa_narrative', qaNarrative)
      .addNode('auto_finalize', autoFinalize);
    g.addEdge(prev, 'qa_check');
    g.addEdge('qa_check', 'qa_narrative');
    g.addConditionalEdges('qa_narrative', routeAfterQa, {
      auto_finalize: 'auto_finalize',
      await_decision: 'await_decision',
    });
    g.addEdge('auto_finalize', END);
  } else {
    g.addNode('qa_skipped', qaSkipped);
    g.addEdge(prev, 'qa_skipped');
    g.addEdge('qa_skipped', 'await_decision');
  }
  g.addEdge('await_decision', END);
}

// Build an UNCOMPILED StateGraph for the given preset + enabled map.
// Compilation (with the shared checkpointer) happens in build.js, which also
// owns the per-enabled-set cache.
function assembleGraph({ preset = 'full', enabled = {} } = {}) {
  const has = (id) => enabled[id] !== false;
  const g = new StateGraph(stateSchema);

  if (preset === 'screening') {
    // Rescreen: the caller seeds profile/officers/psc/kycCard/documents from
    // the prior run; the chain starts at the resolver (or screening, if the
    // UBO agent is off).
    wireAssessmentChain(g, START, enabled);
    return g;
  }

  // --- full preset head: entity resolution (required) -----------------------
  g.addNode('gather_input', gatherInput)
    .addNode('search_ch', searchCh)
    .addNode('entity_resolution', entityResolution)
    .addNode('await_confirmation', awaitConfirmation)
    .addNode('fetch_apis', fetchApis)
    .addNode('synthesize_card', synthesizeCard);

  g.addEdge(START, 'gather_input');
  g.addEdge('gather_input', 'search_ch');
  g.addEdge('search_ch', 'entity_resolution');
  g.addConditionalEdges('entity_resolution', routeAfterResolution, {
    __end__: END,
    await_confirmation: 'await_confirmation',
  });
  g.addEdge('await_confirmation', 'fetch_apis');

  if (has('document-manager')) {
    g.addNode('select_documents', selectDocuments)
      .addNode('download_documents', downloadDocuments)
      .addNode('process_documents', processDocuments);
    g.addConditionalEdges('fetch_apis', makeRouteAfterFetch('select_documents'), {
      __end__: END,
      select_documents: 'select_documents',
    });
    g.addEdge('select_documents', 'download_documents');
    g.addEdge('download_documents', 'process_documents');
    g.addEdge('process_documents', 'synthesize_card');
  } else {
    g.addConditionalEdges('fetch_apis', makeRouteAfterFetch('synthesize_card'), {
      __end__: END,
      synthesize_card: 'synthesize_card',
    });
  }

  wireAssessmentChain(g, 'synthesize_card', enabled);
  return g;
}

module.exports = { assembleGraph, routeAfterQa };
