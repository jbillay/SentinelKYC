import { ref } from 'vue'

export function usePrompts() {
  const list = ref([])
  const detail = ref(null)
  const selectedVersionId = ref(null)
  const editorBody = ref('')
  const editorNotes = ref('')
  const loading = ref(false)
  const saving = ref(false)
  const error = ref(null)

  async function fetchList() {
    loading.value = true
    error.value = null
    try {
      const res = await fetch('/api/prompts')
      if (!res.ok) throw new Error(`prompts list failed: ${res.status}`)
      list.value = await res.json()
    } catch (err) {
      error.value = err.message
    } finally {
      loading.value = false
    }
  }

  async function selectKey(key) {
    loading.value = true
    error.value = null
    try {
      const res = await fetch(`/api/prompts/${encodeURIComponent(key)}`)
      if (!res.ok) throw new Error(`prompt detail failed: ${res.status}`)
      const data = await res.json()
      detail.value = data
      selectedVersionId.value = data.active?.id || data.versions?.[0]?.id || null
      editorBody.value = data.active?.body || data.defaultBody || ''
      editorNotes.value = ''
    } catch (err) {
      error.value = err.message
    } finally {
      loading.value = false
    }
  }

  async function selectVersion(versionId) {
    if (!detail.value) return
    selectedVersionId.value = versionId
    error.value = null
    try {
      const res = await fetch(
        `/api/prompts/${encodeURIComponent(detail.value.key)}/versions/${encodeURIComponent(versionId)}`
      )
      if (!res.ok) throw new Error(`version load failed: ${res.status}`)
      const ver = await res.json()
      editorBody.value = ver.body
    } catch (err) {
      error.value = err.message
    }
  }

  async function saveAsNewVersion() {
    if (!detail.value) return
    saving.value = true
    error.value = null
    try {
      const res = await fetch(`/api/prompts/${encodeURIComponent(detail.value.key)}/versions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          body: editorBody.value,
          notes: editorNotes.value.trim() || null,
        }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || `create failed: ${res.status}`)
      }
      const newVer = await res.json()
      await selectKey(detail.value.key)
      selectedVersionId.value = newVer.id
      await selectVersion(newVer.id)
      await fetchList()
    } catch (err) {
      error.value = err.message
    } finally {
      saving.value = false
    }
  }

  async function setActive() {
    if (!detail.value || !selectedVersionId.value) return
    saving.value = true
    error.value = null
    try {
      const res = await fetch(`/api/prompts/${encodeURIComponent(detail.value.key)}/active`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ versionId: selectedVersionId.value }),
      })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error || `set active failed: ${res.status}`)
      }
      await selectKey(detail.value.key)
      await fetchList()
    } catch (err) {
      error.value = err.message
    } finally {
      saving.value = false
    }
  }

  return {
    list,
    detail,
    selectedVersionId,
    editorBody,
    editorNotes,
    loading,
    saving,
    error,
    fetchList,
    selectKey,
    selectVersion,
    saveAsNewVersion,
    setActive,
  }
}
