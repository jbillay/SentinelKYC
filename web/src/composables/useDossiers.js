import { ref, watch } from 'vue'

export function useDossiers({ initialCaseStatus = 'all' } = {}) {
  const dossiers = ref([])
  const kpis = ref(null)
  const loading = ref(false)
  const error = ref(null)

  const search = ref('')
  const filter = ref('all')
  const tag = ref(null)
  // Phase 5 / Q5 — reviewer state filter (separate from run-status filter).
  const caseStatus = ref(initialCaseStatus)

  let debounceTimer = null

  async function fetchKpis() {
    try {
      const res = await fetch('/api/dossiers/kpis')
      if (!res.ok) throw new Error(`kpis failed: ${res.status}`)
      kpis.value = await res.json()
    } catch (err) {
      error.value = err.message
    }
  }

  async function fetchList() {
    loading.value = true
    error.value = null
    try {
      const params = new URLSearchParams()
      if (search.value.trim()) params.set('q', search.value.trim())
      if (filter.value && filter.value !== 'all') params.set('status', filter.value)
      if (tag.value) params.set('tag', tag.value)
      if (caseStatus.value && caseStatus.value !== 'all') {
        params.set('caseStatus', caseStatus.value)
      }
      const url = `/api/dossiers${params.toString() ? `?${params}` : ''}`
      const res = await fetch(url)
      if (!res.ok) throw new Error(`dossiers failed: ${res.status}`)
      dossiers.value = await res.json()
    } catch (err) {
      error.value = err.message
    } finally {
      loading.value = false
    }
  }

  async function refresh() {
    await Promise.all([fetchList(), fetchKpis()])
  }

  watch([search, filter, tag, caseStatus], () => {
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(fetchList, 200)
  })

  refresh()

  return {
    dossiers,
    kpis,
    loading,
    error,
    search,
    filter,
    tag,
    caseStatus,
    refresh,
  }
}
