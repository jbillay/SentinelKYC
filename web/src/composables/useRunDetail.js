import { ref, watch } from 'vue'

export function useRunDetail(companyNumber, runId) {
  const run = ref(null)
  const loading = ref(false)
  const error = ref(null)

  async function fetchRun(num, id) {
    if (!num || !id) return
    loading.value = true
    error.value = null
    try {
      const url = `/api/dossiers/${encodeURIComponent(num)}/runs/${encodeURIComponent(id)}`
      const res = await fetch(url)
      if (!res.ok) {
        if (res.status === 404) {
          run.value = null
          error.value = 'not_found'
          return
        }
        throw new Error(`run failed: ${res.status}`)
      }
      run.value = await res.json()
    } catch (err) {
      error.value = err.message
    } finally {
      loading.value = false
    }
  }

  watch(
    [
      () => companyNumber.value ?? companyNumber,
      () => runId.value ?? runId,
    ],
    ([num, id]) => fetchRun(num, id),
    { immediate: true }
  )

  return {
    run,
    loading,
    error,
    refresh: () =>
      fetchRun(companyNumber.value ?? companyNumber, runId.value ?? runId),
  }
}
