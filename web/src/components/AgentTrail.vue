<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps({
  fragments: { type: Array, required: true },
  isRunning: { type: Boolean, default: false },
  // 'live' shows pending steps + ticking active step. 'historic' shows only what happened.
  mode: { type: String, default: 'live' },
})

const STEPS = [
  { node: 'gather_input', label: 'Gather input' },
  { node: 'search_ch', label: 'Search Companies House' },
  { node: 'entity_resolution', label: 'Entity resolution' },
  { node: 'await_confirmation', label: 'Confirm company' },
  { node: 'fetch_apis', label: 'Fetch profile, officers, PSC, filings' },
  { node: 'select_documents', label: 'Select documents' },
  { node: 'download_documents', label: 'Download PDFs' },
  { node: 'process_documents', label: 'OCR + extract' },
  { node: 'synthesize_card', label: 'Synthesize KYC card' },
  { node: 'compile_screening_list', label: 'Compile screening subjects' },
  { node: 'screen_sanctions', label: 'Screen sanctions lists' },
  { node: 'evaluate_sanctions_hits', label: 'Evaluate sanctions hits' },
  { node: 'screen_adverse_media', label: 'Screen adverse media' },
  { node: 'evaluate_adverse_media', label: 'Evaluate adverse media' },
  { node: 'compile_screening_report', label: 'Compile screening report' },
  { node: 'assess_risk', label: 'Assess risk' },
  { node: 'qa_check', label: 'QA check' },
  { node: 'qa_narrative', label: 'QA narrative' },
]

const expanded = ref(new Set())
const childrenExpanded = ref(new Set())
const childrenOverflow = ref(new Set())
const CHILD_VIRTUALISATION_THRESHOLD = 50
const CHILD_INITIAL_VISIBLE = 20

