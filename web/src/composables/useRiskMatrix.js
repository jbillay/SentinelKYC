import { ref } from 'vue'

// Read + mutate the risk matrix registry (versioned, append-only, singleton
// active). Activate is optimistic — flip `active` locally, roll back on failure
// (mirrors useScreening's override flow). Server is the source of truth for
// validation; the Settings editor can preview with a client-side mirror.
export function useRiskMatrix() {
  const active = ref(null) // { versionId, version, body, notes, updatedAt }
  const versions = ref([]) // [{ id, version, notes, createdAt }]
  const versionDetail = ref(null) // full row for the selected version
  const loading = ref(false)
  const saving = ref(false)
  const error = ref(null)
  const validationErrors = ref([])

  async function loadActive() {
    error.value = null
    try {
      const res = await fetch('/api/risk/matrix')
      if (!res.ok) throw new Error(`active matrix fetch failed: ${res.status}`)
      active.value = await res.json()
    } catch (err) {
      error.value = err.message
    }
  }

  async function loadVersions() {
    error.value = null
    try {
      const res = await fetch('/api/risk/matrix/versions')
      if (!res.ok) throw new Error(`matrix versions fetch failed: ${res.status}`)
      versions.value = await res.json()
    } catch (err) {
      error.value = err.message
    }
  }

  async function load() {
    loading.value = true
    await Promise.all([loadActive(), loadVersions()])
    loading.value = false
  }

  async function fetchVersion(id) {
    error.value = null
    try {
      const res = await fetch(`/api/risk/matrix/versions/${encodeURIComponent(id)}`)
      if (!res.ok) throw new Error(`matrix version fetch failed: ${res.status}`)
      versionDetail.value = await res.json()
      return versionDetail.value
    } catch (err) {
      error.value = err.message
      throw err
    }
  }

  // Create a new version. Does NOT activate. On a 400 the server returns
  // { error, validationErrors }; surface those into `validationErrors`.
  async function createVersion(body, notes) {
    saving.value = true
    error.value = null
    validationErrors.value = []
    try {
      const res = await fetch('/api/risk/matrix/versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, notes: notes ?? null }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        if (Array.isArray(j.validationErrors)) validationErrors.value = j.validationErrors
        throw new Error(j.error || `create failed: ${res.status}`)
      }
      const created = await res.json()
      await loadVersions()
      return created
    } catch (err) {
      error.value = err.message
      throw err
    } finally {
      saving.value = false
    }
  }

  // Optimistic activate: flip `active` to the picked version locally, PATCH,
  // roll back on failure. We don't have the new version body to hand, so we
  // re-fetch the active matrix on success to pick up the canonical shape.
  async function setActive(versionId) {
    const prior = active.value
    const picked = versions.value.find((v) => v.id === versionId)
    if (picked) {
      active.value = {
        ...active.value,
        versionId: picked.id,
        version: picked.version,
        notes: picked.notes ?? null,
        updatedAt: new Date().toISOString(),
      }
    }
    saving.value = true
    error.value = null
    try {
      const res = await fetch('/api/risk/matrix/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || `set active failed: ${res.status}`)
      }
      await loadActive()
      return true
    } catch (err) {
      active.value = prior
      error.value = err.message
      throw err
    } finally {
      saving.value = false
    }
  }

  return {
    active,
    versions,
    versionDetail,
    loading,
    saving,
    error,
    validationErrors,
    load,
    loadActive,
    loadVersions,
    fetchVersion,
    createVersion,
    setActive,
  }
}
