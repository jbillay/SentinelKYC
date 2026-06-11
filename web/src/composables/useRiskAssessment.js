import { ref } from 'vue'

// Read the frozen risk assessment for a run, and trigger a matrix-edit-only
// rebase (`recalculate-risk`) against the dossier's latest snapshot-bearing run.
//
// Note: `recalculate-risk` always writes onto the *latest* run, not necessarily
// the run passed here — callers on a frozen run detail page should not expose
// the recalculate action. After a successful recalculate the caller should
// re-fetch the dossier so the latest run picks up the new assessment.
export function useRiskAssessment() {
  const result = ref(null) // the riskAssessment object
  const notAssessed = ref(false) // true when the run has no assessment yet (404)
  const loading = ref(false)
  const error = ref(null)

  const recalculating = ref(false)
  const recalcError = ref(null)
  const rationaleSource = ref(null) // 'llm' | 'template' from the last recalculate

  async function fetchForRun(companyNumber, runId) {
    if (!companyNumber || !runId) return
    loading.value = true
    error.value = null
    notAssessed.value = false
    try {
      const res = await fetch(
        `/api/dossiers/${encodeURIComponent(companyNumber)}/runs/${encodeURIComponent(runId)}/risk`
      )
      if (res.status === 404) {
        result.value = null
        notAssessed.value = true
        return
      }
      if (!res.ok) throw new Error(`risk fetch failed: ${res.status}`)
      const data = await res.json()
      result.value = data.riskAssessment || null
    } catch (err) {
      error.value = err.message
    } finally {
      loading.value = false
    }
  }

  async function recalculate(companyNumber) {
    if (!companyNumber) return
    recalculating.value = true
    recalcError.value = null
    try {
      const res = await fetch(
        `/api/dossiers/${encodeURIComponent(companyNumber)}/recalculate-risk`,
        { method: 'POST' }
      )
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || `recalculate failed: ${res.status}`)
      }
      const body = await res.json()
      result.value = body.riskAssessment || null
      rationaleSource.value = body.rationaleSource || null
      notAssessed.value = false
      return body
    } catch (err) {
      recalcError.value = err.message
      throw err
    } finally {
      recalculating.value = false
    }
  }

  return {
    result,
    notAssessed,
    loading,
    error,
    recalculating,
    recalcError,
    rationaleSource,
    fetchForRun,
    recalculate,
  }
}
