<script setup>
// Phase 5 / Q5 — Final Decision Panel (active runs only).
//
// Renders the QA banner from runs.qaResult, then a four-button action row.
// Each action lazy-opens its own form below the row (Approve uses a native
// <dialog> instead). Forms validate locally with decisionPayloadSchema so
// the user gets feedback before hitting the network; the server re-validates
// using the same schema.
//
// Gate: dossier.caseStatus must be in a non-terminal state and qaResult
// must be present. Once submitted, useDecision returns 200 and we redirect
// the reviewer back to /dossiers.

import { computed, nextTick, ref, watch } from 'vue'
import {
  decisionPayloadSchema,
  REASON_CODES,
  REASON_CODE_LABELS,
} from '../lib/decisionSchema.js'
import { useDecision } from '../composables/useDecision.js'
import { useDecisionStore } from '../stores/decision.js'
import QaNarrative from './QaNarrative.vue'

const props = defineProps({
  companyNumber: { type: String, required: true },
  runId: { type: String, required: true },
  qaResult: { type: Object, default: null },
  qaNarrative: { type: Object, default: null },
  caseStatus: { type: String, default: null },
})

const emit = defineEmits(['decision-submitted', 'case-status-stale'])

const TERMINAL_FROM = new Set(['approved', 'rejected'])

const decisionStore = useDecisionStore()
const { submitting, error: submitError, validationErrors, submitDecision } = useDecision()

const TERMINAL = new Set(['approved', 'rejected'])
// case_status the panel is willing to act on. With the await_decision
// interrupt the run pauses and case_status stays 'pending' until the
// reviewer acts, so pending is also a valid entry-point — the gate is
// "QA produced a result AND the dossier hasn't been finalised yet".
const ELIGIBLE = new Set([
  'pending',
  'auto_approved',
  'streamlined_review',
  'standard_review',
  'info_requested',
  'escalated',
])

const canRender = computed(
  () => !!props.qaResult && ELIGIBLE.has(props.caseStatus)
)

const isTerminal = computed(() => TERMINAL.has(props.caseStatus))

// Approve is allowed from any eligible state — the dialog confirm + audit
// fragment is the bar. (Older comment about "approve only from auto/streamlined/
// standard" no longer holds now that pending is the in-flight state.)
const canApprove = computed(() => ELIGIBLE.has(props.caseStatus))

const routing = computed(() => props.qaResult?.routing?.caseStatus || null)
const summary = computed(
  () => props.qaResult?.qaSummary || props.qaResult?.routing?.qaSummary || ''
)
const highlightedIssues = computed(() => props.qaResult?.highlightedIssues || [])

// Banner tone — driven by QA routing (the *just-computed* recommendation),
// not by case_status (which may already reflect a reviewer step).
const bannerTone = computed(() => {
  if (routing.value === 'auto_approved') return 'ok'
  if (routing.value === 'streamlined_review') return 'info'
  if (routing.value === 'standard_review') return 'warn'
  return 'info'
})

const BANNER_LABEL = {
  auto_approved: 'QA passed — auto-approved',
  streamlined_review: 'QA passed — streamlined review',
  standard_review: 'QA flagged issues — standard review',
}
const bannerLabel = computed(() => BANNER_LABEL[routing.value] || 'QA result')

const ACTIONS = [
  { id: 'approve', label: 'Approve', icon: 'check_circle', variant: 'primary' },
  { id: 'reject', label: 'Reject', icon: 'block', variant: 'danger' },
  { id: 'escalate', label: 'Escalate', icon: 'flag', variant: 'secondary' },
  { id: 'request_info', label: 'Request info', icon: 'help', variant: 'secondary' },
]

const openAction = computed({
  get() { return decisionStore.getOpenAction(props.runId) },
  set(v) { decisionStore.setOpenAction(props.runId, v) },
})

function toggleAction(id) {
  if (id === 'approve') {
    openApproveDialog()
    return
  }
  openAction.value = openAction.value === id ? null : id
  submitError.value = null
  validationErrors.value = null
}

// ──────────────────────── Reject form ────────────────────────
const rejectDraft = computed(() => decisionStore.getDraft(props.runId, 'reject'))
const rejectErrors = ref({})

