<script setup>
import { ref, computed, watch, onMounted } from 'vue'
import { useRoute } from 'vue-router'
import { usePrompts } from '../composables/usePrompts.js'
import { useRiskMatrix } from '../composables/useRiskMatrix.js'
import DataModelTab from '../components/DataModelTab.vue'
import ProcessTab from '../components/ProcessTab.vue'
import AgentsPanel from '../components/AgentsPanel.vue'

const TABS = [
  { id: 'agents', label: 'Agents' },
  { id: 'screening', label: 'Screening' },
  { id: 'risk-matrix', label: 'Risk matrix' },
  { id: 'prompts', label: 'Prompts' },
  { id: 'data-model', label: 'Data model' },
  { id: 'process', label: 'Process' },
  { id: 'members', label: 'Members' },
]

const route = useRoute()
const tab = ref('agents')

const HASH_TAB = {
  '#agents': 'agents',
  '#screening': 'screening',
  '#risk-matrix': 'risk-matrix',
  '#prompts': 'prompts',
  '#data-model': 'data-model',
  '#process': 'process',
  '#members': 'members',
}

onMounted(() => {
  const t = HASH_TAB[route.hash]
  if (t) tab.value = t
})
watch(
  () => route.hash,
  (h) => {
    const t = HASH_TAB[h]
    if (t) tab.value = t
  }
)

const {
  list: promptList,
  detail: promptDetail,
  selectedVersionId,
  editorBody,
  editorNotes,
  saving: promptSaving,
  error: promptError,
  fetchList: fetchPrompts,
  selectKey: selectPromptKey,
  selectVersion: selectPromptVersion,
  saveAsNewVersion,
  setActive: setActiveVersion,
} = usePrompts()
const showDefault = ref(false)

const selectedKey = computed(() => promptDetail.value?.key || null)
const isActiveSelected = computed(
  () => promptDetail.value?.active?.id === selectedVersionId.value
)

watch(
  tab,
  async (val) => {
    if (val === 'prompts' && promptList.value.length === 0) {
      await fetchPrompts()
      const first = promptList.value[0]
      if (first) await selectPromptKey(first.key)
    }
  },
  { immediate: false }
)

async function pickKey(key) {
  showDefault.value = false
  await selectPromptKey(key)
}

async function pickVersion(e) {
  showDefault.value = false
  await selectPromptVersion(e.target.value)
}

// ---- Screening config + sources ----
const screeningLists = ref([])
const screeningCfg = ref({ matchThreshold: 0.85, bingResultsPerSubject: 20 })
const screeningCfgLoading = ref(false)
const screeningCfgSaving = ref(false)
const screeningCfgError = ref(null)
const screeningCfgStatus = ref(null)

async function loadScreeningSettings() {
  screeningCfgLoading.value = true
  screeningCfgError.value = null
  try {
    const [listsRes, cfgRes] = await Promise.all([
      fetch('/api/screening/lists'),
      fetch('/api/screening/config'),
    ])
    if (listsRes.ok) screeningLists.value = await listsRes.json()
    if (cfgRes.ok) screeningCfg.value = await cfgRes.json()
  } catch (err) {
    screeningCfgError.value = err.message
  } finally {
    screeningCfgLoading.value = false
  }
}

async function saveScreeningCfg() {
  screeningCfgSaving.value = true
  screeningCfgStatus.value = null
  screeningCfgError.value = null
  try {
    const res = await fetch('/api/screening/config', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        matchThreshold: Number(screeningCfg.value.matchThreshold),
        bingResultsPerSubject: Number(screeningCfg.value.bingResultsPerSubject),
      }),
    })
    if (!res.ok) {
      const body = await res.json().catch(() => ({}))
      throw new Error(body.error || `save failed: ${res.status}`)
    }
    screeningCfg.value = await res.json()
    screeningCfgStatus.value = 'Saved.'
  } catch (err) {
    screeningCfgError.value = err.message
  } finally {
    screeningCfgSaving.value = false
  }
}

