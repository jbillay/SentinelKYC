// Phase 4 — List-and-filter composable for the parties endpoint.
//
// Used by:
//   * KycCard.vue       — fetches with { dossier_id } to enrich the
//                          officer/PSC rows with linked-dossier counts.
//   * (future)          — Party-master search page.
//
// Returns reactive state + a `load(filters)` function. Filters are merged
// onto the request query string; pagination is opt-in via { limit, offset }.

import { ref } from 'vue'

export function useParties() {
  const parties = ref([])
  const loading = ref(false)
  const error = ref(null)

  async function load(filters = {}) {
    loading.value = true
    error.value = null
    const params = new URLSearchParams()
    if (filters.q) params.set('q', filters.q)
    if (typeof filters.needsReview === 'boolean') {
      params.set('needs_review', filters.needsReview ? 'true' : 'false')
    }
    if (filters.dossierId) params.set('dossier_id', filters.dossierId)
    if (filters.limit) params.set('limit', String(filters.limit))
    if (filters.offset) params.set('offset', String(filters.offset))
    const url = `/api/parties${params.toString() ? `?${params.toString()}` : ''}`
    try {
      const res = await fetch(url)
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        error.value = body?.error || `Request failed: ${res.status}`
        parties.value = []
        return
      }
      parties.value = body.parties || []
    } catch (err) {
      error.value = err.message
      parties.value = []
    } finally {
      loading.value = false
    }
  }

  return { parties, loading, error, load }
}
