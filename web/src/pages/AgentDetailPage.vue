<script setup>
import { ref, computed, watch } from 'vue'
import { RouterLink } from 'vue-router'
import { useAgents } from '../composables/useAgents.js'
import { useAuthStore } from '../stores/auth.js'
import AgentConfigForm from '../components/AgentConfigForm.vue'
import PromptsPanel from '../components/PromptsPanel.vue'
import RiskMatrixPanel from '../components/RiskMatrixPanel.vue'
import ScreeningSourcesPanel from '../components/ScreeningSourcesPanel.vue'

// One agent's whole admin surface: enable/disable, tunable config, the prompts
// it owns, and any related engine configuration (sanctions sources for
// screening, the risk matrix for risk assessment).
const props = defineProps({
  agentId: { type: String, required: true },
})

const { agent, saving, error, fetchAgent, setEnabled, saveConfig } = useAgents()
const auth = useAuthStore()
const canEdit = computed(() => auth.hasRole('admin'))

const saveStatus = ref(null)

watch(
  () => props.agentId,
  (id) => {
    saveStatus.value = null
    fetchAgent(id)
  },
  { immediate: true }
)

async function onToggle(e) {
  if (!agent.value) return
  await setEnabled(agent.value.id, e.target.checked)
}

async function onSaveConfig(body) {
  saveStatus.value = null
  const ok = await saveConfig(props.agentId, body)
  if (ok) saveStatus.value = 'Saved — applies to the next run.'
}

function fmtVersionDate(v) {
  if (!v) return '—'
  return new Date(v).toLocaleString()
}
</script>

<template>
  <div class="agent-detail">
    <nav class="crumb">
      <RouterLink class="crumb-link" :to="{ name: 'admin', hash: '#agents' }">Agents</RouterLink>
      <span class="crumb-sep">/</span>
      <span>{{ agent?.name || agentId }}</span>
    </nav>

    <div v-if="error && !agent" class="panel-error">{{ error }}</div>

    <template v-if="agent">
      <header class="page-head">
        <div>
          <h1 class="t-headline">
            {{ agent.name }}
            <span v-if="agent.required" class="agent-badge">required</span>
            <span v-else-if="!agent.enabled" class="agent-badge agent-badge--off">disabled</span>
          </h1>
          <p class="t-meta page-sub">{{ agent.description }}</p>
        </div>
        <label class="agent-switch" :title="agent.required ? 'This agent is load-bearing and cannot be disabled' : ''">
          <input
            type="checkbox"
            :checked="agent.enabled"
            :disabled="agent.required || !canEdit || saving === agent.id"
            @change="onToggle"
          />
          <span class="t-label">{{ agent.enabled ? 'Enabled' : 'Disabled' }}</span>
        </label>
      </header>

      <p v-if="error" class="panel-error" role="alert">{{ error }}</p>

      <section class="sheet">
        <h2 class="sheet-title">Configuration</h2>
        <p class="sheet-sub">
          Versioned — saving creates and activates a new version, applied to the next run with no
          restart.
          <template v-if="agent.versions?.length">
            Active v{{ agent.activeVersion ?? '—' }} · {{ agent.versions.length }} version{{ agent.versions.length === 1 ? '' : 's' }}
            · last change {{ fmtVersionDate(agent.versions[0]?.createdAt) }}.
          </template>
        </p>

        <div v-if="saveStatus" class="banner">{{ saveStatus }}</div>

        <AgentConfigForm
          v-if="agent.fields?.length"
          :agent="agent"
          :can-edit="canEdit"
          :saving="saving === agent.id"
          @save="onSaveConfig"
        />
        <p v-else class="t-meta">This agent has no tunable settings beyond enable/disable.</p>

        <p v-if="!canEdit" class="t-meta">
          You can view this configuration; editing requires the admin role.
        </p>
      </section>

      <ScreeningSourcesPanel v-if="agent.id === 'screening'" />

      <RiskMatrixPanel v-if="agent.id === 'risk-assessment'" />

      <PromptsPanel :agent="agent.id" />
    </template>
  </div>
</template>

<style scoped>
.agent-detail {
  display: flex;
  flex-direction: column;
  gap: var(--sp-6);
}
.crumb {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-size: var(--fs-meta);
  color: var(--color-text-secondary);
}
.crumb-link {
  color: var(--color-primary);
  text-decoration: none;
}
.crumb-link:hover {
  text-decoration: underline;
}
.crumb-sep {
  color: var(--color-text-tertiary);
}
.page-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: var(--sp-4);
}
.page-head h1 {
  margin: 0;
  display: flex;
  align-items: center;
  gap: var(--sp-2);
}
.page-sub {
  margin: var(--sp-1) 0 0;
  max-width: 80ch;
}
.agent-badge {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--color-surface-sunken, #f0f0f0);
  color: var(--color-text-tertiary, #666);
}
.agent-badge--off {
  background: #fdecea;
  color: #b3261e;
}
.agent-switch {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  white-space: nowrap;
  padding-top: var(--sp-2);
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
.banner {
  padding: var(--sp-2) var(--sp-3);
  border-radius: var(--radius-sm);
  background: var(--color-success-soft, #d1fae5);
  color: var(--color-success, #065f46);
  font-size: var(--fs-meta);
}
.panel-error {
  padding: var(--sp-3);
  background: rgba(220, 53, 69, 0.08);
  border: 1px solid rgba(220, 53, 69, 0.25);
  border-radius: var(--radius-md);
  color: var(--color-danger, #b00020);
  font-size: var(--fs-meta);
}
</style>
