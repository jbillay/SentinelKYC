<script setup>
import { computed, ref, toRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useDossier, ALLOWED_TAGS } from '../composables/useDossier.js'
import { useRefresh } from '../composables/useRefresh.js'
import { useRiskAssessment } from '../composables/useRiskAssessment.js'
import { useParties } from '../composables/useParties.js'
import KycCard from '../components/KycCard.vue'
import ScreeningTab from '../components/ScreeningTab.vue'
import RiskAssessmentCard from '../components/RiskAssessmentCard.vue'
import FinalDecisionPanelReadOnly from '../components/FinalDecisionPanelReadOnly.vue'
import QaNarrative from '../components/QaNarrative.vue'

const router = useRouter()
const route = useRoute()
const { refresh } = useRefresh()
const refreshing = ref(false)
const refreshError = ref(null)

async function onRefresh() {
  if (!dossier.value?.companyNumber) return
  refreshing.value = true
  refreshError.value = null
  try {
    await refresh(dossier.value.companyNumber, {
      companyName: dossier.value.companyName || null,
    })
  } catch (err) {
    refreshError.value = err.message
    refreshing.value = false
  }
}

function exportUrl(runId) {
  if (!dossier.value?.companyNumber || !runId) return '#'
  return `/api/dossiers/${encodeURIComponent(dossier.value.companyNumber)}/runs/${encodeURIComponent(runId)}/export.json`
}

// Persistent mode: a companyNumber in the URL → fetch from pg.
// Legacy mode: /dossier/current → use the in-memory agent store.
const isPersistent = !!route.params.companyNumber
const companyNumber = toRef(() => route.params.companyNumber)

let dossier
let loading
let error
let toggleTag
let setNotes
let refreshDossier = async () => {}

if (isPersistent) {
  const persisted = useDossier(companyNumber)
  dossier = persisted.dossier
  loading = persisted.loading
  error = persisted.error
  toggleTag = persisted.toggleTag
  setNotes = persisted.setNotes
  refreshDossier = persisted.refresh
} else {
  dossier = ref(null)
  loading = ref(false)
  error = ref(null)
  toggleTag = () => {}
  setNotes = () => {}
}

const latestRun = computed(() => dossier.value?.runs?.[0] || null)

// The KYC card + shareholder graph render the latest *completed* run so a
// failed/cancelled retry doesn't blank the dossier. The latest-run-derived
// sections below (screening, risk, decision) still follow latestRun — they
// only render when their own snapshot is present, so a failed retry just
// hides them rather than showing stale data.
const lastValidRun = computed(
  () => dossier.value?.runs?.find((r) => r.status === 'done') || null
)
const card = computed(() => {
  if (isPersistent) return lastValidRun.value?.finalKycCard || null
  return null
})
const shareholderGraph = computed(() => {
  if (isPersistent) return lastValidRun.value?.finalShareholderGraph || null
  return null
})

// Phase 4 — fetch parties linked to this dossier so KycCard can render the
// "also in N other dossiers" badges per officer / PSC. Refreshes when the
// dossier id changes (i.e. when navigating between dossiers).
const { parties: dossierParties, load: loadDossierParties } = useParties()
watch(
  () => dossier.value?.id,
  (id) => {
    if (id) loadDossierParties({ dossierId: id, limit: 200 })
  },
  { immediate: true },
)

const staleLatestRun = computed(() => {
  if (!isPersistent) return null
  const lr = latestRun.value
  if (!lr) return null
  if (lr.status !== 'failed' && lr.status !== 'cancelled') return null
  return lr
})

const {
  result: recalcResult,
  recalculating,
  recalcError,
  rationaleSource: recalcRationaleSource,
  recalculate,
} = useRiskAssessment()
const riskStatus = ref(null)

// Prefer a freshly recalculated result; otherwise the latest run's stored one.
const riskAssessment = computed(
  () => recalcResult.value || latestRun.value?.finalRiskAssessment || null
)
const rationaleSource = computed(() =>
  recalcResult.value ? recalcRationaleSource.value : null
)

