<script setup>
import { computed, onBeforeUnmount, ref, watch } from 'vue'

const props = defineProps({
  progress: { type: Object, default: null },
})

// Tick once a second so the elapsed-time + ETA display updates while a page is processing
const now = ref(Date.now())
let timer = null
function startTicker() {
  if (timer) return
  timer = setInterval(() => { now.value = Date.now() }, 1000)
}
function stopTicker() {
  if (timer) { clearInterval(timer); timer = null }
}

// Track when the current stage (and the current document) started so we can show elapsed time
// when no ETA is computable — e.g. on the first OCR page (pageDurations is still empty), or
// during the single-call `extracting` phase which has no page-level signal.
const stageStartedAt = ref(null)
watch(
  () => [props.progress?.stage, props.progress?.transactionId],
  ([s, tx], prev) => {
    if (s !== prev?.[0] || tx !== prev?.[1]) stageStartedAt.value = Date.now()
    const liveStages = new Set(['preparing', 'rasterizing', 'ocr_page', 'extracting'])
    if (liveStages.has(s)) startTicker()
    else stopTicker()
  },
  { immediate: true }
)
onBeforeUnmount(stopTicker)

const stage = computed(() => props.progress?.stage || 'idle')

const isOcrActive = computed(() =>
  stage.value === 'rasterizing' ||
  stage.value === 'ocr_page' ||
  stage.value === 'ocr_page_done'
)

const isExtracting = computed(() => stage.value === 'extracting')

const filingType = computed(() => {
  const cat = props.progress?.category
  if (!cat) return 'Pending document'
  return cat
    .split(/[-_]/)
    .map((w) => w[0]?.toUpperCase() + w.slice(1))
    .join(' ')
})

const filingDate = computed(() => props.progress?.date || '—')
const transactionId = computed(() => props.progress?.transactionId || '—')

// Page progress
const totalPages = computed(() => props.progress?.pages || 0)
const currentPage = computed(() => {
  if (stage.value === 'ocr_page' || stage.value === 'ocr_page_done') {
    return props.progress?.page || 0
  }
  return 0
})

// Average page duration → ETA
const avgPageMs = computed(() => {
  const durs = props.progress?.pageDurations || []
  if (!durs.length) return null
  const sum = durs.reduce((a, b) => a + b, 0)
  return sum / durs.length
})

const remainingPages = computed(() => {
  if (!totalPages.value) return 0
  if (stage.value === 'ocr_page') return Math.max(0, totalPages.value - currentPage.value)
  if (stage.value === 'ocr_page_done') return Math.max(0, totalPages.value - currentPage.value)
  return totalPages.value
})

const etaSec = computed(() => {
  if (!avgPageMs.value || !remainingPages.value) return null
  // Subtract the time we've already spent on the in-flight page (best-effort, since we don't have its start ts here we lean on the average)
  const remainingMs = avgPageMs.value * remainingPages.value
  return Math.max(1, Math.round(remainingMs / 1000))
})

// Elapsed seconds in the current stage — used as a fallback when no ETA can be computed yet
// (first OCR page, structured-extraction LLM call).
const stageElapsedSec = computed(() => {
  if (!stageStartedAt.value) return null
  return Math.max(0, Math.floor((now.value - stageStartedAt.value) / 1000))
})

// Rough budget for the structured-extraction LLM call. Used to creep the bar 85 → 95 so the
// user sees progress while the single extractStructured() call is in flight.
const EXTRACT_EST_MS = 25000

function fmtDuration(seconds) {
  if (seconds == null) return '—'
  if (seconds < 60) return `${seconds}s`
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return s ? `${m}m ${s}s` : `${m}m`
}

const percent = computed(() => {
  if (stage.value === 'idle' || stage.value === 'batch_start' || stage.value === 'preparing') return 0
  if (stage.value === 'rasterizing') return 5
  if (stage.value === 'text_extracted') return 60
  if (stage.value === 'extracting') {
    if (!stageStartedAt.value) return 85
    const elapsed = now.value - stageStartedAt.value
    const ratio = Math.min(1, elapsed / EXTRACT_EST_MS)
    return 85 + ratio * 10
  }
  if (stage.value === 'done' || stage.value === 'batch_done') return 100
  if (stage.value === 'failed') return 100
  if (stage.value === 'skipped') return 100
  if (totalPages.value && (stage.value === 'ocr_page' || stage.value === 'ocr_page_done')) {
    // Pages contribute 5%–80% of the bar; structured extraction takes the remaining 5%
    const pageBase = 5
    const pageSpan = 75
    const completed = stage.value === 'ocr_page_done' ? currentPage.value : Math.max(0, currentPage.value - 1)
    const partial = stage.value === 'ocr_page' ? 0.5 : 0
    return Math.min(80, pageBase + ((completed + partial) / totalPages.value) * pageSpan)
  }
  return 0
})

