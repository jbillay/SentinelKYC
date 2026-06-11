import { ref } from 'vue'

// Settings → Agents. List comes from /api/agents (definition metadata +
// active config, secrets masked); saves create a new active version
// server-side (versioned + audited). Mutations are admin-tier.
export function useAgents() {
  const agents = ref([])
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

  function replaceAgent(updated) {
    const ix = agents.value.findIndex((a) => a.id === updated.id)
    if (ix >= 0) agents.value.splice(ix, 1, updated)
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

  return { agents, loading, saving, error, fetchAgents, setEnabled, saveConfig }
}