function toggle(id) {
  const next = new Set(expanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  expanded.value = next
}

function isExpanded(id) {
  return expanded.value.has(id)
}

function toggleChildren(id) {
  const next = new Set(childrenExpanded.value)
  if (next.has(id)) next.delete(id)
  else next.add(id)
  childrenExpanded.value = next
}

function areChildrenExpanded(id) {
  return childrenExpanded.value.has(id)
}

function showAllChildren(id) {
  const next = new Set(childrenOverflow.value)
  next.add(id)
  childrenOverflow.value = next
}

function isChildrenExpanded(id) {
  return childrenOverflow.value.has(id)
}

const now = ref(Date.now())
let timer = null

function startTicker() {
  if (timer) return
  timer = setInterval(() => {
    now.value = Date.now()
  }, 1000)
}
function stopTicker() {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}

watch(
  () => props.isRunning && props.mode === 'live',
  (active) => {
    if (active) startTicker()
    else stopTicker()
  },
  { immediate: true }
)

onBeforeUnmount(stopTicker)

function fmtNode(nodeId) {
  if (!nodeId) return ''
  return nodeId.replace(/_/g, ' ')
}

function fmtDuration(ms) {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return s ? `${m}m ${s}s` : `${m}m`
}

function jsonPreview(obj) {
  if (obj == null) return ''
  try {
    return JSON.stringify(obj, null, 2)
  } catch {
    return String(obj)
  }
}

const orderedAll = computed(() =>
  [...props.fragments].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
)

// Top-level rows: fragments without a parent.
const ordered = computed(() =>
  orderedAll.value.filter((f) => !f.parentFragmentId)
)

// Map of parent id -> child fragments (sorted by sequence).
const childrenByParent = computed(() => {
  const map = new Map()
  for (const f of orderedAll.value) {
    if (!f.parentFragmentId) continue
    if (!map.has(f.parentFragmentId)) map.set(f.parentFragmentId, [])
    map.get(f.parentFragmentId).push(f)
  }
  return map
})

function getChildren(parentId) {
  return childrenByParent.value.get(parentId) || []
}

function visibleChildren(parentId) {
  const all = getChildren(parentId)
  if (all.length <= CHILD_VIRTUALISATION_THRESHOLD) return all
  if (isChildrenExpanded(parentId)) return all
  return all.slice(0, CHILD_INITIAL_VISIBLE)
}

function hiddenChildCount(parentId) {
  const all = getChildren(parentId)
  if (all.length <= CHILD_VIRTUALISATION_THRESHOLD) return 0
  if (isChildrenExpanded(parentId)) return 0
  return all.length - CHILD_INITIAL_VISIBLE
}

function childCounts(parentId) {
  const out = { confirmed: 0, dismissed: 0, needs_review: 0, failed: 0 }
  for (const c of getChildren(parentId)) {
    if (c.status === 'failed') {
      out.failed += 1
      continue
    }
    const d = c.outputs?.decision
    if (d && out[d] != null) out[d] += 1
  }
  return out
}

// Last fragment ts per node, for deriving "active" step. Top-level only —
// nested children share their parent's nodeId so they don't shift the timeline.
const lastTsByNode = computed(() => {
  const map = new Map()
  for (const f of ordered.value) {
    const ts = f.startedAt
      ? new Date(f.startedAt).getTime() + (f.durationMs ?? 0)
      : 0
    map.set(f.nodeId, Math.max(map.get(f.nodeId) || 0, ts))
  }
  return map
})

// Compute index of furthest step that has at least one fragment.
const maxFragIdx = computed(() => {
  let max = -1
  STEPS.forEach((s, i) => {
    if (lastTsByNode.value.has(s.node)) max = i
  })
  return max
})

// Derived "active" step (the next pending one) for live mode.
const activeIdx = computed(() => {
  if (props.mode !== 'live' || !props.isRunning) return -1
  return Math.min(maxFragIdx.value + 1, STEPS.length - 1)
})

// Build a unified row list: all fragments in order, with synthetic "pending"
// rows appended for steps not yet emitted (live mode only).
const rows = computed(() => {
  const out = ordered.value.map((f) => ({ kind: 'fragment', frag: f }))
  if (props.mode === 'live') {
    for (let i = maxFragIdx.value + 1; i < STEPS.length; i++) {
      const s = STEPS[i]
      const isActive = i === activeIdx.value
      out.push({ kind: 'pending', step: s, active: isActive, idx: i })
    }
  }
  return out
})

const activeDuration = computed(() => {
  if (activeIdx.value < 0) return null
  // Time since last fragment (approx wall-clock for the active step).
  let lastTs = 0
  for (const ts of lastTsByNode.value.values()) {
    if (ts > lastTs) lastTs = ts
  }
  if (!lastTs) return null
  return now.value - lastTs
})
</script>

<template>
  <div class="agent-trail">
    <ol v-if="rows.length" class="timeline">
      <template v-for="row in rows" :key="row.kind === 'fragment' ? row.frag.id : `pending-${row.idx}`">
        <li
          v-if="row.kind === 'fragment'"
          :class="['frag', `frag--${row.frag.kind}`, `frag--status-${row.frag.status}`]"
        >
          <button
            type="button"
            class="frag-summary"
            :aria-expanded="isExpanded(row.frag.id)"
            @click="toggle(row.frag.id)"
          >
            <span class="frag-marker" :class="`frag-marker--${row.frag.kind}`" aria-hidden="true">
              <span v-if="row.frag.kind === 'human_action'" class="material-symbols-outlined icon-sm">person</span>
              <span v-else-if="row.frag.kind === 'decision'" class="material-symbols-outlined icon-sm">flag</span>
              <span v-else-if="row.frag.status === 'failed'" class="material-symbols-outlined icon-sm">close</span>
              <span v-else-if="row.frag.status === 'skipped'" class="material-symbols-outlined icon-sm">remove</span>
              <span v-else class="material-symbols-outlined icon-sm">check</span>
            </span>
            <div class="frag-body">
              <div class="frag-meta">
                <span class="frag-node t-label">{{ fmtNode(row.frag.nodeId) }}</span>
                <span :class="['frag-kind-pill', `frag-kind-pill--${row.frag.kind}`]">
                  {{ row.frag.kind === 'human_action' ? 'human action' : row.frag.kind }}
                </span>
                <span
                  v-if="row.frag.kind === 'human_action' && row.frag.inputs?.action"
                  :class="['frag-action-pill', `frag-action-pill--${row.frag.inputs.action}`]"
                >
                  {{ row.frag.inputs.action.replace('_', ' ') }}
                </span>
                <span v-if="row.frag.status !== 'ok'" :class="['frag-status-pill', `frag-status-pill--${row.frag.status}`]">
                  {{ row.frag.status }}
                </span>
                <span class="frag-duration tabular">{{ fmtDuration(row.frag.durationMs) }}</span>
              </div>
              <p class="frag-text">{{ row.frag.summary }}</p>
              <p v-if="row.frag.error" class="frag-error t-mono">{{ row.frag.error }}</p>
            </div>
            <span
              class="material-symbols-outlined icon-sm frag-chevron"
              :class="{ 'frag-chevron--open': isExpanded(row.frag.id) }"
              aria-hidden="true"
            >expand_more</span>
          </button>

          <div v-if="isExpanded(row.frag.id)" class="frag-detail">
            <div v-if="row.frag.inputs" class="frag-section">
              <span class="t-label frag-section-label">Inputs</span>
              <pre class="frag-json">{{ jsonPreview(row.frag.inputs) }}</pre>
            </div>
            <div v-if="row.frag.outputs" class="frag-section">
              <span class="t-label frag-section-label">Outputs</span>
              <pre class="frag-json">{{ jsonPreview(row.frag.outputs) }}</pre>
            </div>
            <div class="frag-section frag-section--meta">
              <span class="t-mono">id {{ row.frag.id?.slice(0, 8) }}</span>
              <span class="t-mono">seq {{ row.frag.sequence }}</span>
              <span v-if="row.frag.startedAt" class="t-mono">{{ new Date(row.frag.startedAt).toLocaleTimeString() }}</span>
            </div>
          </div>

          <div v-if="getChildren(row.frag.id).length" class="frag-children">
            <button
              type="button"
              class="frag-children-toggle"
              :aria-expanded="areChildrenExpanded(row.frag.id)"
              @click="toggleChildren(row.frag.id)"
            >
              <span
                class="material-symbols-outlined icon-sm frag-chevron"
                :class="{ 'frag-chevron--open': areChildrenExpanded(row.frag.id) }"
                aria-hidden="true"
              >expand_more</span>
              <span class="t-label">{{ getChildren(row.frag.id).length }} nested decision{{ getChildren(row.frag.id).length === 1 ? '' : 's' }}</span>
              <span class="frag-children-counts">
                <span v-if="childCounts(row.frag.id).confirmed" class="frag-count-pill frag-count-pill--confirmed">{{ childCounts(row.frag.id).confirmed }} confirmed</span>
                <span v-if="childCounts(row.frag.id).needs_review" class="frag-count-pill frag-count-pill--review">{{ childCounts(row.frag.id).needs_review }} review</span>
                <span v-if="childCounts(row.frag.id).dismissed" class="frag-count-pill frag-count-pill--dismissed">{{ childCounts(row.frag.id).dismissed }} dismissed</span>
                <span v-if="childCounts(row.frag.id).failed" class="frag-count-pill frag-count-pill--failed">{{ childCounts(row.frag.id).failed }} failed</span>
              </span>
            </button>

            <ol v-if="areChildrenExpanded(row.frag.id)" class="frag-child-list">
              <li
                v-for="child in visibleChildren(row.frag.id)"
                :key="child.id"
                :class="['frag', 'frag--child', `frag--${child.kind}`, `frag--status-${child.status}`]"
              >
                <button
                  type="button"
                  class="frag-summary frag-summary--child"
                  :aria-expanded="isExpanded(child.id)"
                  @click="toggle(child.id)"
                >
                  <span class="frag-marker frag-marker--child" :class="`frag-marker--decision`" aria-hidden="true">
                    <span v-if="child.status === 'failed'" class="material-symbols-outlined icon-sm">close</span>
                    <span v-else class="material-symbols-outlined icon-sm">flag</span>
                  </span>
                  <div class="frag-body">
                    <div class="frag-meta">
                      <span
                        v-if="child.outputs?.decision"
                        :class="['frag-decision-pill', `frag-decision-pill--${child.outputs.decision}`]"
                      >{{ child.outputs.decision.replace('_', ' ') }}</span>
                      <span v-else-if="child.status === 'failed'" class="frag-decision-pill frag-decision-pill--failed">failed</span>
                      <span class="frag-duration tabular">{{ fmtDuration(child.durationMs) }}</span>
                    </div>
                    <p class="frag-text">{{ child.summary }}</p>
                    <p v-if="child.error" class="frag-error t-mono">{{ child.error }}</p>
                  </div>
                  <span
                    class="material-symbols-outlined icon-sm frag-chevron"
                    :class="{ 'frag-chevron--open': isExpanded(child.id) }"
                    aria-hidden="true"
                  >expand_more</span>
                </button>

                <div v-if="isExpanded(child.id)" class="frag-detail frag-detail--child">
                  <div v-if="child.outputs?.reasoning" class="frag-section">
                    <span class="t-label frag-section-label">Reasoning</span>
                    <p class="frag-reasoning">{{ child.outputs.reasoning }}</p>
                  </div>
                  <div v-if="child.outputs?.matchedFields?.length" class="frag-section frag-section--inline">
                    <span class="t-label frag-section-label">Matched</span>
                    <span v-for="m in child.outputs.matchedFields" :key="m" class="frag-field-pill frag-field-pill--matched">{{ m }}</span>
                  </div>
                  <div v-if="child.outputs?.conflictingFields?.length" class="frag-section frag-section--inline">
                    <span class="t-label frag-section-label">Conflicts</span>
                    <span v-for="m in child.outputs.conflictingFields" :key="m" class="frag-field-pill frag-field-pill--conflict">{{ m }}</span>
                  </div>
                  <div v-if="child.inputs" class="frag-section">
                    <span class="t-label frag-section-label">Inputs</span>
                    <pre class="frag-json">{{ jsonPreview(child.inputs) }}</pre>
                  </div>
                  <div v-if="child.outputs" class="frag-section">
                    <span class="t-label frag-section-label">Outputs</span>
                    <pre class="frag-json">{{ jsonPreview(child.outputs) }}</pre>
                  </div>
                </div>
              </li>
              <li v-if="hiddenChildCount(row.frag.id)" class="frag-children-overflow">
                <button type="button" class="frag-children-overflow-btn" @click="showAllChildren(row.frag.id)">
                  Show all {{ getChildren(row.frag.id).length }} ({{ hiddenChildCount(row.frag.id) }} hidden)
                </button>
              </li>
            </ol>
          </div>
        </li>

        <li
          v-else
          :class="['frag', 'frag--pending', { 'frag--active': row.active }]"
          aria-hidden="true"
        >
          <span class="frag-marker frag-marker--pending">
            <span v-if="row.active" class="spinner spinner--sm" aria-hidden="true"></span>
          </span>
          <div class="frag-body">
            <div class="frag-meta">
              <span class="frag-node t-label">{{ fmtNode(row.step.node) }}</span>
              <span v-if="row.active" class="frag-kind-pill frag-kind-pill--active">running</span>
              <span v-else class="frag-kind-pill frag-kind-pill--pending">pending</span>
              <span v-if="row.active && activeDuration" class="frag-duration tabular">
                {{ fmtDuration(activeDuration) }}
              </span>
            </div>
            <p class="frag-text frag-text--muted">{{ row.step.label }}</p>
          </div>
        </li>
      </template>
    </ol>

    <div v-else class="empty">
      <span class="t-meta">No fragments yet — start a run to populate the trail.</span>
    </div>
  </div>
</template>

<style scoped>
.agent-trail {
  display: flex;
  flex-direction: column;
}

.timeline {
  list-style: none;
  margin: 0;
  padding: 0 0 0 var(--sp-2);
  display: flex;
  flex-direction: column;
  position: relative;
}
.timeline::before {
  content: '';
  position: absolute;
  left: 11px;
  top: 18px;
  bottom: 18px;
  width: 1px;
  background: var(--color-border);
}

.frag {
  position: relative;
  padding: var(--sp-2) 0 var(--sp-3);
}
.frag-summary {
  display: grid;
  grid-template-columns: 24px 1fr auto;
  gap: var(--sp-3);
  align-items: flex-start;
  width: 100%;
  background: transparent;
  border: 0;
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--radius-md);
  cursor: pointer;
  text-align: left;
  transition: background-color var(--dur-fast) var(--ease);
}
.frag-summary:hover {
  background: var(--color-page);
}