const rejectValid = computed(() => {
  const d = rejectDraft.value
  if (!d) return false
  if (!d.reasonCode) return false
  if (!d.freeText || d.freeText.trim().length < 10) return false
  return true
})

async function onSubmitReject() {
  rejectErrors.value = {}
  const d = rejectDraft.value
  if (!d.reasonCode) rejectErrors.value.reasonCode = 'Select a reason code.'
  if (!d.freeText || d.freeText.trim().length < 10) {
    rejectErrors.value.freeText = 'Add at least 10 characters of context.'
  }
  if (Object.keys(rejectErrors.value).length) return
  const payload = {
    action: 'reject',
    userId: 'local-user',
    reasonCode: d.reasonCode,
    freeText: d.freeText.trim(),
  }
  await submit(payload)
}

// ──────────────────────── Escalate form ────────────────────────
const escalateDraft = computed(() => decisionStore.getDraft(props.runId, 'escalate'))
const escalateErrors = ref({})

const escalateValid = computed(() => {
  const d = escalateDraft.value
  if (!d) return false
  return d.notes && d.notes.trim().length >= 10
})

async function onSubmitEscalate() {
  escalateErrors.value = {}
  const d = escalateDraft.value
  if (!d.notes || d.notes.trim().length < 10) {
    escalateErrors.value.notes = 'Add at least 10 characters of context.'
  }
  if (Object.keys(escalateErrors.value).length) return
  const payload = {
    action: 'escalate',
    userId: 'local-user',
    notes: d.notes.trim(),
  }
  if (d.suggestedAction && d.suggestedAction.trim()) {
    payload.suggestedAction = d.suggestedAction.trim()
  }
  await submit(payload)
}

// ──────────────────────── Request info form ────────────────────────
const requestInfoDraft = computed(() => decisionStore.getDraft(props.runId, 'request_info'))
const requestInfoErrors = ref({})

const requestInfoValid = computed(() => {
  const d = requestInfoDraft.value
  if (!d) return false
  const items = d.items.filter(
    (it) => it.description?.trim().length >= 3 && it.category?.trim().length >= 1
  )
  return items.length >= 1
})

async function onSubmitRequestInfo() {
  requestInfoErrors.value = {}
  const d = requestInfoDraft.value
  const items = d.items
    .map((it) => ({
      description: it.description?.trim() || '',
      category: it.category?.trim() || '',
    }))
    .filter((it) => it.description.length >= 3 && it.category.length >= 1)
  if (items.length === 0) {
    requestInfoErrors.value.items = 'Add at least one item (description ≥ 3 chars, category ≥ 1 char).'
    return
  }
  const payload = {
    action: 'request_info',
    userId: 'local-user',
    items,
  }
  await submit(payload)
}

// ──────────────────────── Approve dialog ────────────────────────
const approveDialog = ref(null)

function openApproveDialog() {
  submitError.value = null
  validationErrors.value = null
  nextTick(() => {
    if (approveDialog.value?.showModal) {
      approveDialog.value.showModal()
    }
  })
}

function cancelApprove() {
  if (approveDialog.value?.close) approveDialog.value.close()
}

async function confirmApprove() {
  const payload = { action: 'approve', userId: 'local-user' }
  // Close before submit so the dialog can't intercept the redirect.
  if (approveDialog.value?.close) approveDialog.value.close()
  await submit(payload)
}

// ──────────────────────── Submit + redirect ────────────────────────
async function submit(payload) {
  // Final client-side validation against the shared Zod schema.
  const parsed = decisionPayloadSchema.safeParse(payload)
  if (!parsed.success) {
    validationErrors.value = parsed.error.issues
    submitError.value = 'Form validation failed locally.'
    return
  }
  try {
    const result = await submitDecision({
      companyNumber: props.companyNumber,
      runId: props.runId,
      payload: parsed.data,
    })
    emit('decision-submitted', result)
    decisionStore.clearAll(props.runId)
    // No router push here — the parent owns navigation. The Run page picks up
    // the SSE 'done' event (graph resumed by /decision) and redirects to the
    // dossier. The dossier page only emits a local refresh.
  } catch (err) {
    // submitError/validationErrors are already set by the composable.
    // Issue 1C — if the server says the dossier is already finalised, tell
    // the parent so it can patch its caseStatus and the panel flips into
    // the read-only "Decision finalized" branch on the next render.
    const from = err?.body?.from
    if (err?.status === 409 && from && TERMINAL_FROM.has(from)) {
      emit('case-status-stale', from)
    }
  }
}

