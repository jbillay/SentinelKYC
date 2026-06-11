<script setup>
// Settings → "Process" tab. Read-only visualization of the LangGraph topology
// served by GET /api/meta/process.
//
// Cytoscape (dagre TB) draws the compiled state graph. Clicking a node opens a
// side panel with classification + observed I/O keys + recent samples, fetched
// from /api/meta/data-model (the same data the Data model tab uses). Two graphs
// are exposed by the backend: `main` (full run) and `screening_only` (rescreen).
// The user toggles between them.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import cytoscape from 'cytoscape'
import dagre from 'cytoscape-dagre'

cytoscape.use(dagre)

const loading = ref(false)
const error = ref(null)
const processData = ref(null)
const dataModelData = ref(null) // shared with DataModelTab; we fetch separately so each tab is independent
const activeGraph = ref('main')
const selectedNodeId = ref(null)
const container = ref(null)
let cy = null

// Pulled from CSS tokens — keep in sync with web/src/styles/tokens.css.
const TOKENS = {
  primary: '#0B3D91',
  primarySoft: '#E8EEFB',
  success: '#0F7A4E',
  successSoft: '#D1F4E0',
  tertiary: '#B45309',
  tertiarySoft: '#FBF1E1',
  surface: '#FFFFFF',
  border: '#E4E4DC',
  borderStrong: '#C9CDD3',
  textPrimary: '#101418',
  textSecondary: '#475569',
  textTertiary: '#737A82',
  surfaceSunken: '#F2F2EE',
  page: '#F7F7F5',
}

const STYLE = [
  {
    selector: 'node',
    style: {
      label: 'data(label)',
      'text-valign': 'center',
      'text-halign': 'center',
      'font-family': 'Inter, system-ui, sans-serif',
      'font-size': 11,
      'font-weight': 500,
      'text-wrap': 'wrap',
      'text-max-width': 140,
      color: TOKENS.textPrimary,
      'border-width': 1,
      width: 'label',
      height: 'label',
      padding: '10px',
      shape: 'round-rectangle',
      'background-color': TOKENS.surface,
      'border-color': TOKENS.borderStrong,
      'corner-radius': 6,
    },
  },
  {
    selector: 'node[classification = "decision"]',
    style: {
      'background-color': TOKENS.primarySoft,
      'border-color': TOKENS.primary,
      color: TOKENS.primary,
      'font-weight': 600,
    },
  },
  {
    selector: 'node[classification = "audit"]',
    style: {
      'background-color': TOKENS.surface,
      'border-color': TOKENS.borderStrong,
      color: TOKENS.textSecondary,
    },
  },
  {
    selector: 'node[classification = "interrupt"]',
    style: {
      'background-color': TOKENS.tertiarySoft,
      'border-color': TOKENS.tertiary,
      color: TOKENS.tertiary,
      'font-weight': 600,
      shape: 'hexagon',
    },
  },
  {
    selector: 'node[classification = "sentinel"]',
    style: {
      'background-color': TOKENS.surfaceSunken,
      'border-color': TOKENS.borderStrong,
      color: TOKENS.textTertiary,
      shape: 'ellipse',
      'font-style': 'italic',
    },
  },
  {
    selector: 'node:selected',
    style: {
      'border-width': 2,
      'border-color': TOKENS.primary,
      'background-color': TOKENS.primary,
      color: '#FFFFFF',
    },
  },
  {
    selector: 'edge',
    style: {
      width: 1.2,
      'line-color': TOKENS.borderStrong,
      'target-arrow-color': TOKENS.borderStrong,
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.8,
      'curve-style': 'bezier',
    },
  },
  {
    selector: 'edge[conditional = "true"]',
    style: {
      'line-style': 'dashed',
      'line-dash-pattern': [6, 4],
      'line-color': TOKENS.tertiary,
      'target-arrow-color': TOKENS.tertiary,
    },
  },
]