const statusMessage = computed(() => {
  if (props.progress?.message) return props.progress.message
  switch (stage.value) {
    case 'preparing': return 'Reading PDF and detecting text density…'
    case 'rasterizing': return 'Rasterizing pages for OCR…'
    case 'ocr_page': return `Scanning page ${currentPage.value} of ${totalPages.value}…`
    case 'ocr_page_done': return `Page ${currentPage.value} of ${totalPages.value} processed`
    case 'extracting': return 'Synthesising structured fields from extracted text…'
    case 'done': return 'Document ready'
    case 'failed': return 'Document failed'
    case 'idle': return 'Waiting for documents…'
    default: return 'Processing…'
  }
})

const statusTone = computed(() => {
  if (stage.value === 'failed') return 'danger'
  if (stage.value === 'done') return 'success'
  if (stage.value === 'skipped') return 'muted'
  return 'primary'
})

const docCounter = computed(() => {
  const total = props.progress?.docTotal
  const idx = props.progress?.docIndex
  if (typeof total === 'number' && typeof idx === 'number') {
    return `Document ${idx + 1} of ${total}`
  }
  return null
})
</script>

<template>
  <article class="evidence">
    <header class="head">
      <div class="head-left">
        <span class="t-label">Live evidence feed</span>
        <span v-if="docCounter" class="head-counter">{{ docCounter }}</span>
      </div>
      <span class="stream-badge">
        <span class="stream-dot" />
        Stream active
      </span>
    </header>

    <div class="filing">
      <div class="filing-bar">
        <span class="filing-bar-fill" :style="{ width: percent + '%' }" />
      </div>

      <div class="filing-body">
        <div class="filing-top">
          <div>
            <span class="t-label">Filing type</span>
            <h3 class="filing-type">{{ filingType }}</h3>
          </div>
          <div class="filing-tags">
            <span v-if="isOcrActive" class="tag tag--ocr">
              <span class="material-symbols-outlined icon-sm">document_scanner</span>
              OCR active
            </span>
            <span v-else-if="isExtracting" class="tag tag--extract">
              <span class="material-symbols-outlined icon-sm">auto_awesome</span>
              Extracting
            </span>
            <span v-else-if="stage === 'done'" class="tag tag--done">
              <span class="material-symbols-outlined icon-sm">check</span>
              Complete
            </span>
            <span v-else-if="stage === 'failed'" class="tag tag--failed">
              <span class="material-symbols-outlined icon-sm">error</span>
              Failed
            </span>
          </div>
        </div>

        <div class="filing-grid">
          <div class="grid-cell">
            <span class="t-label">Filing date</span>
            <span class="grid-val tabular t-mono">{{ filingDate }}</span>
          </div>
          <div class="grid-cell">
            <span class="t-label">Transaction id</span>
            <span class="grid-val tabular t-mono">{{ transactionId }}</span>
          </div>
          <div class="grid-cell">
            <span class="t-label">Progress</span>
            <span class="grid-val grid-val--accent">
              <template v-if="totalPages && currentPage">
                Page {{ currentPage }} of {{ totalPages }}
              </template>
              <template v-else-if="totalPages">{{ totalPages }} page(s)</template>
              <template v-else>{{ Math.round(percent) }}%</template>
            </span>
          </div>
          <div class="grid-cell">
            <span class="t-label">Estimated time</span>
            <span class="grid-val tabular t-mono">
              <template v-if="etaSec">{{ fmtDuration(etaSec) }} remaining</template>
              <template v-else-if="stage === 'done'">—</template>
              <template v-else-if="stageElapsedSec != null">{{ fmtDuration(stageElapsedSec) }} elapsed</template>
              <template v-else>calculating…</template>
            </span>
          </div>
        </div>

        <hr class="filing-divider" />

        <!-- X1 — truncation is a correctness warning, not a progress detail:
             only the first N pages of a longer filing get the OCR budget. -->
        <div v-if="progress?.truncated" class="truncation-note" role="alert">
          <span class="material-symbols-outlined icon-sm" aria-hidden="true">warning</span>
          OCR limited to {{ progress?.pages ?? '?' }} of {{ progress?.pagesTotal ?? '?' }} pages —
          extracted lists may be incomplete
        </div>

        <div class="status-row">
          <span :class="['status-icon', `status-icon--${statusTone}`]" aria-hidden="true">
            <span v-if="statusTone === 'success'" class="material-symbols-outlined icon-sm">check</span>
            <span v-else-if="statusTone === 'danger'" class="material-symbols-outlined icon-sm">error</span>
            <span v-else class="material-symbols-outlined icon-sm">visibility</span>
          </span>
          <span class="status-msg">{{ statusMessage }}</span>
          <span class="status-pct tabular">{{ Math.round(percent) }}%</span>
        </div>
        <div class="status-bar">
          <span :class="['status-bar-fill', `status-bar-fill--${statusTone}`]" :style="{ width: percent + '%' }" />
        </div>
      </div>
    </div>
  </article>