// Anchor links scroll within the dossier page; no router push.
function scrollToAnchor(anchor) {
  if (!anchor) return
  const id = anchor.replace(/^#/, '')
  const el = document.getElementById(id)
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// If the panel becomes ineligible (e.g. a refresh changed case_status to
// approved while a form was open), close the form so the gate logic is
// internally consistent.
watch(canRender, (v) => {
  if (!v) openAction.value = null
})
</script>

<template>
  <section v-if="canRender" class="decision-panel" :class="`decision-panel--${bannerTone}`">
    <header class="banner">
      <div class="banner-main">
        <span class="material-symbols-outlined banner-icon">
          {{ bannerTone === 'ok' ? 'verified' : bannerTone === 'warn' ? 'warning' : 'info' }}
        </span>
        <div class="banner-text">
          <div class="banner-label t-label">{{ bannerLabel }}</div>
          <p class="banner-summary">{{ summary }}</p>
          <span :class="['case-status', `case-status--${caseStatus}`]">
            {{ caseStatus.replace('_', ' ') }}
          </span>
        </div>
      </div>
    </header>

    <ul v-if="highlightedIssues.length" class="issues">
      <li
        v-for="(issue, idx) in highlightedIssues"
        :key="`${issue.code}-${idx}`"
        :class="['issue', `issue--${issue.severity}`]"
      >
        <button
          v-if="issue.anchor"
          type="button"
          class="issue-anchor"
          @click="scrollToAnchor(issue.anchor)"
        >
          <span class="material-symbols-outlined icon-sm">
            {{ issue.severity === 'high' ? 'priority_high' : issue.severity === 'medium' ? 'error' : 'info' }}
          </span>
          <span class="issue-msg">{{ issue.message }}</span>
          <span class="t-mono issue-code">{{ issue.code }}</span>
        </button>
        <div v-else class="issue-anchor issue-anchor--static">
          <span class="material-symbols-outlined icon-sm">
            {{ issue.severity === 'high' ? 'priority_high' : 'info' }}
          </span>
          <span class="issue-msg">{{ issue.message }}</span>
        </div>
      </li>
    </ul>

    <div v-if="submitError && !openAction" class="form-error" role="alert">
      {{ submitError }}
    </div>

    <div class="actions">
      <button
        v-for="a in ACTIONS"
        :key="a.id"
        type="button"
        :class="['btn', `btn--${a.variant}`, { 'btn--active': openAction === a.id }]"
        :disabled="submitting || (a.id === 'approve' && !canApprove)"
        @click="toggleAction(a.id)"
      >
        <span class="material-symbols-outlined icon-sm">{{ a.icon }}</span>
        {{ a.label }}
      </button>
    </div>

    <!-- Reject form -->
    <form
      v-if="openAction === 'reject'"
      class="form"
      @submit.prevent="onSubmitReject"
    >
      <h3 class="form-title">Reject case</h3>
      <details v-if="qaNarrative" class="narrative-summary" open>
        <summary>QA recommendation narrative</summary>
        <QaNarrative :narrative="qaNarrative" :compact="true" />
      </details>
      <label class="field">
        <span class="t-label">Reason code</span>
        <select
          :value="rejectDraft.reasonCode"
          :disabled="submitting"
          @change="decisionStore.setReject(runId, { reasonCode: $event.target.value })"
        >
          <option value="" disabled>— Select —</option>
          <option v-for="code in REASON_CODES" :key="code" :value="code">
            {{ REASON_CODE_LABELS[code] }}
          </option>
        </select>
        <span v-if="rejectErrors.reasonCode" class="field-error">{{ rejectErrors.reasonCode }}</span>
      </label>
      <label class="field">
        <span class="t-label">
          Context
          <span class="char-counter tabular">
            {{ (rejectDraft.freeText || '').length }} / 10+
          </span>
        </span>
        <textarea
          rows="4"
          :value="rejectDraft.freeText"
          :disabled="submitting"
          placeholder="What evidence backs this rejection?"
          @input="decisionStore.setReject(runId, { freeText: $event.target.value })"
        />
        <span v-if="rejectErrors.freeText" class="field-error">{{ rejectErrors.freeText }}</span>
      </label>
      <div v-if="submitError" class="form-error" role="alert">{{ submitError }}</div>
      <div class="form-actions">
        <button type="button" class="btn btn--ghost" :disabled="submitting" @click="openAction = null">Cancel</button>
        <button
          type="submit"
          class="btn btn--danger"
          :disabled="!rejectValid || submitting"
        >
          {{ submitting ? 'Submitting…' : 'Confirm reject' }}
        </button>
      </div>
    </form>

    <!-- Escalate form -->
    <form
      v-else-if="openAction === 'escalate'"
      class="form"
      @submit.prevent="onSubmitEscalate"
    >
      <h3 class="form-title">Escalate case</h3>
      <details v-if="qaNarrative" class="narrative-summary" open>
        <summary>QA recommendation narrative</summary>
        <QaNarrative :narrative="qaNarrative" :compact="true" />
      </details>
      <label class="field">
        <span class="t-label">
          Notes
          <span class="char-counter tabular">
            {{ (escalateDraft.notes || '').length }} / 10+
          </span>
        </span>
        <textarea
          rows="4"
          :value="escalateDraft.notes"
          :disabled="submitting"
          placeholder="Why does this need a second pair of eyes?"
          @input="decisionStore.setEscalate(runId, { notes: $event.target.value })"
        />
        <span v-if="escalateErrors.notes" class="field-error">{{ escalateErrors.notes }}</span>
      </label>
      <label class="field">
        <span class="t-label">Suggested action (optional)</span>
        <input
          type="text"
          :value="escalateDraft.suggestedAction"
          :disabled="submitting"
          placeholder="e.g. Send to financial-crime team"
          @input="decisionStore.setEscalate(runId, { suggestedAction: $event.target.value })"
        />
      </label>
      <div v-if="submitError" class="form-error" role="alert">{{ submitError }}</div>
      <div class="form-actions">
        <button type="button" class="btn btn--ghost" :disabled="submitting" @click="openAction = null">Cancel</button>
        <button
          type="submit"
          class="btn btn--secondary"
          :disabled="!escalateValid || submitting"
        >
          {{ submitting ? 'Submitting…' : 'Confirm escalate' }}
        </button>
      </div>
    </form>

    <!-- Request info form -->
    <form
      v-else-if="openAction === 'request_info'"
      class="form"
      @submit.prevent="onSubmitRequestInfo"
    >
      <h3 class="form-title">Request information</h3>
      <details v-if="qaNarrative" class="narrative-summary" open>
        <summary>QA recommendation narrative</summary>
        <QaNarrative :narrative="qaNarrative" :compact="true" />
      </details>
      <p class="t-meta form-hint">
        List each missing item the subject needs to provide. There is no
        outbound notification in this POC — the items are recorded on the case
        and the status flips to "info requested".
      </p>
      <ul class="info-items">
        <li
          v-for="(item, idx) in requestInfoDraft.items"
          :key="idx"
          class="info-item"
        >
          <input
            type="text"
            :value="item.description"
            :disabled="submitting"
            placeholder="Description (≥ 3 chars)"
            @input="decisionStore.setRequestInfoItem(runId, idx, { description: $event.target.value })"
          />
          <input
            type="text"
            :value="item.category"
            :disabled="submitting"
            placeholder="Category (e.g. id, address)"
            @input="decisionStore.setRequestInfoItem(runId, idx, { category: $event.target.value })"
          />
          <button
            type="button"
            class="btn btn--ghost btn--sm"
            :disabled="requestInfoDraft.items.length <= 1 || submitting"
            @click="decisionStore.removeRequestInfoItem(runId, idx)"
          >
            <span class="material-symbols-outlined icon-sm">remove</span>
          </button>
        </li>
      </ul>
      <button
        type="button"
        class="btn btn--ghost btn--sm add-item"
        :disabled="submitting"
        @click="decisionStore.addRequestInfoItem(runId)"
      >
        <span class="material-symbols-outlined icon-sm">add</span>
        Add item
      </button>
      <span v-if="requestInfoErrors.items" class="field-error">{{ requestInfoErrors.items }}</span>
      <div v-if="submitError" class="form-error" role="alert">{{ submitError }}</div>
      <div class="form-actions">
        <button type="button" class="btn btn--ghost" :disabled="submitting" @click="openAction = null">Cancel</button>
        <button
          type="submit"
          class="btn btn--secondary"
          :disabled="!requestInfoValid || submitting"
        >
          {{ submitting ? 'Submitting…' : 'Confirm request' }}
        </button>
      </div>
    </form>

    <!-- Approve confirm dialog -->
    <dialog ref="approveDialog" class="confirm-dialog">
      <h3 class="form-title">Approve case</h3>
      <details v-if="qaNarrative" class="narrative-summary" open>
        <summary>QA recommendation narrative</summary>
        <QaNarrative :narrative="qaNarrative" :compact="true" />
      </details>
      <p>
        Are you sure?
        <span v-if="caseStatus === 'standard_review'">
          This case is in <strong>standard review</strong> — you are overriding the QA recommendation.
        </span>
        This action cannot be undone.
      </p>
      <div v-if="submitError" class="form-error" role="alert">{{ submitError }}</div>
      <div class="form-actions">
        <button type="button" class="btn btn--ghost" :disabled="submitting" @click="cancelApprove">Cancel</button>
        <button
          type="button"
          class="btn btn--primary"
          :disabled="submitting"
          @click="confirmApprove"
        >
          {{ submitting ? 'Approving…' : 'Confirm approve' }}
        </button>
      </div>
    </dialog>
  </section>

  <section v-else-if="isTerminal" class="decision-panel decision-panel--terminal">
    <header class="banner">
      <div class="banner-main">
        <span class="material-symbols-outlined banner-icon">
          {{ caseStatus === 'approved' ? 'verified' : 'block' }}
        </span>
        <div class="banner-text">
          <div class="banner-label t-label">Decision finalized</div>
          <p class="banner-summary">
            This case is <strong>{{ caseStatus }}</strong>. Reopening is not supported in v1.
          </p>
          <span :class="['case-status', `case-status--${caseStatus}`]">
            {{ caseStatus }}
          </span>
        </div>
      </div>
    </header>
  </section>
</template>

<style scoped>
.decision-panel {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--sp-6) var(--sp-8);
  box-shadow: var(--shadow-sheet);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  border-left: 4px solid var(--color-border-strong);
}
.decision-panel--ok { border-left-color: var(--color-success); }
.decision-panel--info { border-left-color: var(--color-primary); }
.decision-panel--warn { border-left-color: var(--color-warning); }
.decision-panel--terminal { border-left-color: var(--color-text-tertiary); }

.banner {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--sp-4);
}
.banner-main {
  display: flex;
  gap: var(--sp-3);
  align-items: flex-start;
}
.banner-icon {
  font-size: 28px;
  margin-top: 2px;
}
.decision-panel--ok .banner-icon { color: var(--color-success); }
.decision-panel--info .banner-icon { color: var(--color-primary); }
.decision-panel--warn .banner-icon { color: var(--color-warning); }
.decision-panel--terminal .banner-icon { color: var(--color-text-tertiary); }