const currentGraph = computed(() => {
  if (!processData.value) return null
  return processData.value.graphs.find((g) => g.label === activeGraph.value) || processData.value.graphs[0]
})

const nodeMeta = computed(() => {
  if (!dataModelData.value) return new Map()
  const map = new Map()
  for (const row of dataModelData.value.fragmentsByNode || []) {
    map.set(row.nodeId, row)
  }
  return map
})

const selectedNodeView = computed(() => {
  if (!selectedNodeId.value || !currentGraph.value) return null
  const node = currentGraph.value.nodes.find((n) => n.id === selectedNodeId.value)
  if (!node) return null
  const inboundEdges = currentGraph.value.edges.filter((e) => e.target === node.id)
  const outboundEdges = currentGraph.value.edges.filter((e) => e.source === node.id)
  return {
    ...node,
    fragmentMeta: nodeMeta.value.get(node.id) || null,
    inbound: inboundEdges,
    outbound: outboundEdges,
  }
})

async function loadAll() {
  loading.value = true
  error.value = null
  try {
    const [pRes, dmRes] = await Promise.all([
      fetch('/api/meta/process'),
      fetch('/api/meta/data-model'),
    ])
    if (!pRes.ok) throw new Error(`process: HTTP ${pRes.status}`)
    if (!dmRes.ok) throw new Error(`data-model: HTTP ${dmRes.status}`)
    processData.value = await pRes.json()
    dataModelData.value = await dmRes.json()
    selectedNodeId.value = null
    await nextTick()
    render()
  } catch (e) {
    error.value = e.message
  } finally {
    loading.value = false
  }
}

function render() {
  if (!container.value || !currentGraph.value) return
  if (cy) {
    cy.destroy()
    cy = null
  }
  const elements = [
    ...currentGraph.value.nodes.map((n) => ({
      data: { id: n.id, label: n.name || n.id, classification: n.classification },
    })),
    ...currentGraph.value.edges.map((e, i) => ({
      data: {
        id: `${e.source}->${e.target}:${i}`,
        source: e.source,
        target: e.target,
        conditional: e.conditional ? 'true' : 'false',
      },
    })),
  ]
  cy = cytoscape({
    container: container.value,
    elements,
    style: STYLE,
    layout: {
      name: 'dagre',
      rankDir: 'TB',
      nodeSep: 40,
      rankSep: 60,
      padding: 20,
    },
    wheelSensitivity: 0.2,
    boxSelectionEnabled: false,
  })
  cy.on('tap', 'node', (evt) => {
    selectedNodeId.value = evt.target.id()
  })
  cy.on('tap', (evt) => {
    if (evt.target === cy) selectedNodeId.value = null
  })
}

function switchGraph(label) {
  activeGraph.value = label
  selectedNodeId.value = null
  nextTick(render)
}

const copied = ref(null)
async function copy(label, payload) {
  try {
    const text = typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
    await navigator.clipboard.writeText(text)
    copied.value = label
    setTimeout(() => {
      if (copied.value === label) copied.value = null
    }, 1500)
  } catch {
    /* noop */
  }
}

function exportMermaid() {
  if (!currentGraph.value?.mermaid) return
  copy('mermaid', currentGraph.value.mermaid)
}

function fitGraph() {
  if (cy) cy.fit(undefined, 30)
}

function fmtDate(v) {
  if (!v) return '—'
  return new Date(v).toLocaleString()
}

onMounted(loadAll)
onBeforeUnmount(() => {
  if (cy) {
    cy.destroy()
    cy = null
  }
})

// If the user switches graphs, re-render. (switchGraph handles this, but keep
// the watcher as a safety net for any direct activeGraph mutation.)
watch(activeGraph, () => nextTick(render))
</script>