.frag--pending {
  display: grid;
  grid-template-columns: 24px 1fr;
  gap: var(--sp-3);
  padding: var(--sp-2) var(--sp-3) var(--sp-3);
}
.frag--pending .frag-body {
  align-self: center;
}

.frag-marker {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  position: relative;
  z-index: 1;
  color: var(--color-text-tertiary);
}
.frag-marker--decision {
  background: var(--color-primary);
  color: var(--color-text-on-primary);
  border-color: var(--color-primary);
}
.frag-marker--decision .icon-sm { font-size: 14px; }
.frag-marker--audit {
  background: var(--color-success-soft);
  border-color: var(--color-success-soft);
  color: var(--color-success);
}
.frag-marker--audit .icon-sm { font-size: 14px; }
.frag-marker--human_action {
  background: #ede4f6;
  border-color: #ede4f6;
  color: #6b3aa8;
}
.frag-marker--human_action .icon-sm { font-size: 14px; }
.frag--human_action {
  background: #faf6ff;
  border-radius: var(--radius-md);
}
.frag--status-failed .frag-marker--audit {
  background: var(--color-danger-soft);
  border-color: var(--color-danger-soft);
  color: var(--color-danger);
}
.frag--status-skipped .frag-marker--audit {
  background: var(--color-surface-sunken);
  border-color: var(--color-border);
  color: var(--color-text-tertiary);
}
.frag-marker--pending {
  background: var(--color-surface);
  border-color: var(--color-border-strong);
}
.frag--active .frag-marker--pending {
  border-color: var(--color-primary);
  box-shadow: 0 0 0 4px var(--color-primary-soft);
  animation: trail-pulse 1.6s ease-in-out infinite;
}
@keyframes trail-pulse {
  0%, 100% { box-shadow: 0 0 0 4px var(--color-primary-soft); }
  50% { box-shadow: 0 0 0 6px rgba(11, 61, 145, 0.08); }
}

