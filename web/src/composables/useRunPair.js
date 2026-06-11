import { ref, watch } from 'vue'

export function useRunPair(companyNumber, runIdA, runIdB) {
  const left = ref(null)
  const right = ref(null)
  const loading = ref(false)
  const error = ref(null)

  async function fetchRun(num, id) {
    const url = `/api/dossiers/${encodeURIComponent(num)}/runs/${encodeURIComponent(id)}`
    const res = await fetch(url)
    if (!res.ok) {
      if (res.status === 404) return null
      throw new Error(`run failed: ${res.status}`)
    }
    return res.json()
  }

  async function fetchPair(num, a, b) {
    if (!num || !a || !b) return
    loading.value = true
    error.value = null
    try {
      const [l, r] = await Promise.all([fetchRun(num, a), fetchRun(num, b)])
      left.value = l
      right.value = r
      if (!l || !r) error.value = 'not_found'
    } catch (err) {
      error.value = err.message
    } finally {
      loading.value = false
    }
  }

  watch(
    [
      () => companyNumber.value ?? companyNumber,
      () => runIdA.value ?? runIdA,
      () => runIdB.value ?? runIdB,
    ],
    ([num, a, b]) => fetchPair(num, a, b),
    { immediate: true }
  )

  return { left, right, loading, error }
}