<template>
  <section class="sheet">
    <div class="sheet-head-row">
      <div>
        <h2 class="sheet-title">Process</h2>
        <p class="sheet-sub">
          Live topology of the LangGraph state graph compiled in <code class="t-mono">server/graph/build.js</code>.
          Click a node to inspect its classification and observed I/O. Dashed edges are conditional routes.
        </p>
      </div>
      <div class="proc-head-actions">
        <button type="button" class="btn btn--ghost" :disabled="loading" @click="loadAll">
          <span class="material-symbols-outlined icon-sm">refresh</span>
          Reload
        </button>
        <button
          type="button"
          class="btn btn--ghost"
          :disabled="!currentGraph?.mermaid"
          :class="{ 'btn--success': copied === 'mermaid' }"
          @click="exportMermaid"
        >
          <span class="material-symbols-outlined icon-sm">content_copy</span>
          {{ copied === 'mermaid' ? 'Copied Mermaid' : 'Copy as Mermaid' }}
        </button>
      </div>
    </div>

    <div v-if="error" class="prompt-error">{{ error }}</div>

    <div v-if="processData" class="proc-tabs">
      <button
        v-for="g in processData.graphs"
        :key="g.label"
        type="button"
        :class="['proc-tab', { 'proc-tab--active': activeGraph === g.label }]"
        @click="switchGraph(g.label)"
      >
        {{ g.label === 'main' ? 'Full run' : 'Screening only' }}
        <span class="t-meta">— {{ g.nodes.length }} nodes / {{ g.edges.length }} edges</span>
      </button>
    </div>

    <div class="proc-layout">
      <div class="proc-canvas-frame">
        <div ref="container" class="proc-canvas" />
        <div class="proc-canvas-hint">Scroll to zoom · drag to pan</div>
        <button type="button" class="proc-fit btn btn--ghost btn--xs" @click="fitGraph">
          Fit
        </button>

        <ul class="proc-legend">
          <li><span class="proc-swatch proc-swatch--decision" /><span class="t-meta">Decision</span></li>
          <li><span class="proc-swatch proc-swatch--audit" /><span class="t-meta">Audit</span></li>
          <li><span class="proc-swatch proc-swatch--interrupt" /><span class="t-meta">Interrupt</span></li>
          <li><span class="proc-swatch proc-swatch--sentinel" /><span class="t-meta">START / END</span></li>
          <li><span class="proc-edge-key proc-edge-key--cond" /><span class="t-meta">Conditional edge</span></li>
        </ul>
      </div>

      <aside class="proc-panel">
        <template v-if="!selectedNodeView">
          <h3 class="proc-panel-empty-title">Click a node</h3>
          <p class="t-meta">
            Select any node in the graph to see its classification, observed input / output keys, and a
            link to the most recent fragment.
          </p>
        </template>
        <template v-else>
          <header class="proc-panel-head">
            <span :class="['dm-class-pill', `dm-class-pill--${selectedNodeView.classification}`]">
              {{ selectedNodeView.classification }}
            </span>
            <code class="t-mono proc-node-id">{{ selectedNodeView.id }}</code>
          </header>

          <section class="proc-panel-section">
            <span class="t-label">Graph connectivity</span>
            <div class="proc-edges">
              <div>
                <span class="t-meta">Inbound ({{ selectedNodeView.inbound.length }})</span>
                <ul class="proc-edge-list">
                  <li v-for="e in selectedNodeView.inbound" :key="`in-${e.source}`" class="t-mono">
                    {{ e.source }}{{ e.conditional ? ' (cond)' : '' }}
                  </li>
                  <li v-if="!selectedNodeView.inbound.length" class="t-meta">—</li>
                </ul>
              </div>
              <div>
                <span class="t-meta">Outbound ({{ selectedNodeView.outbound.length }})</span>
                <ul class="proc-edge-list">
                  <li v-for="e in selectedNodeView.outbound" :key="`out-${e.target}`" class="t-mono">
                    {{ e.target }}{{ e.conditional ? ' (cond)' : '' }}
                  </li>
                  <li v-if="!selectedNodeView.outbound.length" class="t-meta">—</li>
                </ul>
              </div>
            </div>
          </section>

          <section class="proc-panel-section">
            <span class="t-label">Observed I/O</span>
            <template v-if="selectedNodeView.fragmentMeta">
              <div class="proc-io-block">
                <span class="t-meta">Input keys ({{ selectedNodeView.fragmentMeta.observedInputKeys.length }})</span>
                <div>
                  <code
                    v-for="k in selectedNodeView.fragmentMeta.observedInputKeys"
                    :key="`in-${k}`"
                    class="dm-chip t-mono"
                  >{{ k }}</code>
                  <span v-if="!selectedNodeView.fragmentMeta.observedInputKeys.length" class="t-meta">—</span>
                </div>
              </div>
              <div class="proc-io-block">
                <span class="t-meta">Output keys ({{ selectedNodeView.fragmentMeta.observedOutputKeys.length }})</span>
                <div>
                  <code
                    v-for="k in selectedNodeView.fragmentMeta.observedOutputKeys"
                    :key="`out-${k}`"
                    class="dm-chip t-mono"
                  >{{ k }}</code>
                  <span v-if="!selectedNodeView.fragmentMeta.observedOutputKeys.length" class="t-meta">—</span>
                </div>
              </div>
              <div class="proc-stat-row">
                <span class="t-meta">Runs sampled: <span class="tabular">{{ selectedNodeView.fragmentMeta.occurrences }}</span></span>
                <span class="t-meta">Last seen: <span class="tabular">{{ fmtDate(selectedNodeView.fragmentMeta.lastSeenAt) }}</span></span>
              </div>
            </template>
            <p v-else class="t-meta">
              No fragments captured yet for this node — run a dossier and reload.
            </p>
          </section>

          <section v-if="selectedNodeView.fragmentMeta?.sample" class="proc-panel-section">
            <span class="t-label">Most recent sample</span>
            <div class="proc-sample-summary">{{ selectedNodeView.fragmentMeta.sample.summary }}</div>
            <details>
              <summary class="t-meta">Show full inputs / outputs</summary>
              <div class="proc-sample-cols">
                <div>
                  <span class="t-meta">Inputs</span>
                  <pre class="proc-sample-json t-mono">{{ JSON.stringify(selectedNodeView.fragmentMeta.sample.inputs, null, 2) }}</pre>
                </div>
                <div>
                  <span class="t-meta">Outputs</span>
                  <pre class="proc-sample-json t-mono">{{ JSON.stringify(selectedNodeView.fragmentMeta.sample.outputs, null, 2) }}</pre>
                </div>
              </div>
            </details>
          </section>
        </template>
      </aside>
    </div>
  </section>
