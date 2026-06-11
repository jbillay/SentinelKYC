<script setup>
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
  () => (props.graph?.edges?.length || 0) > 0 || (props.graph?.nodes?.length || 0) > 1
)

const container = ref(null)
let cy = null

// Pulled from CSS tokens — keep in sync with tokens.css
const TOKENS = {
  primary: '#0B3D91',
  primarySoft: '#E8EEFB',
  surface: '#FFFFFF',
  border: '#E4E4DC',
  borderStrong: '#C9CDD3',
  textPrimary: '#101418',
  textSecondary: '#475569',
  textTertiary: '#737A82',
  tertiarySoft: '#FBF1E1',
  tertiary: '#B45309',
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
    selector: 'node[kind = "company"]',
    style: {
      'background-color': TOKENS.primary,
      'border-color': TOKENS.primary,
      color: '#FFFFFF',
      'font-weight': 600,
    },
  },
  {
    selector: 'node[kind = "individual"]',
    style: {
      'background-color': TOKENS.surface,
      'border-color': TOKENS.borderStrong,
      color: TOKENS.textPrimary,
    },
  },
  {
    selector: 'node[kind = "corporate"]',
    style: {
      'background-color': TOKENS.tertiarySoft,
      'border-color': TOKENS.tertiary,
      color: TOKENS.tertiary,
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
      label: 'data(label)',
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
    selector: 'edge[rel = "owns"]',
    style: {
      width: 1.5,
      'line-color': TOKENS.primary,
      'target-arrow-color': TOKENS.primary,
    },
  },
  {
    selector: 'edge[rel = "officer"]',
    style: {
      'line-style': 'dashed',
      'line-dash-pattern': [6, 4],
      'line-color': TOKENS.textTertiary,
      'target-arrow-color': TOKENS.textTertiary,
      color: TOKENS.textTertiary,
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
      rankDir: 'BT',
      nodeSep: 50,
      rankSep: 70,
      padding: 24,
    },
    wheelSensitivity: 0.2,
  })

  // Phase 5 — click-through. After the resolver runs, person/corporate
  // nodes have ids of the form `party:<uuid>` (see resolveParties.js).
  // Clicking one takes the user to the party detail page so they can
  // see this person's footprint across the rest of the book.
  cy.on('tap', 'node', (evt) => {
    const id = evt.target.id()
    if (typeof id === 'string' && id.startsWith('party:')) {
      const partyId = id.slice('party:'.length)
      if (partyId) router.push({ name: 'party-detail', params: { partyId } })
    }
  })
}

onMounted(render)

watch(
  () => props.graph,
  () => render(),
  { deep: false }
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
      <span class="empty-title">No entity graph</span>
      <span class="empty-hint">No active officers, PSC entries, or shareholder data found for this company.</span>
    </div>
    <div v-else class="canvas-frame">
      <div ref="container" class="canvas" />
      <div class="canvas-hint">Scroll to zoom · drag to pan</div>
    </div>

    <ul class="legend">
      <li>
        <span class="swatch swatch--company" />
        <span class="t-label">Subject company</span>
      </li>
      <li>
        <span class="swatch swatch--individual" />
        <span class="t-label">Individual</span>
      </li>
      <li>
        <span class="swatch swatch--corporate" />
        <span class="t-label">Corporate entity</span>
      </li>
      <li>
        <span class="edge-key edge-key--owns" />
        <span class="t-label">Ownership / control</span>
      </li>
      <li>
        <span class="edge-key edge-key--officer" />
        <span class="t-label">Officer / director</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.wrap {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.canvas-frame {
  position: relative;
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--color-page);
}
.canvas {
  width: 100%;
  height: 520px;
  background: var(--color-page);
  background-image:
    radial-gradient(circle, rgba(16, 20, 24, 0.05) 1px, transparent 1px);
  background-size: 16px 16px;
  background-position: 8px 8px;
}
.canvas-hint {
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

.empty {
  padding: var(--sp-12) var(--sp-6);
  text-align: center;
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-md);
  background: var(--color-page);
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  align-items: center;
}
.empty-title {
  font-size: var(--fs-title);
  font-weight: 600;
  color: var(--color-text-secondary);
}
.empty-hint {
  font-size: var(--fs-meta);
  color: var(--color-text-tertiary);
  max-width: 48ch;
}

.legend {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-6);
  list-style: none;
  margin: 0;
  padding: 0;
}
.legend li {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
}
.legend .t-label {
  text-transform: none;
  letter-spacing: 0.02em;
  color: var(--color-text-secondary);
  font-size: var(--fs-meta);
  font-weight: 500;
}

.swatch {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  border: 1px solid var(--color-border-strong);
  background: var(--color-surface);
  flex-shrink: 0;
}
.swatch--company {
  background: var(--color-primary);
  border-color: var(--color-primary);
}
.swatch--individual {
  background: var(--color-surface);
  border-color: var(--color-border-strong);
}
.swatch--corporate {
  background: var(--color-tertiary-soft);
  border-color: var(--color-tertiary);
}

.edge-key {
  width: 22px;
  height: 0;
  flex-shrink: 0;
  border-top-width: 2px;
  border-top-style: solid;
}
.edge-key--owns {
  border-top-color: var(--color-primary);
}
.edge-key--officer {
  border-top-style: dashed;
  border-top-color: var(--color-text-tertiary);
}
</style>
