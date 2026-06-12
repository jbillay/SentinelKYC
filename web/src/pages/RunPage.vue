<script setup>
import { computed, onBeforeUnmount, toRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useAgentStore } from '../stores/agent.js'
import { useRun } from '../composables/useRun.js'
import AgentTrail from '../components/AgentTrail.vue'
import CandidateDisambiguation from '../components/CandidateDisambiguation.vue'
import NotFound from '../components/NotFound.vue'
import LiveEvidenceCard from '../components/LiveEvidenceCard.vue'
import ScreeningEvidenceCard from '../components/ScreeningEvidenceCard.vue'
import FinalDecisionPanel from '../components/FinalDecisionPanel.vue'

const route = useRoute()
const router = useRouter()
const store = useAgentStore()

const threadId = toRef(() => route.params.threadId)
const run = useRun(threadId)

const TRANSPORT_NODES = store.TRANSPORT_NODES

const transportError = computed(() => {
  if (run.phase.value !== 'error') return null
  const errs = run.errors.value
  for (let i = errs.length - 1; i >= 0; i--) {
    if (TRANSPORT_NODES.has(errs[i].node)) return errs[i]
  }
  return null
})

const inStreamErrors = computed(() =>
  run.errors.value.filter((e) => !TRANSPORT_NODES.has(e.node))
)

const chosenCandidate = computed(() => {
  const num = run.resolution.value?.chosen
  if (!num) return null
  return run.candidates.value.find((c) => c.companyNumber === num) || { companyNumber: num }
})

// Only show the document evidence card while the document pipeline is the
// active task. Once the batch finishes (or the very last per-doc stage is a
// terminal one), the agent has moved on to synthesize / screening / risk /
// QA, so the card should disappear instead of lingering as a "Complete" tile.
const DOC_TERMINAL_STAGES = new Set(['batch_done', 'done', 'failed', 'skipped'])
const showEvidenceCard = computed(() => {
  const p = run.progress.value
  if (!p) return false
  if (p.stage === 'idle') return false
  if (DOC_TERMINAL_STAGES.has(p.stage)) return false
  return true
})

// Same idea for the screening card: it's a live view of the screening
// branches, so it goes away once screening has wrapped up — either the
// compile_screening_report fragment landed (the agent moved on to risk/QA)
// or the run left the running phase (decision pause, done, cancelled, error).
const showScreeningCard = computed(() => {
  if (run.phase.value !== 'running') return false
  if (run.fragments.value.some((f) => f.nodeId === 'compile_screening_report')) return false
  const sc = run.screening.value
  if (!sc) return false
  return sc.subjects.length > 0 || sc.hits.length > 0 || !!sc.currentSubjectId
})

// Hand-off + lifecycle cleanup.
//
// - `done` with a kycCard → route to the dossier and drop the slice (the
//   navigation transition gets 600ms before the slice is removed so we don't
//   yank state out from under a still-mounted child).
// - `awaiting_decision` keeps the user on this page — the reviewer's
//   decision is part of the run, not the dossier. Once they submit, the
//   /decision endpoint resumes the graph and the slice transitions to
//   `done`, which fires the redirect above.
// - Any other terminal phase (`cancelled`, `error`, `done` without card)
//   leaves the slice alive while the user is on this page (errors are still
//   visible) and clears it on unmount instead. Without this the slice would
//   live for the whole tab session.
// See CODE_REVIEW §4.3.
let navTimer = null
watch(
  () => run.phase.value,
  (p) => {
    if (p === 'done' && run.kycCard.value && run.companyNumber.value) {
      const id = threadId.value
      const target = run.companyNumber.value
      navTimer = setTimeout(() => {
        navTimer = null
        router.push({ name: 'dossier', params: { companyNumber: target } })
        store.removeRun(id)
      }, 600)
    }
  }
)

