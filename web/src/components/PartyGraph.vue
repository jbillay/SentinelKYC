<script setup>
// Phase 5 — Cross-dossier party graph (Cytoscape).
//
// Renders the payload from GET /api/parties/:id/graph. Node kinds we
// expect: 'individual', 'organisation', 'dossier'. Edges carry the
// party_links shape (role, status, dates) — different schema from the
// existing ShareholderGraph component, hence a separate file.

import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import cytoscape from 'cytoscape'
import dagre from 'cytoscape-dagre'

cytoscape.use(dagre)

const router = useRouter()
const props = defineProps({
  graph: { type: Object, required: true },
})

const hasGraph = computed(
  () => (props.graph?.nodes?.length || 0) > 0,
)

const container = ref(null)
let cy = null

// Match the existing ShareholderGraph palette so the two graphs read as
// a family. Centre party gets a distinctive accent so it's obvious
// where the user "is" in the network.
const TOKENS = {
  primary: '#0B3D91',
  primarySoft: '#E8EEFB',
  accent: '#4f46e5',
  accentSoft: '#ede9fe',
  surface: '#FFFFFF',
  border: '#E4E4DC',
  borderStrong: '#C9CDD3',
  textPrimary: '#101418',
  textSecondary: '#475569',
  textTertiary: '#737A82',
  warn: '#92400e',
  warnSoft: '#fef3c7',
  danger: '#991b1b',
  dangerSoft: '#fee2e2',
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
      'font-size': 12,
      'font-weight': 500,
      'text-wrap': 'wrap',
      'text-max-width': 160,
      color: TOKENS.textPrimary,
      'border-width': 1,
      width: 'label',
      height: 'label',
      padding: '12px',
      shape: 'round-rectangle',
      'background-color': TOKENS.surface,
      'border-color': TOKENS.borderStrong,
      'corner-radius': 8,
    },
  },
  {
    // Centre (current) party — stands out.
    selector: 'node[?isCenter]',
    style: {
      'background-color': TOKENS.accent,
      'border-color': TOKENS.accent,
      color: '#FFFFFF',
      'font-weight': 700,
      'border-width': 2,
    },
  },
  {
    // Other individuals on linked dossiers.
    selector: 'node[kind = "individual"]:not([?isCenter])',
    style: {
      'background-color': TOKENS.surface,
      'border-color': TOKENS.borderStrong,
      color: TOKENS.textPrimary,
    },
  },
  {
    // Corporate parties on linked dossiers.
    selector: 'node[kind = "organisation"]:not([?isCenter])',
    style: {
      'background-color': TOKENS.warnSoft,
      'border-color': TOKENS.warn,
      color: TOKENS.warn,
    },
  },
  {
    selector: 'node[kind = "dossier"]',
    style: {
      'background-color': TOKENS.primary,
      'border-color': TOKENS.primary,
      color: '#FFFFFF',
      'font-weight': 600,
    },
  },
  {
    // Parties flagged needs_review get a red border.
    selector: 'node[?needsReview]:not([?isCenter])',
    style: {
      'border-color': TOKENS.danger,
      'border-width': 2,
    },
  },
  {
    selector: 'edge',
    style: {
      width: 1,
      'line-color': TOKENS.borderStrong,
      'target-arrow-color': TOKENS.borderStrong,
      'target-arrow-shape': 'triangle',
      'arrow-scale': 0.8,
      'curve-style': 'bezier',
      label: 'data(role)',
      'font-family': 'JetBrains Mono, ui-monospace, monospace',
      'font-size': 10,
      color: TOKENS.textSecondary,
      'text-background-color': TOKENS.page,
      'text-background-opacity': 1,
      'text-background-padding': 3,
      'text-background-shape': 'round-rectangle',
    },
  },
  {
    selector: 'edge[role = "officer"]',
    style: {
      'line-style': 'dashed',
      'line-dash-pattern': [6, 4],
      'line-color': TOKENS.textTertiary,
      'target-arrow-color': TOKENS.textTertiary,
    },
  },
  {
    selector: 'edge[role = "psc"]',
    style: {
      width: 1.5,
      'line-color': TOKENS.primary,
      'target-arrow-color': TOKENS.primary,
    },
  },
  {
    selector: 'edge[role = "shareholder"]',
    style: {
      width: 1.5,
      'line-color': TOKENS.accent,
      'target-arrow-color': TOKENS.accent,
    },
  },
  {
    // Historical / resigned / ceased: dim the edge.
    selector: 'edge[status != "active"]',
    style: {
      opacity: 0.45,
    },
  },
]