.banner-text {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.banner-label {
  color: var(--color-text-secondary);
}
.banner-summary {
  margin: 0;
  color: var(--color-text-primary);
  font-size: var(--fs-body);
  line-height: 1.5;
}

.issues {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
  border-top: 1px solid var(--color-border);
  padding-top: var(--sp-3);
}
.issue {
  display: flex;
}
.issue-anchor {
  display: grid;
  grid-template-columns: 24px 1fr auto;
  gap: var(--sp-2);
  align-items: center;
  width: 100%;
  padding: var(--sp-2) var(--sp-3);
  background: transparent;
  border: 0;
  border-radius: var(--radius-sm);
  text-align: left;
  color: var(--color-text-primary);
  cursor: pointer;
  font: inherit;
  transition: background-color var(--dur-fast) var(--ease);
}
.issue-anchor:hover {
  background: var(--color-page);
}
.issue-anchor--static {
  cursor: default;
}
.issue-anchor--static:hover {
  background: transparent;
}
.issue-msg {
  font-size: var(--fs-body);
}
.issue-code {
  color: var(--color-text-tertiary);
  font-size: 11px;
}
.issue--high .material-symbols-outlined { color: var(--color-danger); }
.issue--medium .material-symbols-outlined { color: var(--color-warning); }
.issue--low .material-symbols-outlined { color: var(--color-text-tertiary); }

.actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--sp-3);
  border-top: 1px solid var(--color-border);
  padding-top: var(--sp-4);
}
.btn--danger {
  background: var(--color-danger);
  color: var(--color-text-on-primary);
  border-color: var(--color-danger);
}
.btn--danger:hover:not(:disabled) {
  background: #8a1f1f;
  border-color: #8a1f1f;
}
.btn--active {
  box-shadow: inset 0 0 0 2px var(--color-primary);
}

