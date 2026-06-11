// Read-only introspection for the Settings → "Data model" and "Process" tabs.
//
// Sources of truth (all live, re-read on every request):
//   - server/graph/state.js          → Zod state schema  → JSON Schema
//   - server/db/schema.js            → Drizzle tables    → column + FK list
//   - decision_fragments table       → observed I/O keys per node + samples
//   - compiledGraph.getGraph()       → LangGraph topology + Mermaid
//
// Nothing here writes. The endpoints in routes/meta.js consume this module.

const { z } = require('zod');
const { sql } = require('drizzle-orm');
const { getTableConfig } = require('drizzle-orm/pg-core');

const stateModule = require('../graph/state');
const schemaModule = require('../db/schema');
const { db } = require('../db/client');
const { decisionFragments } = require('../db/schema');
const { DECISION_NODES, kindOf } = require('../graph/fragments');

// Tables we want to expose grouped sensibly in the persisted-entity sub-section.
// Order matters for the UI — we render groups top-down. The key is the human
// label; the value is the array of `schemaModule` exports to include.
const PERSISTED_GROUPS = [
  { label: 'Dossier & runs', tables: ['dossiers', 'runs', 'decisionFragments'] },
  {
    label: 'Screening',
    tables: [
      'sanctionsLists',
      'sanctionsEntries',
      'screeningHits',
      'screeningEvaluations',
      'dossierScreeningOverrides',
      'screeningConfig',
    ],
  },
  { label: 'Risk matrix', tables: ['riskMatrixVersions', 'riskMatrixActive'] },
  { label: 'Prompt registry', tables: ['promptVersions', 'promptActive'] },
];

// Hints that map persisted jsonb column names → the node that produces them.
// These are the "final_*" snapshots on runs + qa_result. The decision fragment
// row itself doesn't have a single producing node (every node writes one), so
// we don't tag its columns.
const RUN_COLUMN_PRODUCER = {
  final_kyc_card: 'synthesize_card',
  final_shareholder_graph: 'synthesize_card',
  final_documents: 'process_documents',
  final_screening_report: 'compile_screening_report',
  final_profile: 'fetch_apis',
  final_officers: 'fetch_apis',
  final_psc: 'fetch_apis',
  final_risk_assessment: 'assess_risk',
  qa_result: 'qa_check',
};

// State-schema top-level field → node(s) that write it. Hand-curated because
// node bodies are async closures we can't statically reflect; this is the
// minimum to make the "Written by" annotation useful. The fragment-samples
// sub-section is the live ground truth for what each node actually writes.
const STATE_FIELD_PRODUCER = {
  input: 'gather_input',
  candidates: 'search_ch',
  resolution: 'entity_resolution',
  companyNumber: 'await_confirmation',
  profile: 'fetch_apis',
  officers: 'fetch_apis',
  psc: 'fetch_apis',
  filingHistory: 'fetch_apis',
  documents: 'select_documents · download_documents · process_documents',
  kycCard: 'synthesize_card',
  shareholderGraph: 'synthesize_card',
  trace: '(all nodes)',
  errors: '(all nodes, on failure)',
  fragments: '(all nodes, via withFragment)',
  screeningSubjects: 'compile_screening_list',
  screeningHits: 'screen_sanctions · screen_adverse_media',
  screeningEvaluations: 'evaluate_sanctions_hits · evaluate_adverse_media',
  screeningReport: 'compile_screening_report',
  riskAssessment: 'assess_risk',
  qaResult: 'qa_check',
};

function introspectStateSchema() {
  // Zod 4's built-in JSON Schema conversion. `unrepresentable: 'any'` keeps
  // z.any() fields representable instead of throwing.
  const jsonSchema = z.toJSONSchema(stateModule.stateSchema, { unrepresentable: 'any' });
  const properties = jsonSchema.properties || {};
  const fields = Object.entries(properties).map(([name, def]) => ({
    name,
    schema: def,
    producedBy: STATE_FIELD_PRODUCER[name] || null,
  }));
  return { jsonSchema, fields };
}

function introspectDrizzleSchema() {
  const groups = PERSISTED_GROUPS.map((group) => {
    const tables = group.tables
      .map((exportName) => {
        const table = schemaModule[exportName];
        if (!table) return null;
        const cfg = getTableConfig(table);
        const columns = cfg.columns.map((col) => ({
          name: col.name,
          type: col.getSQLType(),
          notNull: !!col.notNull,
          primary: !!col.primary,
          producedBy:
            cfg.name === 'runs' ? RUN_COLUMN_PRODUCER[col.name] || null : null,
        }));
        const foreignKeys = (cfg.foreignKeys || []).map((fk) => {
          const ref = fk.reference();
          return {
            name: fk.getName(),
            columns: ref.columns.map((c) => c.name),
            foreignTable: ref.foreignColumns[0]?.table[Symbol.for('drizzle:Name')],
            foreignColumns: ref.foreignColumns.map((c) => c.name),
          };
        });
        return {
          exportName,
          tableName: cfg.name,
          columns,
          foreignKeys,
        };
      })
      .filter(Boolean);
    return { label: group.label, tables };
  });
  return groups;
}