function render() {
  if (!container.value) return
  if (cy) {
    cy.destroy()
    cy = null
  }

  const elements = [
    ...(props.graph.nodes || []),
    ...(props.graph.edges || []),
  ]

  cy = cytoscape({
    container: container.value,
    elements,
    style: STYLE,
    layout: {
      name: 'dagre',
      rankDir: 'LR',
      nodeSep: 40,
      rankSep: 80,
      padding: 24,
    },
    wheelSensitivity: 0.2,
  })

  // Click-through: tapping a non-centre party node navigates to that
  // party's detail page. Dossier nodes navigate to the dossier.
  cy.on('tap', 'node', (evt) => {
    const data = evt.target.data()
    if (!data) return
    if (data.kind === 'dossier' && data.companyNumber) {
      router.push({ name: 'dossier', params: { companyNumber: data.companyNumber } })
    } else if ((data.kind === 'individual' || data.kind === 'organisation') && data.partyId && !data.isCenter) {
      router.push({ name: 'party-detail', params: { partyId: data.partyId } })
    }
  })
}

onMounted(render)

watch(
  () => props.graph,
  () => render(),
  { deep: false },
)

onBeforeUnmount(() => {
  if (cy) {
    cy.destroy()
    cy = null
  }
})
</script>

<template>
  <div class="wrap">
    <div v-if="!hasGraph" class="empty">
      <span class="empty-title">No network</span>
      <span class="empty-hint">This party isn't linked to any dossier yet.</span>
    </div>
    <div v-else class="canvas-frame">
      <div ref="container" class="canvas" />
      <div class="canvas-hint">Scroll to zoom · drag to pan · click a node to navigate</div>
      <div v-if="graph?.counts?.truncated" class="canvas-warn">
        Truncated at {{ graph.limit }} nodes — increase the limit to see more.
      </div>
    </div>

    <ul class="legend">
      <li>
        <span class="swatch swatch--center" />
        <span class="t-label">This party (centre)</span>
      </li>
      <li>
        <span class="swatch swatch--dossier" />
        <span class="t-label">Dossier</span>
      </li>
      <li>
        <span class="swatch swatch--individual" />
        <span class="t-label">Other individual</span>
      </li>
      <li>
        <span class="swatch swatch--organisation" />
        <span class="t-label">Other organisation</span>
      </li>
      <li>
        <span class="edge-key edge-key--officer" />
        <span class="t-label">Officer</span>
      </li>
      <li>
        <span class="edge-key edge-key--psc" />
        <span class="t-label">PSC</span>
      </li>
      <li>
        <span class="edge-key edge-key--shareholder" />
        <span class="t-label">Shareholder</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.wrap {
  display: flex;
  flex-direction: column;
  gap: var(--sp-3, 12px);
}
.canvas-frame {
  position: relative;
  border: 1px solid #E4E4DC;
  border-radius: 8px;
  background: #F7F7F5;
  overflow: hidden;
}
.canvas {
  width: 100%;
  height: 520px;
}
.canvas-hint {
  position: absolute;
  bottom: 8px;
  right: 12px;
  font-size: 11px;
  color: #737A82;
  background: rgba(255,255,255,0.85);
  padding: 2px 8px;
  border-radius: 4px;
}
.canvas-warn {
  position: absolute;
  top: 8px;
  left: 12px;
  font-size: 11px;
  color: #92400e;
  background: #fef3c7;
  padding: 2px 8px;
  border-radius: 4px;
}
.empty {
  padding: 60px 24px;
  text-align: center;
  border: 1px dashed #C9CDD3;
  border-radius: 8px;
  background: #FFF;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.empty-title { font-weight: 600; }
.empty-hint { color: #737A82; font-size: 0.9em; }

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: 12px 16px;
  padding: 8px 0;
  list-style: none;
  margin: 0;
}
.legend li { display: inline-flex; align-items: center; gap: 6px; }
.swatch { display: inline-block; width: 14px; height: 14px; border-radius: 3px; border: 1px solid #C9CDD3; }
.swatch--center { background: #4f46e5; border-color: #4f46e5; }
.swatch--dossier { background: #0B3D91; border-color: #0B3D91; }
.swatch--individual { background: #FFFFFF; border-color: #C9CDD3; }
.swatch--organisation { background: #fef3c7; border-color: #92400e; }
.edge-key { display: inline-block; width: 22px; height: 2px; background: #737A82; }
.edge-key--officer { border-top: 2px dashed #737A82; background: transparent; }
.edge-key--psc { background: #0B3D91; height: 2px; }
.edge-key--shareholder { background: #4f46e5; height: 2px; }
.t-label { font-size: 11px; color: #475569; }
</style>
