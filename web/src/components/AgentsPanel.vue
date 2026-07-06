<script setup>
import { computed, onMounted } from 'vue'
import { RouterLink } from 'vue-router'
import { useAgents } from '../composables/useAgents.js'
import { useAuthStore } from '../stores/auth.js'

// Admin → Agents: the pipeline overview. One row per agent — name, short
// description, enable/disable switch, and a link to the agent's own section
// (/admin/agents/:agentId) where all its configuration, prompts, and related
// settings live.
const { agents, loading, saving, error, fetchAgents, setEnabled } = useAgents()
const auth = useAuthStore()
const canEdit = computed(() => auth.hasRole('admin'))

onMounted(fetchAgents)

async function onToggle(agent, e) {
  await setEnabled(agent.id, e.target.checked)
}
</script>

<template>
  <section class="sheet">
    <h2 class="sheet-title">Agents</h2>
    <p class="sheet-sub">
      The six pipeline agents. Enable or disable them here; open an agent to tune its behaviour,
      prompts, and related settings. Changes are versioned and apply to the next run — no restart.
      Disabling screening or risk assessment forces every affected case to standard review: a
      partially assessed case is never auto-approved.
    </p>

    <p v-if="error" class="form-msg form-msg--error" role="alert">{{ error }}</p>
    <p v-if="loading" class="t-meta">Loading agents…</p>

    <ul class="agent-list">
      <li v-for="agent in agents" :key="agent.id" class="agent-row" :class="{ 'agent-row--off': !agent.enabled }">
        <div class="agent-main">
          <RouterLink class="agent-name" :to="{ name: 'admin-agent', params: { agentId: agent.id } }">
            {{ agent.name }}
          </RouterLink>
          <span v-if="agent.required" class="agent-badge">required</span>
          <span v-else-if="!agent.enabled" class="agent-badge agent-badge--off">disabled</span>
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

        <RouterLink class="btn btn--ghost agent-configure" :to="{ name: 'admin-agent', params: { agentId: agent.id } }">
          Configure
          <span class="material-symbols-outlined icon-sm">chevron_right</span>
        </RouterLink>
      </li>
    </ul>

    <p v-if="!canEdit && !loading" class="t-meta">
      You can view agent configuration; editing requires the admin role.
    </p>
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
.agent-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
}
.agent-row {
  display: grid;
  grid-template-columns: 1fr auto auto;
  align-items: center;
  gap: var(--sp-5);
  padding: var(--sp-4) 0;
  border-bottom: 1px solid var(--color-border);
}
.agent-row:last-child {
  border-bottom: 0;
}
.agent-row--off {
  opacity: 0.7;
}
.agent-main {
  min-width: 0;
}
.agent-name {
  font-weight: 600;
  font-size: 15px;
  color: var(--color-text-primary);
  text-decoration: none;
}
.agent-name:hover {
  color: var(--color-primary);
  text-decoration: underline;
}
.agent-badge {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--color-surface-sunken, #f0f0f0);
  color: var(--color-text-tertiary, #666);
  margin-left: var(--sp-2);
}
.agent-badge--off {
  background: #fdecea;
  color: #b3261e;
}
.agent-desc {
  max-width: 72ch;
  margin: var(--sp-1) 0 0;
}
.agent-switch {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  white-space: nowrap;
}
.agent-configure {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  white-space: nowrap;
}
</style>
