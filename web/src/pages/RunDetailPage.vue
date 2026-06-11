<script setup>
import { computed, ref, toRef } from 'vue'
import { useRoute } from 'vue-router'
import { useRunDetail } from '../composables/useRunDetail.js'
import { useDossier } from '../composables/useDossier.js'
import { useRefresh } from '../composables/useRefresh.js'
import AgentTrail from '../components/AgentTrail.vue'
import ScreeningTab from '../components/ScreeningTab.vue'
import RiskAssessmentCard from '../components/RiskAssessmentCard.vue'
import FinalDecisionPanelReadOnly from '../components/FinalDecisionPanelReadOnly.vue'
import QaNarrative from '../components/QaNarrative.vue'

const route = useRoute()
const companyNumber = toRef(() => route.params.companyNumber)
const runId = toRef(() => route.params.runId)

const { run, loading, error } = useRunDetail(companyNumber, runId)
const { dossier } = useDossier(companyNumber)
const { resumeFailed } = useRefresh()

const resuming = ref(false)
const resumeError = ref(null)

const previousRunId = computed(() => {
  const runs = dossier.value?.runs || []
  const idx = runs.findIndex((r) => r.id === run.value?.id)
  if (idx < 0) return null
  return runs[idx + 1]?.id || null
})

const exportHref = computed(() => {
  if (!companyNumber.value || !runId.value) return '#'
  return `/api/dossiers/${encodeURIComponent(companyNumber.value)}/runs/${encodeURIComponent(runId.value)}/export.json`
})

async function onResume() {
  if (!run.value || !companyNumber.value) return
  resuming.value = true
  resumeError.value = null
  try {
    await resumeFailed(companyNumber.value, run.value.id, {
      companyName: dossier.value?.companyName || null,
    })
  } catch (err) {
    resumeError.value = err.message
    resuming.value = false
  }
}

const shortRunId = computed(() => (run.value?.id || '').slice(0, 8).toUpperCase())

const startedAt = computed(() => {
  if (!run.value?.startedAt) return null
  return new Date(run.value.startedAt).toLocaleString()
})

const durationMs = computed(() => {
  if (!run.value?.startedAt) return null
  if (!run.value?.endedAt) return null
  return new Date(run.value.endedAt).getTime() - new Date(run.value.startedAt).getTime()
})

function fmtDuration(ms) {
  if (ms == null) return '—'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return s ? `${m}m ${s}s` : `${m}m`
}
</script>

<template>
  <div class="run-detail">
    <header class="page-head">
      <div>
        <RouterLink
          :to="{ name: 'dossier', params: { companyNumber } }"
          class="back-link"
        >
          <span class="material-symbols-outlined icon-sm">arrow_back</span>
          Back to dossier
        </RouterLink>
        <h1 class="t-headline page-title">
          Run <span class="t-mono">{{ shortRunId }}</span>
        </h1>
        <div class="page-meta">
          <span v-if="dossier" class="t-meta">
            {{ dossier.companyName || dossier.companyNumber }}
          </span>
          <span v-if="run" :class="['status-chip', `status-chip--${run.status}`]">
            {{ run.status }}
          </span>
          <span v-if="run" :class="['trigger-pill', `trigger-pill--${run.trigger}`]">
            {{ run.trigger }}
          </span>
          <span v-if="startedAt" class="t-mono"> · started {{ startedAt }}</span>
          <span v-if="durationMs != null" class="t-mono"> · {{ fmtDuration(durationMs) }}</span>
        </div>
      </div>
      <div class="page-actions">
        <button
          v-if="run?.status === 'failed'"
          type="button"
          class="btn btn--secondary"
          :disabled="resuming"
          @click="onResume"
        >
          <span class="material-symbols-outlined icon-sm">play_arrow</span>
          {{ resuming ? 'Resuming…' : 'Resume from last checkpoint' }}
        </button>
        <RouterLink
          v-if="previousRunId"
          :to="{ name: 'run-diff', params: { companyNumber, runId, otherRunId: previousRunId } }"
          class="btn btn--ghost"
        >
          <span class="material-symbols-outlined icon-sm">difference</span>
          Diff vs previous
        </RouterLink>
        <a :href="exportHref" download class="btn btn--ghost">
          <span class="material-symbols-outlined icon-sm">download</span>
          Export JSON
        </a>
      </div>
    </header>

    <div v-if="resumeError" class="banner banner--error" role="alert">
      <strong>Resume failed</strong> — {{ resumeError }}
    </div>

    <section v-if="loading" class="dossier-sheet">
      <p class="t-meta">Loading run…</p>
    </section>

    <section v-else-if="error" class="dossier-sheet">
      <p class="t-meta">{{ error === 'not_found' ? 'Run not found.' : error }}</p>
    </section>

    <section v-else-if="run" class="dossier-sheet">
      <div class="trail-header">
        <div class="trail-header-row">
          <h2 class="t-title">Agent trail</h2>
          <span class="count-pill tabular">{{ (run.fragments || []).length }}</span>
        </div>
        <p class="t-meta">Process and data audit trail for this run.</p>
      </div>
      <AgentTrail
        :fragments="run.fragments || []"
        :is-running="run.status === 'running'"
        mode="historic"
      />
    </section>

    <section v-if="run?.finalScreeningReport" class="dossier-sheet">
      <div class="trail-header">
        <div class="trail-header-row">
          <h2 class="t-title">Screening</h2>
        </div>
        <p class="t-meta">Frozen view — overrides on this run are read-only. Apply overrides on the latest run to carry them forward.</p>
      </div>
      <ScreeningTab
        :company-number="companyNumber"
        :run-id="runId"
        :readonly="true"
        :last-screened-at="run.endedAt || run.startedAt"
      />
    </section>

    <section v-if="run?.finalRiskAssessment" class="dossier-sheet">
      <div class="trail-header">
        <div class="trail-header-row">
          <h2 class="t-title">Risk assessment</h2>
        </div>
        <p class="t-meta">Frozen view — the score and rationale as computed for this run.</p>
      </div>
      <RiskAssessmentCard :assessment="run.finalRiskAssessment" :readonly="true" />
    </section>

    <section v-if="run?.qaResult" class="dossier-sheet">
      <div class="trail-header">
        <div class="trail-header-row">
          <h2 class="t-title">QA &amp; decision</h2>
        </div>
        <p class="t-meta">Frozen view — QA routing as evaluated for this run. Reviewer actions live on the latest run.</p>
      </div>
      <FinalDecisionPanelReadOnly
        :qa-result="run.qaResult"
        :case-status="dossier?.caseStatus"
      />
      <QaNarrative :narrative="run.qaNarrative" />
    </section>
  </div>
</template>

<style scoped>
.run-detail {
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
  flex-wrap: wrap;
  gap: var(--sp-2);
  align-items: center;
  color: var(--color-text-tertiary);
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
  gap: var(--sp-4);
}

.trail-header { display: flex; flex-direction: column; gap: var(--sp-1); }
.trail-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
}
.trail-header h2 { margin: 0; }
.trail-header p { margin: 0; }
.count-pill {
  background: var(--color-surface-sunken);
  color: var(--color-text-secondary);
  font-size: var(--fs-meta);
  padding: 2px var(--sp-3);
  border-radius: var(--radius-pill);
  font-weight: 500;
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
</style>
