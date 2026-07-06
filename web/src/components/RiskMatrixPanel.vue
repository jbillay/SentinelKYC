<script setup>
import { ref, computed, onMounted } from 'vue'
import { useRiskMatrix } from '../composables/useRiskMatrix.js'

// Versioned risk-matrix editor — lives inside the Risk assessment agent's
// admin section. Weighted-factor scoring config (geographic / entity type /
// structural complexity / industry) plus thresholds and screening knockouts.
const {
  active: riskActive,
  versions: riskVersions,
  versionDetail: riskVersionDetail,
  loading: riskLoading,
  saving: riskSaving,
  error: riskError,
  validationErrors: riskValidationErrors,
  load: loadRiskMatrix,
  fetchVersion: fetchRiskVersion,
  createVersion: createRiskVersion,
  setActive: setActiveRiskMatrix,
} = useRiskMatrix()

const riskSelectedVersionId = ref(null)
const riskEditing = ref(false)
const riskEditorBody = ref('')
const riskEditorNotes = ref('')
const riskClientErrors = ref([])
const riskStatus = ref(null)

onMounted(async () => {
  await loadRiskMatrix()
  riskSelectedVersionId.value = riskActive.value?.versionId || riskVersions.value[0]?.id || null
  if (riskSelectedVersionId.value) await fetchRiskVersion(riskSelectedVersionId.value)
})

function fmtMatrixDate(v) {
  if (!v) return '—'
  return new Date(v).toLocaleString()
}

async function selectRiskVersion(id) {
  if (!id) return
  riskEditing.value = false
  riskClientErrors.value = []
  riskSelectedVersionId.value = id
  try {
    await fetchRiskVersion(id)
  } catch {
    /* riskError set */
  }
}

const riskViewBody = computed(() => {
  // Show the fetched version body, falling back to the active matrix body
  // (which is the bundled default when the registry isn't seeded).
  const body =
    riskVersionDetail.value?.id === riskSelectedVersionId.value
      ? riskVersionDetail.value?.body
      : riskActive.value?.body
  if (!body) return ''
  try {
    return JSON.stringify(body, null, 2)
  } catch {
    return ''
  }
})

function startNewRiskVersion() {
  let base = null
  if (riskVersionDetail.value?.id === riskSelectedVersionId.value) base = riskVersionDetail.value?.body
  base = base || riskActive.value?.body || {}
  riskEditorBody.value = JSON.stringify(base, null, 2)
  riskEditorNotes.value = ''
  riskClientErrors.value = []
  riskValidationErrors.value = []
  riskEditing.value = true
}

function cancelNewRiskVersion() {
  riskEditing.value = false
  riskClientErrors.value = []
}

// Lightweight client-side preview only — the server runs the authoritative
// validateMatrix and returns structured validationErrors on a 400.
function clientValidateMatrix(body) {
  const errs = []
  if (!body || typeof body !== 'object' || Array.isArray(body)) return ['matrix body must be a JSON object']
  const w = body.weights
  if (!w || typeof w !== 'object' || Array.isArray(w)) {
    errs.push('missing weights object')
  } else {
    const keys = ['geographic', 'entityType', 'structuralComplexity', 'industry']
    const sum = keys.reduce((a, k) => a + (typeof w[k] === 'number' ? w[k] : 0), 0)
    if (Math.abs(sum - 1) > 0.001) errs.push(`weights must sum to 1.0 ±0.001 (got ${sum})`)
  }
  if (!Array.isArray(body.thresholds) || body.thresholds.length === 0) errs.push('thresholds must be a non-empty array')
  if (!body.factors || typeof body.factors !== 'object') errs.push('missing factors object')
  if (!body.knockouts || typeof body.knockouts !== 'object') errs.push('missing knockouts object')
  return errs
}

async function saveNewRiskVersion() {
  riskStatus.value = null
  riskClientErrors.value = []
  riskValidationErrors.value = []
  let parsed
  try {
    parsed = JSON.parse(riskEditorBody.value)
  } catch (e) {
    riskClientErrors.value = [`Body is not valid JSON: ${e.message}`]
    return
  }
  const ce = clientValidateMatrix(parsed)
  if (ce.length) {
    riskClientErrors.value = ce
    return
  }
  try {
    const created = await createRiskVersion(parsed, riskEditorNotes.value.trim() || null)
    riskStatus.value = `Created v${created.version} — not active. Use “Set active” to switch.`
    riskEditing.value = false
    await selectRiskVersion(created.id)
  } catch {
    /* riskError / riskValidationErrors set by composable */
  }
}