.form {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
  padding: var(--sp-4) var(--sp-6);
  background: var(--color-page);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
}
.form-title {
  margin: 0;
  font-size: var(--fs-title);
  font-weight: 600;
}
.form-hint {
  margin: calc(-1 * var(--sp-2)) 0 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-1);
}
.field .t-label {
  display: flex;
  justify-content: space-between;
  gap: var(--sp-2);
  color: var(--color-text-secondary);
}
.char-counter {
  font-size: 11px;
  color: var(--color-text-tertiary);
  text-transform: none;
  letter-spacing: 0;
}
.field input,
.field select,
.field textarea {
  font: inherit;
  color: var(--color-text-primary);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--sp-2) var(--sp-3);
}
.field input:focus,
.field select:focus,
.field textarea:focus {
  outline: 0;
  border-color: var(--color-primary);
}
.field textarea {
  resize: vertical;
  min-height: 80px;
}
.field-error {
  font-size: 11px;
  color: var(--color-danger);
}
.form-error {
  border-left: 3px solid var(--color-danger);
  background: var(--color-danger-soft);
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--radius-sm);
  font-size: var(--fs-meta);
  color: var(--color-danger);
}

.info-items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
.info-item {
  display: grid;
  grid-template-columns: 2fr 1fr auto;
  gap: var(--sp-2);
  align-items: center;
}
.info-item input {
  font: inherit;
  color: var(--color-text-primary);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--sp-2) var(--sp-3);
}
.add-item {
  align-self: flex-start;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  border-top: 1px solid var(--color-border);
  padding-top: var(--sp-3);
}

