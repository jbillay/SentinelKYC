const crypto = require('crypto');
const { isGraphInterrupt } = require('@langchain/langgraph');
const metrics = require('../services/metrics');
const { childLogger } = require('../services/log');

const DECISION_NODES = new Set([
  'entity_resolution',
  'await_confirmation',
  'select_documents',
  'process_documents',
  'synthesize_card',
  // Phase 2 — resolver step is decision-grade. party_merge / party_split
  // are human_action node ids written outside the graph; they're already
  // covered by the fragment_kind enum but listed here for completeness
  // when a future graph node emits them.
  'resolve_parties',
  'party_merge',
  'party_split',
  'compile_screening_list',
  'evaluate_sanctions_hits',
  'evaluate_adverse_media',
  'compile_screening_report',
  'assess_risk',
  'qa_check',
  'qa_narrative',
]);

function kindOf(nodeId) {
  return DECISION_NODES.has(nodeId) ? 'decision' : 'audit';
}

function newId() {
  return crypto.randomUUID();
}

function makeFragment({
  id,
  parentFragmentId,
  nodeId,
  startedAt,
  summary,
  inputs,
  outputs,
  status = 'ok',
  error,
  kind,
}) {
  const endedAt = Date.now();
  return {
    id: id || newId(),
    parentFragmentId: parentFragmentId ?? null,
    nodeId,
    sequence: -1, // assigned at persistence time
    kind: kind || kindOf(nodeId),
    status,
    startedAt,
    durationMs: Math.max(0, endedAt - startedAt),
    summary,
    inputs,
    outputs,
    error,
  };
}

/**
 * Wraps a node body in:
 *   - startedAt capture
 *   - automatic fragment building from a returned `__fragment` shape
 *   - merging the fragment into the node's partial state under `fragments: [...]`
 *
 * The node body returns its normal partial state plus a `__fragment` key with
 * { summary, inputs?, outputs?, status?, error?, kind? }. The wrapper strips
 * `__fragment` before returning to the graph and replaces it with `fragments: [<fragment>]`.
 */
function withFragment(nodeId, fn) {
  return async function wrapped(state, config) {
    const startedAt = Date.now();
    // R7: every node flows through this wrapper — the single highest-leverage
    // observability hook. runId arrives via state once R4a populates it.
    const log = childLogger({
      nodeId,
      threadId: config?.configurable?.thread_id ?? config?.configurable?.threadId ?? undefined,
      runId: state?.runId ?? undefined,
    });
    let result;
    let thrown;
    try {
      result = await fn(state, config);
    } catch (err) {
      // GraphInterrupt is LangGraph's pause-control flow — must re-throw or the runtime cannot pause.
      if (isGraphInterrupt(err)) {
        log.info({ durationMs: Date.now() - startedAt, status: 'interrupted' }, 'node interrupted');
        throw err;
      }
      thrown = err;
      result = {};
    }
    const durationMs = Date.now() - startedAt;
    metrics.observe('node_latency_ms', durationMs, { node: nodeId });
    if (thrown) {
      log.error({ durationMs, err: thrown.message }, 'node failed');
    } else {
      log.info({ durationMs, status: 'ok' }, 'node complete');
    }

    const partial = { ...result };
    const meta = partial.__fragment;
    const metaList = partial.__fragments;
    delete partial.__fragment;
    delete partial.__fragments;

    const built = [];

    if (Array.isArray(metaList)) {
      for (const m of metaList) {
        const fStarted = m.startedAt ?? startedAt;
        built.push(
          makeFragment({
            id: m.id,
            parentFragmentId: m.parentFragmentId,
            nodeId: m.nodeId || nodeId,
            startedAt: fStarted,
            summary: m.summary || nodeId,
            inputs: m.inputs,
            outputs: m.outputs,
            status: m.status || 'ok',
            error: m.error,
            kind: m.kind,
          })
        );
        // makeFragment uses Date.now() for endedAt — patch durationMs if caller supplied it
        if (m.durationMs != null) {
          built[built.length - 1].durationMs = m.durationMs;
        }
      }
    }

    if (meta || (!metaList && !thrown)) {
      let id;
      let parentFragmentId;
      let summary;
      let inputs;
      let outputs;
      let status = thrown ? 'failed' : 'ok';
      let error = thrown?.message;
      let kind;

      if (meta) {
        id = meta.id;
        parentFragmentId = meta.parentFragmentId;
        summary = meta.summary;
        inputs = meta.inputs;
        outputs = meta.outputs;
        if (meta.status) status = meta.status;
        if (meta.error) error = meta.error;
        if (meta.kind) kind = meta.kind;
      } else {
        summary = thrown ? `${nodeId} failed` : nodeId;
      }

      built.push(
        makeFragment({
          id,
          parentFragmentId,
          nodeId,
          startedAt,
          summary,
          inputs,
          outputs,
          status,
          error,
          kind,
        })
      );
    } else if (thrown && !metaList) {
      built.push(
        makeFragment({
          nodeId,
          startedAt,
          summary: `${nodeId} failed: ${thrown.message}`,
          status: 'failed',
          error: thrown.message,
        })
      );
    }

    const existingFragments = Array.isArray(partial.fragments) ? partial.fragments : [];
    partial.fragments = [...existingFragments, ...built];

    if (thrown) {
      const existingErrors = Array.isArray(partial.errors) ? partial.errors : [];
      partial.errors = [
        ...existingErrors,
        { node: nodeId, message: thrown.message, ts: Date.now() },
      ];
    }

    return partial;
  };
}

module.exports = {
  DECISION_NODES,
  kindOf,
  makeFragment,
  withFragment,
};