async function onRecalculate() {
  if (!dossier.value?.companyNumber) return
  riskStatus.value = null
  try {
    const body = await recalculate(dossier.value.companyNumber)
    const ra = body?.riskAssessment
    riskStatus.value = ra
      ? `Risk recalculated — score ${Math.round(ra.score)} (${ra.outcome}) against matrix v${ra.matrixVersion ?? '–'}`
      : 'Risk recalculated.'
    await refreshDossier()
  } catch {
    // recalcError is set by the composable.
  }
}

// Header run id + date track the run that produced the displayed KYC card —
// fall back to the latest done run when the most recent attempt failed/was
// cancelled, so the chip and the card always agree.
const headerRun = computed(() => lastValidRun.value || latestRun.value)
const generatedAt = computed(() => {
  if (!isPersistent) return null
  const ts = headerRun.value?.endedAt || headerRun.value?.startedAt
  if (!ts) return null
  return new Date(ts).toISOString().slice(0, 19).replace('T', ' ')
})

const reportId = computed(() => {
  if (!isPersistent) return null
  return headerRun.value?.id?.slice(0, 8).toUpperCase() || null
})

const subjectName = computed(() => {
  if (isPersistent) return dossier.value?.companyName || dossier.value?.companyNumber || ''
  return ''
})

const runs = computed(() => dossier.value?.runs || [])
const tags = computed(() => dossier.value?.tags || [])

const TERMINAL_OUTCOMES = {
  approved: 'Approved',
  rejected: 'Rejected',
  escalated: 'Escalated',
  info_requested: 'Information requested',
}
const decisionOutcome = computed(() => {
  if (!isPersistent) return null
  const status = dossier.value?.caseStatus
  if (!status || !TERMINAL_OUTCOMES[status]) return null
  return {
    label: TERMINAL_OUTCOMES[status],
    at: dossier.value?.caseStatusUpdatedAt || null,
  }
})
const notes = computed({
  get() { return dossier.value?.notes || '' },
  set(v) { setNotes(v) },
})

function fmtDuration(startedAt, endedAt) {
  if (!startedAt) return '—'
  if (!endedAt) return '—'
  const ms = new Date(endedAt).getTime() - new Date(startedAt).getTime()
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return s ? `${m}m ${s}s` : `${m}m`
}

function fmtTime(ts) {
  if (!ts) return ''
  return new Date(ts).toLocaleString()
}

function previousRunId(idx) {
  // runs are ordered desc by startedAt — the "previous" is the next index.
  return runs.value[idx + 1]?.id || null
}
</script>