watch(
  tab,
  async (val) => {
    if (val === 'screening' && screeningLists.value.length === 0) {
      await loadScreeningSettings()
    }
  },
  { immediate: false }
)

const LIST_LABEL = {
  ofac_sdn: 'OFAC SDN',
  uk_hmt: 'UK HMT',
}

function fmtListDate(v) {
  if (!v) return '—'
  return new Date(v).toLocaleString()
}

// ---- Risk matrix tab ----
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

const riskLoaded = computed(() => riskActive.value !== null)

watch(
  tab,
  async (val) => {
    if (val === 'risk-matrix' && !riskLoaded.value) {
      await loadRiskMatrix()
      riskSelectedVersionId.value =
        riskActive.value?.versionId || riskVersions.value[0]?.id || null
      if (riskSelectedVersionId.value) await fetchRiskVersion(riskSelectedVersionId.value)
    }
  },
  { immediate: false }
)

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

// ---- Members tab (real application users) ----
const members = ref([])
const membersLoading = ref(false)
const membersError = ref(null)

async function loadMembers() {
  membersLoading.value = true
  membersError.value = null
  try {
    const res = await fetch('/api/admin/users')
    if (!res.ok) throw new Error(`load failed: ${res.status}`)
    const body = await res.json()
    members.value = body.users || []
  } catch (err) {
    membersError.value = err.message
  } finally {
    membersLoading.value = false
  }
}

watch(
  tab,
  async (val) => {
    if (val === 'members' && members.value.length === 0 && !membersLoading.value) {
      await loadMembers()
    }
  },
  { immediate: false }
)

function memberInitials(m) {
  const name = (m.displayName || m.username || '?').trim()
  const parts = name.split(/\s+/)
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase()
  return name.slice(0, 2).toUpperCase()
}

function fmtLogin(v) {
  if (!v) return 'Never'
  return new Date(v).toLocaleString()
}

const activeMemberCount = computed(() => members.value.filter((m) => m.active).length)
</script>

