const path = require('path');
const { StateGraph, START, END } = require('@langchain/langgraph');
const { SqliteSaver } = require('@langchain/langgraph-checkpoint-sqlite');

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
const { awaitDecision } = require('./nodes/awaitDecision');
const { autoFinalize } = require('./nodes/autoFinalize');

function routeAfterResolution(state) {
  const status = state.resolution?.status;
  if (status === 'needs_more_info' || status === 'not_found') return '__end__';
  return 'await_confirmation';
}

function routeAfterFetch(state) {
  if (state.resolution?.status === 'not_found' || state.profile == null) {
    return '__end__';
  }
  return 'select_documents';
}

// Branch after QA. auto_approved bypasses the human pause and finalises the
// case via auto_finalize. streamlined/standard review go to await_decision
// where the graph interrupts and waits for the reviewer's action.
function routeAfterQa(state) {
  const tier = state.qaResult?.routing?.caseStatus;
  if (tier === 'auto_approved') return 'auto_finalize';
  return 'await_decision';
}

const checkpointer = SqliteSaver.fromConnString(
  path.join(__dirname, '..', 'graph-checkpoints.db')
);

const graph = new StateGraph(stateSchema)
  .addNode('gather_input', gatherInput)
  .addNode('search_ch', searchCh)
  .addNode('entity_resolution', entityResolution)
  .addNode('await_confirmation', awaitConfirmation)
  .addNode('fetch_apis', fetchApis)
  .addNode('select_documents', selectDocuments)
  .addNode('download_documents', downloadDocuments)
  .addNode('process_documents', processDocuments)
  .addNode('synthesize_card', synthesizeCard)
  .addNode('resolve_parties', resolveParties)
  .addNode('compile_screening_list', compileScreeningList)
  .addNode('screen_sanctions', screenSanctions)
  .addNode('evaluate_sanctions_hits', evaluateSanctionsHits)
  .addNode('screen_adverse_media', screenAdverseMedia)
  .addNode('evaluate_adverse_media', evaluateAdverseMedia)
  .addNode('compile_screening_report', compileScreeningReport)
  .addNode('assess_risk', assessRisk)
  .addNode('qa_check', qaCheck)
  .addNode('qa_narrative', qaNarrative)
  .addNode('await_decision', awaitDecision)
  .addNode('auto_finalize', autoFinalize)
  .addEdge(START, 'gather_input')
  .addEdge('gather_input', 'search_ch')
  .addEdge('search_ch', 'entity_resolution')
  .addConditionalEdges('entity_resolution', routeAfterResolution, {
    __end__: END,
    await_confirmation: 'await_confirmation',
  })
  .addEdge('await_confirmation', 'fetch_apis')
  .addConditionalEdges('fetch_apis', routeAfterFetch, {
    __end__: END,
    select_documents: 'select_documents',
  })
  .addEdge('select_documents', 'download_documents')
  .addEdge('download_documents', 'process_documents')
  .addEdge('process_documents', 'synthesize_card')
  // Phase 2: resolve_parties between synthesize_card and the screening fan-out.
  // The resolver consumes officers + psc + extracted shareholders, writes
  // the party master rows, and exposes parties/partyLinks on state for the
  // screening list to pivot on.
  .addEdge('synthesize_card', 'resolve_parties')
  .addEdge('resolve_parties', 'compile_screening_list')
  // Fan out to two parallel screening branches.
  .addEdge('compile_screening_list', 'screen_sanctions')
  .addEdge('compile_screening_list', 'screen_adverse_media')
  .addEdge('screen_sanctions', 'evaluate_sanctions_hits')
  .addEdge('screen_adverse_media', 'evaluate_adverse_media')
  // Both branches join at compile_screening_report (LangGraph waits for all
  // incoming edges; concat reducers on hits/evaluations/fragments merge cleanly).
  .addEdge('evaluate_sanctions_hits', 'compile_screening_report')
  .addEdge('evaluate_adverse_media', 'compile_screening_report')
  .addEdge('compile_screening_report', 'assess_risk')
  .addEdge('assess_risk', 'qa_check')
  .addEdge('qa_check', 'qa_narrative')
  .addConditionalEdges('qa_narrative', routeAfterQa, {
    auto_finalize: 'auto_finalize',
    await_decision: 'await_decision',
  })
  .addEdge('await_decision', END)
  .addEdge('auto_finalize', END);

const compiledGraph = graph.compile({ checkpointer });

// Screening-only graph for the rescreen flow. Skips CH, document download, OCR
// and synthesis — the caller is expected to seed initial state with `profile`,
// `officers`, `psc`, `kycCard`, `documents`, `companyNumber` from the prior run
// (see /api/dossiers/:cn/rescreen). State concat reducers on hits/evaluations/
// fragments mean the parallel branches join cleanly at compile_screening_report.
const screeningOnlyGraph = new StateGraph(stateSchema)
  // Phase 2: rescreen also runs the resolver — same parties pipeline, so
  // cross-dossier dedup happens whenever a dossier is touched (initial OR
  // rescreen). The screening-only graph is seeded by the rescreen route
  // with profile / officers / psc / kycCard from the prior run.
  .addNode('resolve_parties', resolveParties)
  .addNode('compile_screening_list', compileScreeningList)
  .addNode('screen_sanctions', screenSanctions)
  .addNode('evaluate_sanctions_hits', evaluateSanctionsHits)
  .addNode('screen_adverse_media', screenAdverseMedia)
  .addNode('evaluate_adverse_media', evaluateAdverseMedia)
  .addNode('compile_screening_report', compileScreeningReport)
  .addNode('assess_risk', assessRisk)
  .addNode('qa_check', qaCheck)
  .addNode('qa_narrative', qaNarrative)
  .addNode('await_decision', awaitDecision)
  .addNode('auto_finalize', autoFinalize)
  .addEdge(START, 'resolve_parties')
  .addEdge('resolve_parties', 'compile_screening_list')
  .addEdge('compile_screening_list', 'screen_sanctions')
  .addEdge('compile_screening_list', 'screen_adverse_media')
  .addEdge('screen_sanctions', 'evaluate_sanctions_hits')
  .addEdge('screen_adverse_media', 'evaluate_adverse_media')
  .addEdge('evaluate_sanctions_hits', 'compile_screening_report')
  .addEdge('evaluate_adverse_media', 'compile_screening_report')
  .addEdge('compile_screening_report', 'assess_risk')
  .addEdge('assess_risk', 'qa_check')
  .addEdge('qa_check', 'qa_narrative')
  .addConditionalEdges('qa_narrative', routeAfterQa, {
    auto_finalize: 'auto_finalize',
    await_decision: 'await_decision',
  })
  .addEdge('await_decision', END)
  .addEdge('auto_finalize', END);

const compiledScreeningOnlyGraph = screeningOnlyGraph.compile({ checkpointer });

module.exports = { compiledGraph, compiledScreeningOnlyGraph };