<template>
  <div class="dossier-view">
    <header class="page-head">
      <div>
        <RouterLink :to="{ name: 'dossiers' }" class="back-link">
          <span class="material-symbols-outlined icon-sm">arrow_back</span>
          Back to dossiers
        </RouterLink>
        <h1 class="t-headline page-title">
          {{ subjectName || 'KYC dossier' }}
        </h1>
        <div class="page-meta">
          <span v-if="isPersistent && dossier?.companyNumber" class="t-mono">
            #{{ dossier.companyNumber }}
          </span>
          <span v-if="reportId" class="t-mono"> · Run {{ reportId }}</span>
          <span v-if="generatedAt" class="t-mono"> · {{ generatedAt }}</span>
        </div>
      </div>
      <div class="page-actions">
        <button
          v-if="isPersistent"
          type="button"
          class="btn btn--secondary"
          :disabled="refreshing || latestRun?.status === 'running'"
          :title="'Re-runs the full pipeline. May take 30+ minutes if OCR is required.'"
          @click="onRefresh"
        >
          <span class="material-symbols-outlined icon-sm">refresh</span>
          {{ refreshing ? 'Refreshing…' : 'Refresh dossier' }}
        </button>
        <a
          v-if="isPersistent && latestRun"
          :href="exportUrl(latestRun.id)"
          download
          class="btn btn--ghost"
        >
          <span class="material-symbols-outlined icon-sm">download</span>
          Export JSON
        </a>
        <button type="button" class="btn btn--ghost">
          <span class="material-symbols-outlined icon-sm">share</span>
          Share
        </button>
      </div>
    </header>

    <div v-if="refreshError" class="banner banner--error" role="alert">
      <strong>Refresh failed</strong> — {{ refreshError }}
    </div>

    <div
      v-if="staleLatestRun"
      :class="['banner', staleLatestRun.status === 'failed' ? 'banner--error' : 'banner--warn']"
      role="alert"
    >
      <strong v-if="staleLatestRun.status === 'failed'">Latest run failed</strong>
      <strong v-else>Latest run was cancelled</strong>
      <template v-if="lastValidRun">
        — latest data can't be used. Showing run
        <span class="t-mono">{{ lastValidRun.id.slice(0, 8).toUpperCase() }}</span>
        from {{ fmtTime(lastValidRun.endedAt || lastValidRun.startedAt) }}.
      </template>
      <template v-else>
        — latest data can't be used and no prior completed run is available.
      </template>
    </div>

    <section v-if="isPersistent && loading" class="empty-sheet">
      <div class="empty-content">
        <p class="t-meta">Loading dossier…</p>
      </div>
    </section>

    <section v-else-if="isPersistent && error === 'not_found'" class="empty-sheet">
      <div class="empty-content">
        <span class="material-symbols-outlined empty-icon">search_off</span>
        <h2 class="t-title">Dossier not found</h2>
        <p class="empty-msg">No dossier exists for this company number yet.</p>
      </div>
    </section>

    <section v-else-if="card" id="identity" class="dossier-sheet">
      <KycCard :card="card" :parties="dossierParties" />
      <div id="documents" class="anchor-stub" aria-hidden="true" />

      <div v-if="shareholderGraph" class="graph-cta">
        <RouterLink
          :to="{ name: 'graph', params: { companyNumber: dossier.companyNumber } }"
          class="graph-cta-link"
        >
          <div>
            <div class="t-label">Visualisation</div>
            <div class="graph-cta-title">Open entity graph</div>
            <div class="graph-cta-sub">{{ shareholderGraph.nodes?.length || 0 }} entities · {{ shareholderGraph.edges?.length || 0 }} relationships</div>
          </div>
          <span class="material-symbols-outlined">arrow_forward</span>
        </RouterLink>
      </div>
    </section>

    <section v-else class="empty-sheet">
      <div class="empty-content">
        <span class="material-symbols-outlined empty-icon">description</span>
        <h2 class="t-title">No KYC card</h2>
        <p class="empty-msg">
          This dossier has no completed run with a KYC card yet.
        </p>
        <button type="button" class="btn btn--primary" @click="router.push({ name: 'search' })">
          Start a new search
        </button>
      </div>
    </section>

    <section v-if="isPersistent && latestRun?.finalScreeningReport" id="screening" class="dossier-sheet">
      <div class="section-head">
        <h2 class="t-title">Screening</h2>
        <p class="t-meta">Latest run · sanctions + adverse media. Overrides apply to this run only — use “Carry forward” to apply to future runs.</p>
      </div>
      <ScreeningTab
        :company-number="dossier.companyNumber"
        :run-id="latestRun.id"
        :last-screened-at="latestRun.endedAt || latestRun.startedAt"
      />
    </section>

    <section v-if="isPersistent && (riskAssessment || card)" id="risk" class="dossier-sheet">
      <div class="section-head">
        <h2 class="t-title">Risk assessment</h2>
        <p class="t-meta">Deterministic weighted-factor score with knockouts from screening. Recalculate to rebase the latest run against the active matrix.</p>
      </div>
      <div v-if="recalcError" class="banner banner--error" role="alert">
        <strong>Recalculate failed</strong> — {{ recalcError }}
      </div>
      <div v-else-if="riskStatus" class="banner banner--ok">{{ riskStatus }}</div>
      <RiskAssessmentCard
        :assessment="riskAssessment"
        :recalculating="recalculating"
        :rationale-source="rationaleSource"
        @recalculate="onRecalculate"
      />
    </section>

    <section
      v-if="isPersistent && dossier && (latestRun?.qaResult || decisionOutcome)"
      class="dossier-sheet"
    >
      <div class="section-head">
        <h2 class="t-title">Final decision</h2>
        <p class="t-meta">
          The reviewer's action is captured during the run. This page is read-only —
          to change a status, start a new run.
        </p>
      </div>

      <FinalDecisionPanelReadOnly
        v-if="latestRun?.qaResult"
        :qa-result="latestRun.qaResult"
        :case-status="dossier.caseStatus"
      />

      <QaNarrative
        v-if="latestRun?.qaResult"
        :narrative="latestRun.qaNarrative"
      />

      <div v-if="decisionOutcome" class="decision-outcome">
        <div class="decision-outcome-label t-label">Outcome</div>
        <div class="decision-outcome-row">
          <span :class="['case-status', `case-status--${dossier.caseStatus}`]">
            {{ decisionOutcome.label }}
          </span>
          <span v-if="decisionOutcome.at" class="t-meta">
            {{ fmtTime(decisionOutcome.at) }}
          </span>
        </div>
      </div>
    </section>

    <section v-if="isPersistent && dossier" class="dossier-sheet">
      <div class="section-head">
        <h2 class="t-title">Tags &amp; notes</h2>
        <p class="t-meta">Annotations stay with the dossier across runs.</p>
      </div>
      <div class="tags-row">
        <button
          v-for="t in ALLOWED_TAGS"
          :key="t"
          type="button"
          :class="['tag-chip', { 'tag-chip--active': tags.includes(t) }]"
          @click="toggleTag(t)"
        >
          {{ t }}
        </button>
      </div>
      <textarea
        class="notes"
        rows="4"
        :value="notes"
        placeholder="Notes — saved automatically"
        @input="notes = $event.target.value"
      />
    </section>

    <section v-if="isPersistent && runs.length" class="dossier-sheet">
      <div class="section-head">
        <h2 class="t-title">Runs</h2>
        <p class="t-meta">{{ runs.length }} run{{ runs.length === 1 ? '' : 's' }} on record.</p>
      </div>
      <ul class="run-list">
        <li v-for="(r, idx) in runs" :key="r.id" class="run-row">
          <div class="run-row-main">
            <span :class="['status-chip', `status-chip--${r.status}`]">
              {{ r.status }}
            </span>
            <span :class="['trigger-pill', `trigger-pill--${r.trigger}`]">
              {{ r.trigger }}
            </span>
            <span class="t-mono run-id">{{ r.id.slice(0, 8).toUpperCase() }}</span>
            <span class="t-meta run-when">{{ fmtTime(r.startedAt) }}</span>
            <span class="t-mono run-dur">{{ fmtDuration(r.startedAt, r.endedAt) }}</span>
          </div>
          <div class="run-row-actions">
            <RouterLink
              :to="{ name: 'run-detail', params: { companyNumber: dossier.companyNumber, runId: r.id } }"
              class="btn btn--ghost btn--sm"
            >
              View run
            </RouterLink>
            <RouterLink
              v-if="previousRunId(idx)"
              :to="{ name: 'run-diff', params: { companyNumber: dossier.companyNumber, runId: r.id, otherRunId: previousRunId(idx) } }"
              class="btn btn--ghost btn--sm"
            >
              Diff vs previous
            </RouterLink>
            <button
              v-else
              type="button"
              class="btn btn--ghost btn--sm"
              disabled
              title="No previous run"
            >
              Diff vs previous
            </button>
          </div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.dossier-view {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}