onBeforeUnmount(() => {
  if (navTimer) {
    clearTimeout(navTimer)
    navTimer = null
  }
  const id = threadId.value
  if (!id) return
  const slice = store.runs[id]
  if (!slice) return
  // Drop finished slices that the user has navigated away from. `running` /
  // `needs_user_pick` slices stay alive so the sidebar's running-runs list
  // keeps tracking them across navigations.
  if (slice.phase === 'cancelled' || slice.phase === 'error' || slice.phase === 'done') {
    store.removeRun(id)
  }
})

function onPick(companyNumber) {
  run.pick(companyNumber)
}

function onCancel() {
  run.cancel()
}

function newSearch() {
  router.push({ name: 'search' })
}

// Issue 1C — the server told us the dossier is already in a terminal state
// (i.e. a previous decision survived this re-run). Patch the slice so the
// panel re-renders into its read-only "Decision finalized" branch instead
// of leaving the action row clickable.
function onCaseStatusStale(caseStatus) {
  const id = threadId.value
  if (!id) return
  const slice = store.runs[id]
  if (slice) slice.caseStatus = caseStatus
}
</script>

<template>
  <div class="run-page">
    <header class="run-head">
      <div>
        <span class="t-label">Subject</span>
        <h1 class="run-title">{{ run.subjectName.value }}</h1>
        <div class="run-meta">
          <span v-if="chosenCandidate?.companyNumber" class="t-mono">
            #{{ chosenCandidate.companyNumber }}
          </span>
          <span v-if="threadId" class="t-mono run-thread">
            thread {{ threadId.slice(0, 8) }}
          </span>
        </div>
      </div>
      <div class="run-actions">
        <button
          v-if="run.isRunning.value || transportError"
          type="button"
          class="btn btn--ghost"
          @click="onCancel"
        >
          <span class="material-symbols-outlined icon-sm">close</span>
          {{ transportError ? 'Clean up this run' : 'Cancel this run' }}
        </button>
        <button type="button" class="btn btn--ghost" @click="newSearch">
          <span class="material-symbols-outlined icon-sm">add</span>
          New search
        </button>
      </div>
    </header>

    <div v-if="transportError" class="banner banner--error" role="alert">
      <strong>Connection problem</strong> — {{ transportError.message }}
      <span class="banner-hint">
        The server lost the live stream for this run (likely a server restart while it was in flight).
        Use "Clean up this run" to mark it cancelled, then start a fresh search.
      </span>
    </div>

    <div class="run-grid">
      <section class="sheet trail-sheet">
        <div class="step-header">
          <span class="step-num">02</span>
          <div class="step-header-body">
            <div class="step-header-row">
              <h2 class="t-title">Agent trail</h2>
              <span class="count-pill tabular">{{ run.fragments.value.length }}</span>
            </div>
            <p class="t-meta">Process and data audit trail for this run.</p>
          </div>
        </div>
        <AgentTrail
          :fragments="run.fragments.value"
          :is-running="run.isRunning.value"
          mode="live"
        />
      </section>

      <section class="sheet feed-sheet">
        <div class="step-header">
          <span class="step-num">03</span>
          <div>
            <h2 class="t-title">Live evidence</h2>
            <p class="t-meta">Filings fetched and facts extracted in real time.</p>
          </div>
        </div>

        <CandidateDisambiguation
          v-if="run.phase.value === 'needs_user_pick'"
          :candidates="run.candidates.value"
          :resolution="run.resolution.value"
          @pick="onPick"
        />

        <FinalDecisionPanel
          v-if="
            run.phase.value === 'awaiting_decision' &&
            run.companyNumber.value &&
            run.runId.value &&
            run.qaResult.value
          "
          :company-number="run.companyNumber.value"
          :run-id="run.runId.value"
          :qa-result="run.qaResult.value"
          :qa-narrative="run.qaNarrative.value"
          :case-status="run.caseStatus.value || 'pending'"
          @case-status-stale="onCaseStatusStale"
        />

        <div v-else-if="run.phase.value === 'done' && !run.kycCard.value" class="feed-empty">
          <NotFound :resolution="run.resolution.value" />
        </div>

        <LiveEvidenceCard v-if="showEvidenceCard" :progress="run.progress.value" class="evidence-stack-item" />

        <ScreeningEvidenceCard
          v-if="showScreeningCard"
          :screening="run.screening.value"
          class="evidence-stack-item"
        />

        <div v-if="run.phase.value === 'done' && run.kycCard.value && run.companyNumber.value" class="feed-cta">
          <RouterLink
            :to="{ name: 'dossier', params: { companyNumber: run.companyNumber.value } }"
            class="btn btn--primary"
          >
            View KYC dossier
            <span class="material-symbols-outlined icon-sm">arrow_forward</span>
          </RouterLink>
        </div>

        <div v-if="run.phase.value === 'cancelled'" class="feed-empty">
          <p class="t-meta">This run was cancelled.</p>
        </div>
      </section>
    </div>

    <section v-if="inStreamErrors.length" class="sheet errors-sheet">
      <div class="step-header">
        <span class="step-num step-num--warning">!</span>
        <div>
          <h2 class="t-title">Errors during processing</h2>
          <p class="t-meta">{{ inStreamErrors.length }} non-fatal error{{ inStreamErrors.length === 1 ? '' : 's' }} reported.</p>
        </div>
      </div>
      <ul class="error-list">
        <li v-for="(e, i) in inStreamErrors" :key="i">
          <code class="t-mono">{{ e.node }}</code>
          <span>{{ e.message }}</span>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.run-page {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}