.frag-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.frag-meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
}
.frag-node {
  color: var(--color-text-secondary);
}
.frag-kind-pill {
  font-size: 10px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 1px var(--sp-2);
  border-radius: var(--radius-sm);
}
.frag-kind-pill--decision {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.frag-kind-pill--audit {
  background: var(--color-surface-sunken);
  color: var(--color-text-tertiary);
}
.frag-kind-pill--human_action {
  background: #ede4f6;
  color: #6b3aa8;
}
.frag-action-pill {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  padding: 1px var(--sp-2);
  border-radius: var(--radius-sm);
  background: var(--color-surface-sunken);
  color: var(--color-text-secondary);
}
.frag-action-pill--approve { background: var(--color-success-soft); color: var(--color-success); }
.frag-action-pill--reject { background: var(--color-danger-soft); color: var(--color-danger); }
.frag-action-pill--escalate { background: var(--color-warning-soft); color: var(--color-warning); }
.frag-action-pill--request_info { background: var(--color-primary-soft); color: var(--color-primary); }
.frag-kind-pill--active {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.frag-kind-pill--pending {
  background: var(--color-surface-sunken);
  color: var(--color-text-tertiary);
}
.frag-status-pill {
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 1px var(--sp-2);
  border-radius: var(--radius-sm);
}
.frag-status-pill--failed {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}
.frag-status-pill--skipped {
  background: var(--color-surface-sunken);
  color: var(--color-text-tertiary);
}
.frag-duration {
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--color-text-tertiary);
}

.frag-text {
  margin: 0;
  font-size: var(--fs-body);
  color: var(--color-text-primary);
  line-height: 1.5;
}
.frag--audit .frag-text {
  font-size: var(--fs-meta);
  color: var(--color-text-secondary);
}
.frag-text--muted {
  color: var(--color-text-tertiary);
  font-style: italic;
}

.frag-error {
  margin: 0;
  font-size: 11px;
  color: var(--color-danger);
}

.frag-chevron {
  color: var(--color-text-tertiary);
  transition: transform var(--dur-fast) var(--ease);
  align-self: center;
}
.frag-chevron--open {
  transform: rotate(180deg);
  color: var(--color-primary);
}

.frag-detail {
  margin: 0 var(--sp-3) 0 36px;
  padding: var(--sp-3) var(--sp-4);
  background: var(--color-page);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  gap: var(--sp-3);
}
.frag-section {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.frag-section-label {
  color: var(--color-text-tertiary);
}
.frag-json {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--color-text-secondary);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: var(--sp-2) var(--sp-3);
  overflow-x: auto;
  max-height: 220px;
  white-space: pre;
}
.frag-section--meta {
  flex-direction: row;
  flex-wrap: wrap;
  gap: var(--sp-3);
  font-size: 11px;
  color: var(--color-text-tertiary);
  border-top: 1px solid var(--color-border);
  padding-top: var(--sp-2);
}

.empty {
  padding: var(--sp-6);
  text-align: center;
  background: var(--color-page);
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-md);
}