</template>

<style scoped>
.sheet {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--sp-8);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.sheet-title { margin: 0; font-family: var(--font-display); font-size: 18px; font-weight: 600; color: var(--color-text-primary); }
.sheet-sub { margin: -8px 0 var(--sp-2); color: var(--color-text-secondary); font-size: var(--fs-meta); }
.sheet-head-row { display: flex; justify-content: space-between; align-items: flex-start; gap: var(--sp-4); }
.proc-head-actions { display: flex; gap: var(--sp-2); }

.prompt-error {
  padding: var(--sp-3);
  background: rgba(220, 53, 69, 0.08);
  border: 1px solid rgba(220, 53, 69, 0.25);
  border-radius: var(--radius-md);
  color: var(--color-danger, #b00020);
  font-size: var(--fs-meta);
}

.btn--xs { padding: 3px var(--sp-2); font-size: 11px; border-radius: var(--radius-sm); }
.btn--success { background: var(--color-success-soft); color: var(--color-success); }

.proc-tabs {
  display: flex;
  gap: var(--sp-1);
  border-bottom: 1px solid var(--color-border);
}
.proc-tab {
  background: transparent;
  border: 0;
  padding: var(--sp-2) var(--sp-3);
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  cursor: pointer;
  font: inherit;
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--color-text-secondary);
}
.proc-tab--active {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
}

