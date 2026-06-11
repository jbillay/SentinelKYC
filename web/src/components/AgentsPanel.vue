<script setup>
import { reactive, computed, onMounted } from 'vue'
import { useAgents } from '../composables/useAgents.js'
import { useAuthStore } from '../stores/auth.js'

const { agents, loading, saving, error, fetchAgents, setEnabled, saveConfig } = useAgents()
const auth = useAuthStore()
const canEdit = computed(() => auth.hasRole('admin'))

// Per-agent editable draft of the config fields (excluding `enabled`, which
// the toggle owns). Rebuilt whenever the server state refreshes.
const drafts = reactive({})

function seedDraft(agent) {
  const d = {}
  for (const f of agent.fields) d[f.key] = agent.config?.[f.key]
  drafts[agent.id] = d
}

function seedAll() {
  for (const a of agents.value) seedDraft(a)
}

onMounted(async () => {
  await fetchAgents()
  seedAll()
})

function isDirty(agent) {
  const d = drafts[agent.id]
  if (!d) return false
  return agent.fields.some(
    (f) => JSON.stringify(coerce(f, d[f.key])) !== JSON.stringify(agent.config?.[f.key])
  )
}

function coerce(field, value) {
  if (field.type === 'number') {
    const n = Number(value)
    return Number.isFinite(n) ? n : value
  }
  if (field.type === 'boolean') return !!value
  if (field.type === 'multiselect') return Array.isArray(value) ? value : []
  return value
}

function toggleMulti(agentId, key, opt, checked) {
  const current = Array.isArray(drafts[agentId]?.[key]) ? [...drafts[agentId][key]] : []
  const ix = current.indexOf(opt)
  if (checked && ix === -1) current.push(opt)
  if (!checked && ix !== -1) current.splice(ix, 1)
  drafts[agentId][key] = current
}

async function onToggle(agent, e) {
  const enabled = e.target.checked
  await setEnabled(agent.id, enabled)
  const fresh = agents.value.find((a) => a.id === agent.id)
  if (fresh) seedDraft(fresh)
}

async function onSave(agent) {
  const d = drafts[agent.id]
  const body = { ...agent.config, enabled: agent.enabled }
  for (const f of agent.fields) body[f.key] = coerce(f, d[f.key])
  const ok = await saveConfig(agent.id, body)
  if (ok) {
    const fresh = agents.value.find((a) => a.id === agent.id)
    if (fresh) seedDraft(fresh)
  }
}

function onReset(agent) {
  seedDraft(agent)
}
</script>

<template>
  <section class="sheet">
    <h2 class="sheet-title">Agents</h2>
    <p class="sheet-sub">
      Enable or disable pipeline agents and tune their behaviour. Changes are versioned and apply to the
      next run — no restart. Disabling screening or risk assessment forces every affected case to standard
      review: a partially assessed case is never auto-approved.
    </p>

    <p v-if="error" class="form-msg form-msg--error" role="alert">{{ error }}</p>
    <p v-if="loading" class="t-meta">Loading agents…</p>

    <div v-for="agent in agents" :key="agent.id" class="agent-card" :class="{ 'agent-card--off': !agent.enabled }">
      <div class="agent-head">
        <div>
          <h3 class="agent-name">
            {{ agent.name }}
            <span v-if="agent.required" class="agent-badge">required</span>
            <span v-else-if="!agent.enabled" class="agent-badge agent-badge--off">disabled</span>
          </h3>
          <p class="t-meta agent-desc">{{ agent.description }}</p>
        </div>
        <label class="agent-switch" :title="agent.required ? 'This agent is load-bearing and cannot be disabled' : ''">
          <input
            type="checkbox"
            :checked="agent.enabled"
            :disabled="agent.required || !canEdit || saving === agent.id"
            @change="onToggle(agent, $event)"
          />
          <span class="t-label">{{ agent.enabled ? 'Enabled' : 'Disabled' }}</span>
        </label>
      </div>

      <div v-if="agent.fields.length" class="fields agent-fields">
        <label v-for="field in agent.fields" :key="field.key" class="field">
          <span class="t-label">{{ field.label }}</span>

          <input
            v-if="field.type === 'boolean'"
            type="checkbox"
            :checked="!!drafts[agent.id]?.[field.key]"
            :disabled="!canEdit"
            @change="drafts[agent.id][field.key] = $event.target.checked"
          />
          <select
            v-else-if="field.type === 'select'"
            v-model="drafts[agent.id][field.key]"
            :disabled="!canEdit"
          >
            <option v-for="opt in field.options" :key="opt" :value="opt">{{ opt }}</option>
          </select>
          <span v-else-if="field.type === 'multiselect'" class="multiselect">
            <label v-for="opt in field.options" :key="opt" class="multiselect-opt">
              <input
                type="checkbox"
                :checked="(drafts[agent.id]?.[field.key] || []).includes(opt)"
                :disabled="!canEdit"
                @change="toggleMulti(agent.id, field.key, opt, $event.target.checked)"
              />
              {{ opt }}
            </label>
            <span v-if="!field.options.length" class="t-meta">No vendors available yet.</span>
          </span>
          <input
            v-else-if="field.type === 'number'"
            v-model="drafts[agent.id][field.key]"
            type="number"
            :min="field.min"
            :max="field.max"
            :step="field.step || 1"
            :disabled="!canEdit"
          />
          <input v-else v-model="drafts[agent.id][field.key]" type="text" :disabled="!canEdit" />

          <span v-if="field.description" class="field-hint">{{ field.description }}</span>
        </label>

        <div v-if="canEdit" class="form-actions">
          <button
            type="button"
            class="btn btn--primary"
            :disabled="!isDirty(agent) || saving === agent.id"
            @click="onSave(agent)"
          >
            {{ saving === agent.id ? 'Saving…' : 'Save changes' }}
          </button>
          <button type="button" class="btn" :disabled="!isDirty(agent)" @click="onReset(agent)">Reset</button>
          <span class="t-meta agent-version">v{{ agent.activeVersion ?? '—' }}</span>
        </div>
      </div>
      <div v-else class="agent-fields">
        <span class="t-meta">No tunable settings. <template v-if="canEdit">Version v{{ agent.activeVersion ?? '—' }}.</template></span>
      </div>
    </div>

    <p v-if="!canEdit && !loading" class="t-meta">
      You can view agent configuration; editing requires the admin role.
    </p>
  </section>
</template>

<style scoped>
.agent-card {
  border: 1px solid var(--border, #e2e2e2);
  border-radius: 8px;
  padding: 16px;
  margin-bottom: 12px;
}
.agent-card--off {
  opacity: 0.75;
}
.agent-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
}
.agent-name {
  margin: 0 0 4px;
  font-size: 15px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.agent-badge {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--surface-2, #f0f0f0);
  color: var(--text-muted, #666);
}
.agent-badge--off {
  background: #fdecea;
  color: #b3261e;
}
.agent-desc {
  max-width: 64ch;
  margin: 0;
}
.agent-switch {
  display: flex;
  align-items: center;
  gap: 8px;
  white-space: nowrap;
}
.agent-fields {
  margin-top: 12px;
}
.agent-version {
  align-self: center;
}
.multiselect {
  display: flex;
  gap: 16px;
  flex-wrap: wrap;
}
.multiselect-opt {
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