async function onSetActiveRiskMatrix(id) {
  riskStatus.value = null
  try {
    await setActiveRiskMatrix(id)
    riskStatus.value = 'Active matrix updated — applies to the next run / recalculate.'
    await loadRiskMatrix()
  } catch {
    /* riskError set */
  }
}
</script>

<template>
  <section class="sheet sheet--prompts">
    <div class="sheet-head-row">
      <div>
        <h2 class="sheet-title">Risk matrix</h2>
        <p class="sheet-sub">
          Weighted-factor scoring config (geographic / entity type / structural complexity / industry) plus thresholds and screening knockouts.
          Versioned and append-only — saving creates a new version; activate it to apply to the next run or recalculate.
        </p>
      </div>
      <button type="button" class="btn btn--ghost" :disabled="riskLoading" @click="loadRiskMatrix">
        <span class="material-symbols-outlined icon-sm">refresh</span>
        Reload
      </button>
    </div>

    <div v-if="riskError" class="prompt-error">{{ riskError }}</div>
    <div v-if="riskValidationErrors.length" class="prompt-error">
      <div v-for="(e, i) in riskValidationErrors" :key="i">{{ e }}</div>
    </div>
    <div v-if="riskStatus" class="banner">{{ riskStatus }}</div>

    <div class="matrix-active">
      <div>
        <span class="t-label">Active version</span>
        <div class="matrix-active-main">
          <span class="badge">v{{ riskActive?.version ?? '–' }}</span>
          <span v-if="riskActive?.versionId" class="t-mono matrix-active-id">{{ riskActive.versionId.slice(0, 8) }}</span>
          <span v-else class="t-meta">bundled default — registry not yet seeded</span>
        </div>
        <div v-if="riskActive?.notes" class="t-meta matrix-active-notes">{{ riskActive.notes }}</div>
      </div>
      <div class="t-meta">Updated {{ fmtMatrixDate(riskActive?.updatedAt) }}</div>
    </div>

    <div class="prompts-layout">
      <aside class="prompt-rail">
        <div class="matrix-rail-head">
          <span class="t-label">Versions</span>
          <button
            type="button"
            class="btn btn--ghost btn--xs"
            :disabled="riskSaving || riskEditing"
            @click="startNewRiskVersion"
          >
            New version
          </button>
        </div>
        <ul class="prompt-list">
          <li v-if="!riskVersions.length" class="matrix-version-empty">
            No saved versions yet — the bundled default is in use. “New version” forks it into v1.
          </li>
          <li
            v-for="v in riskVersions"
            :key="v.id"
            :class="['prompt-item', { 'prompt-item--active': v.id === riskSelectedVersionId }]"
            @click="selectRiskVersion(v.id)"
          >
            <div class="matrix-version-top">
              <span class="prompt-item-label">v{{ v.version }}</span>
              <span v-if="v.id === riskActive?.versionId" class="badge badge--active">active</span>
              <button
                v-else
                type="button"
                class="btn btn--ghost btn--xs"
                :disabled="riskSaving"
                @click.stop="onSetActiveRiskMatrix(v.id)"
              >
                Set active
              </button>
            </div>
            <div class="prompt-item-key">{{ fmtMatrixDate(v.createdAt) }}</div>
            <div v-if="v.notes" class="prompt-item-meta">{{ v.notes }}</div>
          </li>
        </ul>
      </aside>

      <div class="prompt-editor">
        <template v-if="riskEditing">
          <label class="field">
            <span class="t-label">Matrix body (JSON)</span>
            <textarea v-model="riskEditorBody" class="prompt-body" rows="20" spellcheck="false"></textarea>
          </label>
          <div v-if="riskClientErrors.length" class="prompt-error">
            <div v-for="(e, i) in riskClientErrors" :key="i">{{ e }}</div>
          </div>
          <label class="field">
            <span class="t-label">Notes (optional)</span>
            <input v-model="riskEditorNotes" type="text" placeholder="What changed in this version?" />
          </label>
          <div class="actions">
            <button type="button" class="btn btn--secondary" :disabled="riskSaving" @click="cancelNewRiskVersion">Cancel</button>
            <button
              type="button"
              class="btn btn--primary"
              :disabled="riskSaving || !riskEditorBody.trim()"
              @click="saveNewRiskVersion"
            >
              {{ riskSaving ? 'Saving…' : 'Save as new version' }}
            </button>
          </div>
          <p class="t-meta">A new version is created but stays inactive until you click “Set active”. Existing versions are never edited in place.</p>
        </template>
        <template v-else>
          <div class="prompt-editor-head">
            <div class="prompt-editor-label">
              {{ riskVersionDetail?.id === riskSelectedVersionId ? `v${riskVersionDetail.version}` : 'Active matrix' }} — body
            </div>
          </div>
          <pre class="prompt-default t-mono matrix-view">{{ riskViewBody }}</pre>
        </template>
      </div>
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
.sheet--prompts {
  gap: var(--sp-5);
}
.sheet-title {
  margin: 0;
  font-family: var(--font-display);
  font-size: 18px;
  font-weight: 600;
  color: var(--color-text-primary);
}
.sheet-sub {
  margin: -8px 0 var(--sp-2);
  color: var(--color-text-secondary);
  font-size: var(--fs-meta);
}
.sheet-head-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--sp-4);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
input[type='text'] {
  height: 38px;
  padding: 0 var(--sp-3);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  font: inherit;
}
input[type='text']:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-soft);
}
.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}
.banner {
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--radius-sm);
  background: var(--color-success-soft, #d1fae5);
  color: var(--color-success, #065f46);
  font-size: var(--fs-meta);
}
.prompts-layout {
  display: grid;
  grid-template-columns: 280px 1fr;
  gap: var(--sp-6);
  align-items: start;
}
.prompt-rail {
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--color-page);
}
.prompt-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.prompt-item {
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--color-border);
  cursor: pointer;
  display: flex;
  flex-direction: column;
  gap: 2px;
  transition: background-color var(--dur-fast) var(--ease);
}
.prompt-item:last-child {
  border-bottom: 0;
}
.prompt-item:hover {
  background: var(--color-surface);
}
.prompt-item--active {
  background: var(--color-primary-soft);
}
.prompt-item-label {
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--color-text-primary);
}
.prompt-item-key {
  font-size: 11px;
  color: var(--color-text-tertiary);
}
.prompt-item-meta {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-meta);
  color: var(--color-text-secondary);
  margin-top: 2px;
}
.prompt-editor {
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
}
.prompt-editor-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--sp-4);
}
.prompt-editor-label {
  font-family: var(--font-display);
  font-size: 16px;
  font-weight: 600;
  color: var(--color-text-primary);
}
.badge {
  display: inline-flex;
  align-items: center;
  padding: 2px var(--sp-2);
  border-radius: var(--radius-sm);
  background: var(--color-primary-soft);
  color: var(--color-primary);
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
}
.badge--active {
  background: var(--color-success-soft);
  color: var(--color-success);
}
.prompt-body {
  width: 100%;
  min-height: 240px;
  padding: var(--sp-3);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
  resize: vertical;
}
.prompt-body:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-soft);
}
.prompt-default {
  margin: 0;
  padding: var(--sp-3);
  background: var(--color-page);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  white-space: pre-wrap;
  font-size: 12px;
  color: var(--color-text-secondary);
  max-height: 240px;
  overflow: auto;
}
.prompt-error {
  padding: var(--sp-3);
  background: rgba(220, 53, 69, 0.08);
  border: 1px solid rgba(220, 53, 69, 0.25);
  border-radius: var(--radius-md);
  color: var(--color-danger, #b00020);
  font-size: var(--fs-meta);
}
.btn--xs {
  padding: 3px var(--sp-2);
  font-size: 11px;
  border-radius: var(--radius-sm);
}
.matrix-active {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--sp-4);
  padding: var(--sp-3) var(--sp-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-page);
}
.matrix-active-main {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-1);
}
.matrix-active-id {
  color: var(--color-text-tertiary);
}
.matrix-active-notes {
  margin-top: 2px;
}
.matrix-rail-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--sp-2);
  padding: var(--sp-3) var(--sp-4);
  border-bottom: 1px solid var(--color-border);
  background: var(--color-surface);
}
.matrix-version-top {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.matrix-version-empty {
  padding: var(--sp-4);
  color: var(--color-text-tertiary);
  font-size: var(--fs-meta);
  line-height: 1.5;
}
.matrix-view {
  max-height: 480px;
}
</style>
