import { useRouter } from 'vue-router'
import { useAgentStore } from '../stores/agent.js'

export function useRefresh() {
  const router = useRouter()
  const agent = useAgentStore()

  async function refresh(companyNumber, { companyName = null } = {}) {
    const res = await fetch(`/api/dossiers/${encodeURIComponent(companyNumber)}/refresh`, {
      method: 'POST',
    })
    if (!res.ok) throw new Error(`refresh failed: ${res.status}`)
    const { threadId } = await res.json()
    // Seed the slice with what the page already knows so the run shows the
    // company name immediately — without this, deriveSubjectName falls
    // through to "New search" until the first SSE chunk lands.
    agent.attach(threadId, { companyNumber, companyName })
    router.push({ name: 'run', params: { threadId } })
  }

  async function resumeFailed(companyNumber, runId, { companyName = null } = {}) {
    const res = await fetch(
      `/api/dossiers/${encodeURIComponent(companyNumber)}/runs/${encodeURIComponent(runId)}/resume`,
      { method: 'POST' }
    )
    if (!res.ok) throw new Error(`resume failed: ${res.status}`)
    const { threadId } = await res.json()
    agent.attach(threadId, { companyNumber, companyName })
    router.push({ name: 'run', params: { threadId } })
  }

  return { refresh, resumeFailed }
}