.frag-children {
  margin: var(--sp-2) 0 0 36px;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.frag-children-toggle {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-2);
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--color-text-secondary);
  text-align: left;
}
.frag-children-toggle:hover {
  background: var(--color-page);
}
.frag-children-counts {
  display: inline-flex;
  flex-wrap: wrap;
  gap: var(--sp-1);
  margin-left: var(--sp-2);
}
.frag-count-pill {
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 1px var(--sp-2);
  border-radius: var(--radius-sm);
  background: var(--color-surface-sunken);
  color: var(--color-text-tertiary);
}
.frag-count-pill--confirmed {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}
.frag-count-pill--review {
  background: var(--color-warning-soft, var(--color-primary-soft));
  color: var(--color-warning, var(--color-primary));
}
.frag-count-pill--dismissed {
  background: var(--color-success-soft);
  color: var(--color-success);
}
.frag-count-pill--failed {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.frag-child-list {
  list-style: none;
  margin: var(--sp-1) 0 var(--sp-2);
  padding: 0 0 0 var(--sp-3);
  border-left: 1px dashed var(--color-border);
  display: flex;
  flex-direction: column;
}
.frag--child {
  padding: var(--sp-1) 0;
}
.frag-summary--child {
  display: grid;
  grid-template-columns: 20px 1fr auto;
  gap: var(--sp-2);
  padding: var(--sp-1) var(--sp-2);
}
.frag-marker--child {
  width: 20px;
  height: 20px;
}
.frag-marker--child .icon-sm { font-size: 12px; }

.frag-decision-pill {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  padding: 1px var(--sp-2);
  border-radius: var(--radius-sm);
  background: var(--color-surface-sunken);
  color: var(--color-text-tertiary);
}
.frag-decision-pill--confirmed {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}
.frag-decision-pill--needs_review {
  background: var(--color-warning-soft, var(--color-primary-soft));
  color: var(--color-warning, var(--color-primary));
}
.frag-decision-pill--dismissed {
  background: var(--color-success-soft);
  color: var(--color-success);
}
.frag-decision-pill--failed {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.frag-detail--child {
  margin-left: 28px;
}
.frag-reasoning {
  margin: 0;
  font-size: var(--fs-meta);
  color: var(--color-text-primary);
  line-height: 1.5;
}
.frag-section--inline {
  flex-direction: row;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--sp-2);
}
.frag-field-pill {
  font-size: 10px;
  padding: 1px var(--sp-2);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
}
.frag-field-pill--matched {
  background: var(--color-success-soft);
  color: var(--color-success);
}
.frag-field-pill--conflict {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.frag-children-overflow {
  padding: var(--sp-2) 0;
}
.frag-children-overflow-btn {
  background: transparent;
  border: 1px dashed var(--color-border-strong);
  border-radius: var(--radius-sm);
  padding: var(--sp-1) var(--sp-3);
  font-size: var(--fs-meta);
  color: var(--color-text-secondary);
  cursor: pointer;
}
.frag-children-overflow-btn:hover {
  background: var(--color-page);
}
</style>