<template>
  <div class="admin">
    <header class="page-head">
      <div>
        <h1 class="t-headline">Admin</h1>
        <p class="t-meta page-sub">Pipeline configuration, prompts, and members. Admin access only.</p>
      </div>
    </header>

    <nav class="tabs">
      <button
        v-for="t in TABS"
        :key="t.id"
        type="button"
        :class="['tab', { 'tab--active': tab === t.id }]"
        @click="tab = t.id"
      >
        {{ t.label }}
      </button>
    </nav>

    <AgentsPanel v-if="tab === 'agents'" id="agents" />

    <section v-if="tab === 'screening'" id="screening" class="sheet">
      <div class="sheet-head-row">
        <div>
          <h2 class="sheet-title">Sanctions sources</h2>
          <p class="sheet-sub">Local snapshots refreshed via the CLI: <code class="t-mono">npm run lists:refresh</code> from <code class="t-mono">server/</code>.</p>
        </div>
        <button
          type="button"
          class="btn btn--ghost"
          :disabled="screeningCfgLoading"
          @click="loadScreeningSettings"
        >
          <span class="material-symbols-outlined icon-sm">refresh</span>
          Reload
        </button>
      </div>

      <div v-if="screeningCfgError" class="prompt-error">{{ screeningCfgError }}</div>

      <ul v-if="screeningLists.length" class="screening-sources">
        <li v-for="s in screeningLists" :key="s.source + s.version" class="screening-source">
          <div>
            <div class="screening-source-name">{{ LIST_LABEL[s.source] || s.source }}</div>
            <div class="screening-source-meta t-mono">version {{ s.version }} · {{ s.recordCount.toLocaleString() }} records</div>
          </div>
          <div class="screening-source-when t-mono">{{ fmtListDate(s.fetchedAt) }}</div>
        </li>
      </ul>
      <p v-else-if="!screeningCfgLoading" class="t-meta">No sanctions snapshots loaded yet — run <code class="t-mono">npm run lists:refresh</code> to populate.</p>

      <div class="divider" />

      <h2 class="sheet-title">Matching &amp; adverse media</h2>
      <p class="sheet-sub">Single global threshold for token-set ratio + Double Metaphone fallback. News results per subject capped server-side.</p>

      <div class="fields">
        <label class="field">
          <span class="t-label">Match threshold (0–1)</span>
          <input
            type="number"
            min="0"
            max="1"
            step="0.01"
            v-model.number="screeningCfg.matchThreshold"
          />
        </label>
        <label class="field">
          <span class="t-label">News results per subject</span>
          <input
            type="number"
            min="1"
            max="100"
            step="1"
            v-model.number="screeningCfg.bingResultsPerSubject"
          />
        </label>
      </div>

      <p class="t-meta">
        <strong>Adverse-media provider</strong> · GDELT 2.0 DOC API — free, no API key required. Optional <code class="t-mono">GDELT_DOC_ENDPOINT</code> / <code class="t-mono">GDELT_TIMESPAN</code> overrides in <code class="t-mono">server/.env</code>.
      </p>

      <div v-if="screeningCfgStatus" class="banner">{{ screeningCfgStatus }}</div>

      <div class="actions">
        <button
          type="button"
          class="btn btn--primary"
          :disabled="screeningCfgSaving"
          @click="saveScreeningCfg"
        >
          {{ screeningCfgSaving ? 'Saving…' : 'Save changes' }}
        </button>
      </div>
    </section>

    <section v-if="tab === 'risk-matrix'" id="risk-matrix" class="sheet sheet--prompts">
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

    <section v-if="tab === 'prompts'" id="prompts" class="sheet sheet--prompts">
      <div class="sheet-head-row">
        <div>
          <h2 class="sheet-title">Prompts</h2>
          <p class="sheet-sub">
            Edit and version the prompts used across the agent pipeline. Saving creates a new
            version; the active version is the one used at runtime, switched instantly.
          </p>
        </div>
      </div>

      <div v-if="promptError" class="prompt-error">{{ promptError }}</div>

      <div class="prompts-layout">
        <aside class="prompt-rail">
          <ul class="prompt-list">
            <li
              v-for="p in promptList"
              :key="p.key"
              :class="['prompt-item', { 'prompt-item--active': p.key === selectedKey }]"
              @click="pickKey(p.key)"
            >
              <div class="prompt-item-label">{{ p.label }}</div>
              <div class="prompt-item-key t-mono">{{ p.key }}</div>
              <div class="prompt-item-meta">
                <span class="t-label">Active</span>
                <span class="tabular">v{{ p.activeVersion ?? '–' }}</span>
                <span v-if="p.latestVersion && p.latestVersion !== p.activeVersion" class="prompt-item-stale">
                  · latest v{{ p.latestVersion }}
                </span>
              </div>
            </li>
          </ul>
        </aside>

        <div v-if="promptDetail" class="prompt-editor">
          <div class="prompt-editor-head">
            <div>
              <div class="prompt-editor-label">{{ promptDetail.label }}</div>
              <div class="prompt-editor-desc">{{ promptDetail.description }}</div>
            </div>
            <div class="prompt-editor-active">
              <span class="t-label">Active</span>
              <span class="badge">v{{ promptDetail.active?.version ?? '–' }}</span>
            </div>
          </div>

          <label class="field">
            <span class="t-label">Version</span>
            <select :value="selectedVersionId" @change="pickVersion">
              <option
                v-for="v in promptDetail.versions"
                :key="v.id"
                :value="v.id"
              >
                v{{ v.version }}{{ promptDetail.active?.id === v.id ? ' (active)' : '' }}
                · {{ new Date(v.createdAt).toLocaleString() }}
                {{ v.notes ? '— ' + v.notes : '' }}
              </option>
            </select>
          </label>

          <label class="field">
            <span class="t-label">Body</span>
            <textarea v-model="editorBody" class="prompt-body" rows="14"></textarea>
          </label>

          <label class="field">
            <span class="t-label">Notes (optional)</span>
            <input
              v-model="editorNotes"
              type="text"
              placeholder="What changed in this version?"
            />
          </label>

          <div class="actions">
            <button
              type="button"
              class="btn btn--ghost"
              @click="showDefault = !showDefault"
            >
              {{ showDefault ? 'Hide default' : 'Show default body' }}
            </button>
            <div class="actions-spacer" />
            <button
              type="button"
              class="btn btn--secondary"
              :disabled="promptSaving || isActiveSelected"
              @click="setActiveVersion()"
            >
              Set as active
            </button>
            <button
              type="button"
              class="btn btn--primary"
              :disabled="promptSaving || !editorBody.trim()"
              @click="saveAsNewVersion()"
            >
              Save as new version
            </button>
          </div>

          <pre v-if="showDefault" class="prompt-default t-mono">{{ promptDetail.defaultBody }}</pre>
        </div>

        <div v-else class="prompt-empty">Select a prompt to view its versions.</div>
      </div>
    </section>

    <DataModelTab v-if="tab === 'data-model'" />

    <ProcessTab v-if="tab === 'process'" />

    <section v-if="tab === 'members'" id="members" class="sheet">
      <div class="sheet-head-row">
        <div>
          <h2 class="sheet-title">Members</h2>
          <p class="sheet-sub">
            {{ activeMemberCount }} active · {{ members.length }} total — application users with sign-in access.
          </p>
        </div>
        <button
          type="button"
          class="btn btn--ghost"
          :disabled="membersLoading"
          @click="loadMembers"
        >
          <span class="material-symbols-outlined icon-sm">refresh</span>
          Reload
        </button>
      </div>

      <div v-if="membersError" class="prompt-error">{{ membersError }}</div>

      <p v-if="membersLoading && !members.length" class="t-meta">Loading members…</p>
      <p v-else-if="!members.length && !membersError" class="t-meta">No members found.</p>

      <ul v-if="members.length" class="members">
        <li v-for="m in members" :key="m.id" :class="['member', { 'member--inactive': !m.active }]">
          <span class="avatar">{{ memberInitials(m) }}</span>
          <div class="member-body">
            <div class="member-name">
              {{ m.displayName || m.username }}
              <span v-if="!m.active" class="status-pill status-pill--inactive">Inactive</span>
            </div>
            <div class="member-email t-mono">{{ m.email || m.username }}</div>
          </div>
          <div class="member-meta">
            <span class="t-label">Last sign-in</span>
            <span class="tabular t-mono">{{ fmtLogin(m.lastLoginAt) }}</span>
          </div>
          <span :class="['role-tag', `role-tag--${m.role}`]">{{ m.role }}</span>
        </li>
      </ul>

      <p class="t-meta">
        Members are provisioned via <code class="t-mono">npm run users:seed</code> from <code class="t-mono">server/</code>. In-app invite and role management are not part of this build.
      </p>
    </section>
  </div>