.btn--sm {
  height: 30px;
  padding: 0 var(--sp-3);
  font-size: var(--fs-meta);
}

.confirm-dialog {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--sp-6);
  background: var(--color-surface);
  box-shadow: 0 8px 24px rgba(16, 20, 24, 0.16);
  color: var(--color-text-primary);
  max-width: 480px;
  width: 90vw;
}
.confirm-dialog::backdrop {
  background: rgba(16, 20, 24, 0.4);
}
.confirm-dialog p {
  margin: var(--sp-3) 0;
  line-height: 1.55;
  color: var(--color-text-secondary);
}

.narrative-summary {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-sm);
  padding: 0 var(--sp-3);
}
.narrative-summary[open] {
  padding: var(--sp-2) var(--sp-3) var(--sp-3);
}
.narrative-summary > summary {
  cursor: pointer;
  font-size: var(--fs-meta);
  font-weight: 600;
  color: var(--color-text-secondary);
  padding: var(--sp-2) 0;
  list-style: none;
  user-select: none;
}
.narrative-summary > summary::-webkit-details-marker {
  display: none;
}
.narrative-summary > summary::before {
  content: '▸';
  display: inline-block;
  margin-right: var(--sp-2);
  transition: transform var(--dur-fast) var(--ease);
}
.narrative-summary[open] > summary::before {
  transform: rotate(90deg);
}
</style>