// Last N fragments per node. We aggregate observed keys in JS — running an
// element-wise jsonb_object_keys per row is fine at the volumes we expect (a
// few hundred runs × ~20 nodes), and keeps the SQL boring.
async function getFragmentsByNode({ perNodeLimit = 50 } = {}) {
  // One query: pick the most recent N fragments per node using a window. The
  // node set is small (~20) so this is cheap; we cap inputs/outputs payloads
  // to keep the response tiny.
  const rows = await db.execute(sql`
    SELECT id, node_id, kind, status, summary, inputs, outputs, started_at, run_id
    FROM (
      SELECT
        id, node_id, kind, status, summary, inputs, outputs, started_at, run_id,
        row_number() OVER (PARTITION BY node_id ORDER BY started_at DESC) AS rn
      FROM decision_fragments
    ) t
    WHERE rn <= ${perNodeLimit}
    ORDER BY node_id, started_at DESC
  `);

  const byNode = new Map();
  for (const r of rows.rows) {
    const nodeId = r.node_id;
    if (!byNode.has(nodeId)) {
      byNode.set(nodeId, {
        nodeId,
        kind: r.kind,
        classification: DECISION_NODES.has(nodeId) ? 'decision' : 'audit',
        occurrences: 0,
        observedInputKeys: new Set(),
        observedOutputKeys: new Set(),
        lastSeenAt: r.started_at,
        sampleFragmentId: r.id,
        sampleRunId: r.run_id,
        sampleSummary: r.summary,
        sampleInputs: r.inputs,
        sampleOutputs: r.outputs,
      });
    }
    const bucket = byNode.get(nodeId);
    bucket.occurrences += 1;
    if (r.inputs && typeof r.inputs === 'object' && !Array.isArray(r.inputs)) {
      for (const k of Object.keys(r.inputs)) bucket.observedInputKeys.add(k);
    }
    if (r.outputs && typeof r.outputs === 'object' && !Array.isArray(r.outputs)) {
      for (const k of Object.keys(r.outputs)) bucket.observedOutputKeys.add(k);
    }
  }

  return Array.from(byNode.values()).map((b) => ({
    nodeId: b.nodeId,
    kind: b.kind,
    classification: b.classification,
    occurrences: b.occurrences,
    observedInputKeys: Array.from(b.observedInputKeys).sort(),
    observedOutputKeys: Array.from(b.observedOutputKeys).sort(),
    lastSeenAt: b.lastSeenAt,
    sample: {
      fragmentId: b.sampleFragmentId,
      runId: b.sampleRunId,
      summary: b.sampleSummary,
      inputs: b.sampleInputs,
      outputs: b.sampleOutputs,
    },
  }));
}

// Convert compiledGraph.getGraph() → serializable shape.
//
// Note: every LangGraph runtime node has `id`, `name`, `metadata`, plus a
// `data` value we deliberately drop (it's a RunnableCallable function and
// not JSON-serializable). START / END appear as `__start__` / `__end__`.
function introspectGraph(compiledGraph, { label } = {}) {
  const g = compiledGraph.getGraph();
  // `g.nodes` is a plain object (`Record<id, Node>`) on the version of
  // @langchain/langgraph we ship; older versions expose a Map. Handle both.
  const nodeValues =
    g.nodes instanceof Map ? Array.from(g.nodes.values()) : Object.values(g.nodes || {});
  const nodes = nodeValues.map((n) => {
    const isSentinel = n.id === '__start__' || n.id === '__end__';
    let classification;
    if (isSentinel) classification = 'sentinel';
    else if (n.id === 'await_confirmation' || n.id === 'await_decision') classification = 'interrupt';
    else classification = kindOf(n.id);
    return {
      id: n.id,
      name: n.name,
      classification,
    };
  });
  const edges = (g.edges || []).map((e) => ({
    source: e.source,
    target: e.target,
    conditional: !!e.conditional,
  }));
  const mermaid = typeof g.drawMermaid === 'function' ? g.drawMermaid() : null;
  return { label: label || 'graph', nodes, edges, mermaid };
}

module.exports = {
  introspectStateSchema,
  introspectDrizzleSchema,
  getFragmentsByNode,
  introspectGraph,
};
