// Centralised dossier cache. Previously each consuming page (DossierViewPage,
// RunDetailPage, RunDiffPage, GraphPage) called useDossier(cn) which spun up
// its own ref + fetch — meaning a navigation from a dossier to a child page
// re-fetched the same record from scratch. Promoting state into Pinia lets the
// composable hand back a shared reactive slice keyed by companyNumber, so a
// PATCH (tag toggle, notes edit) is visible everywhere immediately and the
// first consumer's fetch warms the cache for the rest. See CODE_REVIEW §4.1.
import { defineStore } from 'pinia'
import { reactive } from 'vue'

export const ALLOWED_TAGS = ['escalate', 'cleared', 'monitor']

function createEntry() {
  return {
    dossier: null,
    loading: false,
    error: null,
    saving: false,
    fetchedAt: null,
    inflight: null, // Promise — dedupes concurrent fetches for the same cn
  }
}

export const useDossierStore = defineStore('dossier', () => {
  const byCompanyNumber = reactive({})

  function ensureEntry(cn) {
    if (!byCompanyNumber[cn]) byCompanyNumber[cn] = createEntry()
    return byCompanyNumber[cn]
  }

  async function fetchOne(cn, { force = false } = {}) {
    if (!cn) return null
    const entry = ensureEntry(cn)
    if (!force && entry.inflight) return entry.inflight
    if (!force && entry.dossier) return entry.dossier
    entry.loading = true
    entry.error = null
    entry.inflight = (async () => {
      try {
        const res = await fetch(`/api/dossiers/${encodeURIComponent(cn)}`)
        if (!res.ok) {
          if (res.status === 404) {
            entry.dossier = null
            entry.error = 'not_found'
            return null
          }
          throw new Error(`dossier failed: ${res.status}`)
        }
        const payload = await res.json()
        entry.dossier = payload
        entry.fetchedAt = Date.now()
        return payload
      } catch (err) {
        entry.error = err.message
        return null
      } finally {
        entry.loading = false
        entry.inflight = null
      }
    })()
    return entry.inflight
  }

  async function patch(cn, payload) {
    if (!cn) return null
    const entry = ensureEntry(cn)
    entry.saving = true
    try {
      const res = await fetch(`/api/dossiers/${encodeURIComponent(cn)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      })
      if (!res.ok) throw new Error(`patch failed: ${res.status}`)
      const updated = await res.json()
      // Preserve `runs` from the prior dossier — the PATCH endpoint only
      // returns dossier-level columns, not the nested runs array.
      entry.dossier = { ...entry.dossier, ...updated }
      return entry.dossier
    } catch (err) {
      entry.error = err.message
      return null
    } finally {
      entry.saving = false
    }
  }

  function setLocalTags(cn, nextTags) {
    const entry = ensureEntry(cn)
    if (!entry.dossier) return
    entry.dossier = { ...entry.dossier, tags: nextTags }
  }

  function setLocalNotes(cn, notes) {
    const entry = ensureEntry(cn)
    if (!entry.dossier) return
    entry.dossier = { ...entry.dossier, notes }
  }

  function invalidate(cn) {
    if (cn && byCompanyNumber[cn]) {
      byCompanyNumber[cn] = createEntry()
    }
  }

  return {
    byCompanyNumber,
    ensureEntry,
    fetchOne,
    patch,
    setLocalTags,
    setLocalNotes,
    invalidate,
  }
})