.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: var(--sp-4);
  flex-wrap: wrap;
}
.back-link {
  display: inline-flex;
  align-items: center;
  gap: var(--sp-1);
  font-size: var(--fs-meta);
  font-weight: 500;
  color: var(--color-text-secondary);
  text-decoration: none;
  margin-bottom: var(--sp-2);
}
.back-link:hover { color: var(--color-primary); }

.page-title {
  margin: 0;
}
.page-meta {
  margin-top: var(--sp-2);
  display: flex;
  gap: var(--sp-1);
  align-items: baseline;
  color: var(--color-text-tertiary);
  font-size: var(--fs-meta);
}

.page-actions {
  display: flex;
  gap: var(--sp-2);
  align-items: center;
}
.page-actions .btn[disabled] {
  opacity: 0.5;
  cursor: not-allowed;
}

.banner {
  border-radius: var(--radius-md);
  padding: var(--sp-3) var(--sp-4);
}
.banner--error {
  border-left: 4px solid var(--color-danger);
  background: var(--color-danger-soft);
}
.banner--warn {
  border-left: 4px solid var(--color-warning, #d97706);
  background: var(--color-warning-soft, #fef3c7);
}
.banner--ok {
  border-left: 4px solid var(--color-success);
  background: var(--color-success-soft);
  font-size: var(--fs-meta);
}

.dossier-sheet {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--sp-8);
  box-shadow: var(--shadow-sheet);
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}

.section-head h2 { margin: 0 0 var(--sp-1); }
.section-head p { margin: 0; }

.tags-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-2);
}
.tag-chip {
  display: inline-flex;
  align-items: center;
  height: 30px;
  padding: 0 var(--sp-3);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  font-size: var(--fs-label);
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background-color var(--dur-fast) var(--ease),
              color var(--dur-fast) var(--ease),
              border-color var(--dur-fast) var(--ease);
}
.tag-chip:hover {
  background: var(--color-page);
  color: var(--color-text-primary);
}
.tag-chip--active {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: var(--color-text-on-primary);
}
.tag-chip--active:hover {
  background: var(--color-primary-hover);
  color: var(--color-text-on-primary);
}

