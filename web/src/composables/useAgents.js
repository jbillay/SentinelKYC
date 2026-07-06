import { ref } from 'vue'

// Admin → Agents. List comes from /api/agents (definition metadata + active
// config, secrets masked); `agent` is the single-agent detail used by the
// per-agent admin section (/admin/agents/:agentId). Saves create a new active
// version server-side (versioned + audited). Mutations are admin-tier.
export function useAgents() {
  const agents = ref([])
  const agent = ref(null) // detail for one agent (fetchAgent)
  const loading = ref(false)
  const saving = ref(null) // agent id currently saving
  const error = ref(null)

  async function fetchAgents() {
    loading.value = true
    error.value = null
    try {
      const res = await fetch('/api/agents')
      if (!res.ok) throw new Error(`agents list failed: ${res.status}`)
      agents.value = await res.json()
    } catch (err) {
      error.value = err.message
    } finally {
      loading.value = false
    }
  }

  async function fetchAgent(id) {
    loading.value = true
    error.value = null
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(id)}`)
      if (res.status === 404) throw new Error('unknown agent')
      if (!res.ok) throw new Error(`agent detail failed: ${res.status}`)
      agent.value = await res.json()
    } catch (err) {
      error.value = err.message
    } finally {
      loading.value = false
    }
  }

  function replaceAgent(updated) {
    const ix = agents.value.findIndex((a) => a.id === updated.id)
    if (ix >= 0) agents.value.splice(ix, 1, updated)
    // The toggle/save routes return the list shape (no `versions`); keep the
    // detail's version history while refreshing config + enabled state.
    if (agent.value && agent.value.id === updated.id) {
      agent.value = { ...agent.value, ...updated }
    }
  }

  async function setEnabled(id, enabled) {
    saving.value = id
    error.value = null
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(id)}/enabled`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || `toggle failed: ${res.status}`)
      replaceAgent(data.agent)
    } catch (err) {
      error.value = err.message
    } finally {
      saving.value = null
    }
  }

  async function saveConfig(id, body, notes = null) {
    saving.value = id
    error.value = null
    try {
      const res = await fetch(`/api/agents/${encodeURIComponent(id)}/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, notes }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) {
        const detail = Array.isArray(data.validationErrors) ? `: ${data.validationErrors.join('; ')}` : ''
        throw new Error((data.error || `save failed: ${res.status}`) + detail)
      }
      replaceAgent(data.agent)
      return true
    } catch (err) {
      error.value = err.message
      return false
    } finally {
      saving.value = null
    }
  }

  return { agents, agent, loading, saving, error, fetchAgents, fetchAgent, setEnabled, saveConfig }
}