.proc-layout {
  display: grid;
  grid-template-columns: 1fr 340px;
  gap: var(--sp-4);
  align-items: stretch;
}

.proc-canvas-frame {
  position: relative;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--color-page);
}
.proc-canvas {
  width: 100%;
  height: 620px;
  background: var(--color-page);
  background-image: radial-gradient(circle, rgba(16, 20, 24, 0.05) 1px, transparent 1px);
  background-size: 16px 16px;
  background-position: 8px 8px;
}
.proc-canvas-hint {
  position: absolute;
  bottom: var(--sp-3);
  right: var(--sp-3);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-tertiary);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-pill);
  padding: 4px var(--sp-3);
}
.proc-fit {
  position: absolute;
  top: var(--sp-3);
  right: var(--sp-3);
}
.proc-legend {
  position: absolute;
  bottom: var(--sp-3);
  left: var(--sp-3);
  display: flex;
  flex-direction: column;
  gap: 4px;
  list-style: none;
  margin: 0;
  padding: var(--sp-2) var(--sp-3);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 11px;
}
.proc-legend li { display: flex; align-items: center; gap: var(--sp-2); }
.proc-swatch {
  width: 14px;
  height: 10px;
  border: 1px solid var(--color-border);
  border-radius: 3px;
}
.proc-swatch--decision { background: #E8EEFB; border-color: #0B3D91; }
.proc-swatch--audit { background: #FFFFFF; border-color: #C9CDD3; }
.proc-swatch--interrupt { background: #FBF1E1; border-color: #B45309; }
.proc-swatch--sentinel { background: #F2F2EE; border-color: #C9CDD3; border-radius: 50%; }
.proc-edge-key { width: 18px; height: 0; border-top: 2px dashed #B45309; }

/* Panel */
.proc-panel {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-page);
  padding: var(--sp-4);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
  max-height: 644px;
  overflow: auto;
}
.proc-panel-empty-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 14px;
  font-weight: 600;
  color: var(--color-text-primary);
}
.proc-panel-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding-bottom: var(--sp-2);
  border-bottom: 1px solid var(--color-border);
}
.proc-node-id { font-size: 13px; color: var(--color-text-primary); font-weight: 600; }
.proc-panel-section {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}

.dm-class-pill {
  display: inline-block;
  padding: 2px var(--sp-2);
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  background: var(--color-surface-sunken);
  color: var(--color-text-secondary);
}
.dm-class-pill--decision { background: var(--color-primary-soft); color: var(--color-primary); }
.dm-class-pill--audit { background: var(--color-surface-sunken); color: var(--color-text-secondary); }
.dm-class-pill--interrupt { background: var(--color-tertiary-soft, #FBF1E1); color: var(--color-tertiary, #B45309); }
.dm-class-pill--sentinel { background: var(--color-surface-sunken); color: var(--color-text-tertiary); }

.proc-edges {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-3);
}
.proc-edge-list {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  font-size: 11px;
  line-height: 1.6;
}

.proc-io-block { display: flex; flex-direction: column; gap: 4px; }
.dm-chip {
  display: inline-block;
  padding: 1px 6px;
  margin: 1px 4px 1px 0;
  background: var(--color-surface-sunken);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 11px;
  color: var(--color-text-secondary);
}
.proc-stat-row { display: flex; justify-content: space-between; padding-top: var(--sp-1); }

.proc-sample-summary {
  padding: var(--sp-2);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: var(--fs-meta);
}
.proc-sample-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}
.proc-sample-json {
  margin: 4px 0 0;
  padding: var(--sp-2);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  font-size: 11px;
  line-height: 1.5;
  color: var(--color-text-secondary);
  overflow: auto;
  max-height: 220px;
}

@media (max-width: 1100px) {
  .proc-layout { grid-template-columns: 1fr; }
  .proc-panel { max-height: none; }
}
</style>