.notes {
  width: 100%;
  font: inherit;
  color: var(--color-text-primary);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--sp-3) var(--sp-4);
  resize: vertical;
  min-height: 80px;
}
.notes:focus {
  outline: 0;
  border-color: var(--color-primary);
}

.run-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.run-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: var(--sp-3) 0;
  border-bottom: 1px solid var(--color-border);
  flex-wrap: wrap;
}
.run-row:last-child { border-bottom: 0; }
.run-row-main {
  display: flex;
  align-items: center;
  gap: var(--sp-3);
  flex-wrap: wrap;
}
.run-id { color: var(--color-text-secondary); }
.run-when { color: var(--color-text-tertiary); }
.run-dur { color: var(--color-text-tertiary); }

.run-row-actions {
  display: flex;
  gap: var(--sp-2);
}

.btn--sm {
  height: 30px;
  padding: 0 var(--sp-3);
  font-size: var(--fs-meta);
}
.btn[disabled] {
  opacity: 0.5;
  cursor: not-allowed;
}

.status-chip {
  display: inline-block;
  padding: 2px var(--sp-2);
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.02em;
  text-transform: uppercase;
}
.status-chip--done {
  background: var(--color-success-soft);
  color: var(--color-success);
}
.status-chip--failed,
.status-chip--not_found {
  background: var(--color-danger-soft);
  color: var(--color-danger);
}
.status-chip--running {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}

.trigger-pill {
  display: inline-block;
  padding: 2px var(--sp-2);
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  background: var(--color-surface-sunken);
  color: var(--color-text-tertiary);
}
.trigger-pill--initial {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.trigger-pill--refresh {
  background: var(--color-tertiary-soft);
  color: var(--color-tertiary);
}

.decision-outcome {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
  padding-top: var(--sp-2);
  border-top: 1px solid var(--color-border);
}
.decision-outcome-label {
  color: var(--color-text-secondary);
}
.decision-outcome-row {
  display: flex;
  align-items: baseline;
  gap: var(--sp-3);
}

.graph-cta {
  border-top: 1px solid var(--color-border);
  padding-top: var(--sp-6);
}
.graph-cta-link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-4);
  padding: var(--sp-4) var(--sp-6);
  background: var(--color-page);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  text-decoration: none;
  color: inherit;
  transition: background-color var(--dur-fast) var(--ease),
              border-color var(--dur-fast) var(--ease);
}
.graph-cta-link:hover {
  background: var(--color-primary-soft);
  border-color: var(--color-primary);
  color: var(--color-primary);
}
.graph-cta-title {
  font-size: var(--fs-title);
  font-weight: 600;
  margin-top: 2px;
}
.graph-cta-sub {
  font-size: var(--fs-meta);
  color: var(--color-text-tertiary);
  margin-top: 2px;
}

.empty-sheet {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--sp-16) var(--sp-8);
  display: flex;
  align-items: center;
  justify-content: center;
}
.empty-content {
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--sp-3);
  max-width: 480px;
}
.empty-icon {
  font-size: 48px;
  color: var(--color-text-tertiary);
}
.empty-content h2 {
  margin: var(--sp-2) 0 0;
}
.empty-msg {
  margin: 0;
  color: var(--color-text-secondary);
  line-height: 1.6;
}

/* Stub element so #documents anchor links scroll to the KYC card sheet
   (which is where the documents UI lives). Scroll offset matches the page
   gutter so the section header isn't flush with the viewport top. */
.anchor-stub {
  position: relative;
  top: calc(-1 * var(--sp-8));
  height: 0;
}
</style>
