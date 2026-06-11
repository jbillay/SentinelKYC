// Phase 4 — Review queue composable.
//
// Powers the Watchlist's "Review queue" tab. Exposes:
//   * items, loading, error          — reactive state
//   * load()                         — fetch open queue
//   * resolveItem(id, payload)       — POST /api/parties/review-queue/:id/resolve
//
// payload is either { action: 'merge', winnerPartyId?, reason? } or
// { action: 'reject', reason? } — same shape as reviewQueueResolutionSchema
// in web/src/lib/partyMatchSchema.js.

import { ref } from 'vue'

export function usePartyReviewQueue() {
  const items = ref([])
  const loading = ref(false)
  const error = ref(null)
  const submitting = ref(false)

  async function load() {
    loading.value = true
    error.value = null
    try {
      const res = await fetch('/api/parties/review-queue')
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        error.value = body?.error || `Request failed: ${res.status}`
        items.value = []
        return
      }
      items.value = body.items || []
    } catch (err) {
      error.value = err.message
      items.value = []
    } finally {
      loading.value = false
    }
  }

  async function resolveItem(id, payload) {
    if (!id || !payload?.action) throw new Error('resolveItem: id + action required')
    submitting.value = true
    try {
      const res = await fetch(
        `/api/parties/review-queue/${encodeURIComponent(id)}/resolve`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        },
      )
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(body?.message || body?.error || `Resolution failed: ${res.status}`)
      }
      await load()
      return body
    } finally {
      submitting.value = false
    }
  }

  return { items, loading, error, submitting, load, resolveItem }
}