</template>

<style scoped>
.admin {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}
.page-head h1 { margin: 0; }
.page-sub { margin: var(--sp-1) 0 0; }

.tabs {
  display: flex;
  gap: 0;
  border-bottom: 1px solid var(--color-border);
}
.tab {
  background: transparent;
  border: 0;
  padding: var(--sp-3) var(--sp-4);
  font-size: var(--fs-body);
  font-weight: 500;
  color: var(--color-text-secondary);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  transition: color var(--dur-fast) var(--ease),
              border-color var(--dur-fast) var(--ease);
}
.tab:hover { color: var(--color-text-primary); }
.tab--active {
  color: var(--color-primary);
  border-bottom-color: var(--color-primary);
}

.sheet {
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  padding: var(--sp-8);
  display: flex;
  flex-direction: column;
  gap: var(--sp-4);
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

.fields {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-4);
}
.field {
  display: flex;
  flex-direction: column;
  gap: var(--sp-2);
}
input[type='text'],
input[type='number'],
select {
  height: 38px;
  padding: 0 var(--sp-3);
  background: var(--color-surface);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  color: var(--color-text-primary);
  font: inherit;
}
input[type='text']:focus,
input[type='number']:focus,
select:focus {
  outline: none;
  border-color: var(--color-primary);
  box-shadow: 0 0 0 3px var(--color-primary-soft);
}

