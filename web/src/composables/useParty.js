// Phase 4 — Party detail + actions composable.
//
// Mirrors the useDecision pattern: pure refs, no Pinia store (Party data
// isn't cross-page-shared the same way dossiers are; we re-fetch on mount
// and on action). The composable surfaces:
//
//   * party / links / reviewItems — reactive state populated by load()
//   * loading / error              — UI flags
//   * mergeFrom(loserId, reason)   — POST /api/parties/:id/merge
//   * setOverride(...)             — PATCH /api/parties/:id/overrides
//   * reload()                     — re-fetch the detail
//
// All actions re-fetch on success so the UI always reflects committed state.

import { ref } from 'vue'

export function useParty(partyId) {
  const party = ref(null)
  const links = ref([])
  const reviewItems = ref([])
  const riskSummary = ref(null)
  const isWatched = ref(false)
  const loading = ref(false)
  const error = ref(null)
  const actionState = ref({ submitting: false, error: null })

  // Screening summary (lazy — loaded when the Screening tab opens).
  const screening = ref(null)
  const screeningLoading = ref(false)
  const screeningError = ref(null)

  async function load() {
    if (!partyId) {
      party.value = null
      return
    }
    loading.value = true
    error.value = null
    try {
      const res = await fetch(`/api/parties/${encodeURIComponent(partyId)}`)
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        error.value = body?.error || `Request failed: ${res.status}`
        return
      }
      party.value = body.party
      links.value = body.links || []
      reviewItems.value = body.reviewItems || []
      riskSummary.value = body.riskSummary || null
      isWatched.value = !!body.isWatched
    } catch (err) {
      error.value = err.message
    } finally {
      loading.value = false
    }
  }

  async function loadScreening() {
    if (!partyId) return
    screeningLoading.value = true
    screeningError.value = null
    try {
      const res = await fetch(`/api/parties/${encodeURIComponent(partyId)}/screening`)
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        screeningError.value = body?.error || `Request failed: ${res.status}`
        screening.value = null
        return
      }
      screening.value = body
    } catch (err) {
      screeningError.value = err.message
      screening.value = null
    } finally {
      screeningLoading.value = false
    }
  }

  // Flag / unflag the party on the watchlist. on=true → POST, on=false → DELETE.
  async function setWatched(on, { reason } = {}) {
    if (!partyId) throw new Error('setWatched: partyId required')
    actionState.value = { submitting: true, error: null }
    try {
      const url = `/api/parties/${encodeURIComponent(partyId)}/watchlist`
      const res = await fetch(url, {
        method: on ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: on ? JSON.stringify({ reason }) : undefined,
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        actionState.value = {
          submitting: false,
          error: body?.error || `Watchlist write failed: ${res.status}`,
        }
        throw new Error(actionState.value.error)
      }
      isWatched.value = on
      actionState.value = { submitting: false, error: null }
      return body
    } catch (err) {
      actionState.value = { submitting: false, error: err.message }
      throw err
    }
  }

  // Merge ANOTHER party into this one. This party is the winner.
  async function mergeFrom(loserId, { reason } = {}) {
    if (!partyId || !loserId) {
      throw new Error('mergeFrom: partyId + loserId required')
    }
    actionState.value = { submitting: true, error: null }
    try {
      const res = await fetch(`/api/parties/${encodeURIComponent(partyId)}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mergeFromPartyId: loserId, reason }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        actionState.value = {
          submitting: false,
          error: body?.message || body?.error || `Merge failed: ${res.status}`,
        }
        throw new Error(actionState.value.error)
      }
      actionState.value = { submitting: false, error: null }
      await load()
      return body
    } catch (err) {
      actionState.value = { submitting: false, error: err.message }
      throw err
    }
  }

  // Upsert / clear a party-level screening override. Pass decision=null to clear.
  async function setOverride({ listSource, listEntryId, evidenceUrl, decision, reason }) {
    if (!partyId) throw new Error('setOverride: partyId required')
    actionState.value = { submitting: true, error: null }
    try {
      const res = await fetch(`/api/parties/${encodeURIComponent(partyId)}/overrides`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ listSource, listEntryId, evidenceUrl, decision, reason }),
      })
      const body = await res.json().catch(() => ({}))
      if (!res.ok) {
        actionState.value = {
          submitting: false,
          error: body?.error || `Override write failed: ${res.status}`,
        }
        throw new Error(actionState.value.error)
      }
      actionState.value = { submitting: false, error: null }
      return body
    } catch (err) {
      actionState.value = { submitting: false, error: err.message }
      throw err
    }
  }

  return {
    party,
    links,
    reviewItems,
    riskSummary,
    isWatched,
    loading,
    error,
    actionState,
    screening,
    screeningLoading,
    screeningError,
    load,
    reload: load,
    loadScreening,
    mergeFrom,
    setOverride,
    setWatched,
  }
}