</template>

<style scoped>
.truncation-note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 8px;
  padding: 6px 10px;
  border: 1px solid var(--color-warning, #b45309);
  border-radius: var(--radius-sm, 4px);
  color: var(--color-warning, #b45309);
  background: var(--color-warning-soft, rgba(180, 83, 9, 0.08));
  font-size: 12px;
}

.evidence {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-page);
}
.head-left {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
}
.head-counter {
  font-size: var(--fs-meta);
  color: var(--color-text-tertiary);
  font-family: var(--font-mono);
}
.stream-badge {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--color-primary);
}
.stream-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--color-primary);
  animation: stream-pulse 1.6s ease-in-out infinite;
}
@keyframes stream-pulse {
  0%, 100% { box-shadow: 0 0 0 0 rgba(11, 61, 145, 0.4); }
  50% { box-shadow: 0 0 0 4px rgba(11, 61, 145, 0); }
}

.filing {
  position: relative;
}
.filing-bar {
  height: 4px;
  background: var(--color-surface-sunken);
  overflow: hidden;
}
.filing-bar-fill {
  display: block;
  height: 100%;
  background: var(--color-primary);
  transition: width 360ms cubic-bezier(0.2, 0, 0, 1);
}

.filing-body {
  padding: var(--sp-4) var(--sp-6);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.filing-top {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--sp-3);
}
.filing-type {
  margin: var(--sp-1) 0 0;
  font-family: var(--font-display);
  font-size: 22px;
  font-weight: 600;
  color: var(--color-text-primary);
  letter-spacing: -0.01em;
  line-height: 1.2;
}
.filing-tags {
  display: flex;
  gap: var(--sp-2);
  flex-shrink: 0;
}
.tag {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  padding: var(--sp-1) var(--sp-3);
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.tag--ocr {
  background: var(--color-primary);
  color: var(--color-text-on-primary);
}
.tag--extract {
  background: var(--color-tertiary-soft);
  color: var(--color-tertiary);
}
.tag--done {
  background: var(--color-success-soft);
  color: var(--color-success);
}
.tag--failed {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}

.filing-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--sp-4);
}
.grid-cell {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  min-width: 0;
}
.grid-val {
  font-size: var(--fs-body);
  color: var(--color-text-primary);
  font-weight: 500;
  word-break: break-all;
}
.grid-val--accent {
  color: var(--color-primary);
  font-weight: 600;
}

.filing-divider {
  border: 0;
  border-top: 1px solid var(--color-border);
  margin: 0;
}

.status-row {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
}
.status-icon {
  width: 24px;
  height: 24px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.status-icon--primary {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.status-icon--success {
  background: var(--color-success-soft);
  color: var(--color-success);
}
.status-icon--danger {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}
.status-icon--muted {
  background: var(--color-surface-sunken);
  color: var(--color-text-tertiary);
}

.status-msg {
  flex: 1;
  font-size: var(--fs-body);
  color: var(--color-text-primary);
  line-height: 1.5;
  min-width: 0;
}
.status-pct {
  font-family: var(--font-mono);
  font-size: var(--fs-mono);
  font-weight: 500;
  color: var(--color-primary);
  flex-shrink: 0;
}

.status-bar {
  height: 4px;
  background: var(--color-surface-sunken);
  border-radius: var(--radius-pill);
  overflow: hidden;
}
.status-bar-fill {
  display: block;
  height: 100%;
  background: var(--color-primary);
  border-radius: var(--radius-pill);
  transition: width 360ms cubic-bezier(0.2, 0, 0, 1);
}
.status-bar-fill--success { background: var(--color-success); }
.status-bar-fill--danger { background: var(--color-danger); }
.status-bar-fill--muted { background: var(--color-text-tertiary); }

@media (max-width: 720px) {
  .filing-grid { grid-template-columns: repeat(2, 1fr); }
}
</style>