.divider {
  height: 1px;
  background: var(--color-border);
  margin: var(--sp-2) 0;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}

.members {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.member {
  display: grid;
  grid-template-columns: auto 1fr auto auto;
  align-items: center;
  gap: var(--sp-4);
  padding: var(--sp-3) 0;
  border-bottom: 1px solid var(--color-border);
}
.member:last-child { border-bottom: 0; }
.member--inactive { opacity: 0.6; }

.avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--color-primary-soft);
  color: var(--color-primary);
  font-size: 12px;
  font-weight: 600;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.member-name {
  font-weight: 500;
  color: var(--color-text-primary);
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.member-email {
  font-size: var(--fs-meta);
  color: var(--color-text-tertiary);
  margin-top: 2px;
}
.member-meta {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: var(--fs-meta);
  color: var(--color-text-secondary);
  text-align: right;
}

.status-pill {
  display: inline-block;
  padding: 1px var(--sp-2);
  border-radius: var(--radius-sm);
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
}
.status-pill--inactive {
  background: var(--color-surface-sunken);
  color: var(--color-text-tertiary);
}

.role-tag {
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
.role-tag--admin {
  background: var(--color-primary-soft);
  color: var(--color-primary);
}
.role-tag--reviewer {
  background: var(--color-tertiary-soft, var(--color-surface-sunken));
  color: var(--color-tertiary, var(--color-text-secondary));
}

.sheet--prompts { gap: var(--sp-5); }
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
.prompt-item:last-child { border-bottom: 0; }
.prompt-item:hover { background: var(--color-surface); }
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
.prompt-item-stale {
  color: var(--color-tertiary, var(--color-text-tertiary));
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
.prompt-editor-desc {
  font-size: var(--fs-meta);
  color: var(--color-text-secondary);
  margin-top: 2px;
}
.prompt-editor-active {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
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
.actions-spacer { flex: 1; }
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
.prompt-empty {
  padding: var(--sp-6);
  color: var(--color-text-tertiary);
}
.prompt-error {
  padding: var(--sp-3);
  background: rgba(220, 53, 69, 0.08);
  border: 1px solid rgba(220, 53, 69, 0.25);
  border-radius: var(--radius-md);
  color: var(--color-danger, #b00020);
  font-size: var(--fs-meta);
}

.screening-sources {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.screening-source {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: var(--sp-3);
  padding: var(--sp-3) 0;
  border-bottom: 1px solid var(--color-border);
}
.screening-source:last-child { border-bottom: 0; }
.screening-source-name { font-weight: 500; color: var(--color-text-primary); }
.screening-source-meta { font-size: var(--fs-meta); color: var(--color-text-tertiary); margin-top: 2px; }
.screening-source-when { font-size: var(--fs-meta); color: var(--color-text-tertiary); }
.banner {
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--radius-sm);
  background: var(--color-success-soft, #d1fae5);
  color: var(--color-success, #065f46);
  font-size: var(--fs-meta);
}

/* ── Risk matrix tab ── */
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
.matrix-active-id { color: var(--color-text-tertiary); }
.matrix-active-notes { margin-top: 2px; }
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
.badge--active {
  background: var(--color-success-soft);
  color: var(--color-success);
}
.matrix-view {
  max-height: 480px;
}
</style>