.run-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--sp-4);
  flex-wrap: wrap;
}
.run-title {
  margin: var(--sp-1) 0 var(--sp-2);
  font-family: var(--font-display);
  font-size: 24px;
  font-weight: 600;
  color: var(--color-text-primary);
  letter-spacing: -0.01em;
  line-height: 1.2;
}
.run-meta {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
  align-items: baseline;
  color: var(--color-text-secondary);
  font-size: var(--fs-meta);
}
.run-thread {
  color: var(--color-text-tertiary);
}
.run-actions {
  display: flex;
  gap: var(--sp-2);
}

.banner {
  border-radius: var(--radius-md);
  padding: var(--sp-3) var(--sp-4);
  border-left: 4px solid var(--color-danger);
  background: var(--color-danger-soft);
}
.banner-hint {
  display: block;
  font-size: var(--fs-meta);
  color: var(--color-text-secondary);
  margin-top: var(--sp-1);
}

.run-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
  gap: var(--sp-6);
  align-items: flex-start;
}
@media (max-width: 1100px) {
  .run-grid { grid-template-columns: 1fr; }
}

.sheet {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--sp-6);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}

.step-header {
  display: flex;
  align-items: flex-start;
  gap: var(--sp-3);
}
.step-header h2 { margin: 0; }
.step-header p { margin: var(--sp-1) 0 0; }
.step-header-body {
  flex: 1;
  min-width: 0;
}
.step-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-3);
}
.count-pill {
  background: var(--color-surface-sunken);
  color: var(--color-text-secondary);
  font-size: var(--fs-meta);
  padding: 2px var(--sp-3);
  border-radius: var(--radius-pill);
  font-weight: 500;
}

.feed-empty {
  margin-top: var(--sp-2);
}

.evidence-stack-item + .evidence-stack-item {
  margin-top: var(--sp-4);
}

.feed-cta {
  margin-top: var(--sp-2);
  display: flex;
  justify-content: flex-end;
}
.feed-cta .btn {
  text-decoration: none;
}

.errors-sheet {
  background: var(--color-danger-soft);
  border-color: rgba(165, 40, 40, 0.18);
  border-left: 4px solid var(--color-danger);
}
.error-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.error-list li {
  display: flex;
  gap: var(--sp-3);
  align-items: baseline;
  padding: var(--sp-2) var(--sp-3);
  background: var(--color-surface);
  border-radius: var(--radius-sm);
  font-size: var(--fs-body);
}
.error-list code {
  background: var(--color-danger-soft);
  color: var(--color-danger);
  padding: 1px var(--sp-2);
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 500;
}
</style>
