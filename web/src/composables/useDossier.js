// Thin shim over `useDossierStore`. Kept as a composable so the four
// consumers (DossierViewPage / RunDetailPage / RunDiffPage / GraphPage) don't
// need to be rewritten. The store is the single source of truth: a notes
// edit on the dossier page flows through here and any other page mounted
// against the same companyNumber sees it immediately. See CODE_REVIEW §4.1.
import { computed, onScopeDispose, unref, watch } from 'vue'
import { useDossierStore, ALLOWED_TAGS } from '../stores/dossier.js'

export { ALLOWED_TAGS }

export function useDossier(companyNumber) {
  const store = useDossierStore()

  // Per-call debounce timer (note edits are per-component scoped — coalescing
  // across components would lose the user's last keystroke under unmount).
  let saveTimer = null
  onScopeDispose(() => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
  })

  const currentCn = computed(() => unref(companyNumber))
  const entry = computed(() => {
    const cn = currentCn.value
    return cn ? store.ensureEntry(cn) : null
  })

  const dossier = computed(() => entry.value?.dossier ?? null)
  const loading = computed(() => entry.value?.loading ?? false)
  const error = computed(() => entry.value?.error ?? null)
  const saving = computed(() => entry.value?.saving ?? false)

  // Always re-fetch on (re)mount or when companyNumber changes — the store
  // entry may have been populated by a prior page visit and the dossier may
  // have grown a new run (with a fresh qaResult) since. The store dedupes
  // concurrent fetches via its `inflight` promise, so two pages mounting at
  // once won't fan out. See dossier store / CODE_REVIEW §4.1.
  watch(
    currentCn,
    (cn) => {
      if (cn) store.fetchOne(cn, { force: true })
    },
    { immediate: true },
  )

  async function patch(payload) {
    const cn = currentCn.value
    if (!cn) return
    await store.patch(cn, payload)
  }

  function patchDebounced(payload, delay = 500) {
    clearTimeout(saveTimer)
    saveTimer = setTimeout(() => patch(payload), delay)
  }

  function toggleTag(tagName) {
    if (!ALLOWED_TAGS.includes(tagName)) return
    const d = dossier.value
    const cn = currentCn.value
    if (!d || !cn) return
    const current = d.tags || []
    const next = current.includes(tagName)
      ? current.filter((t) => t !== tagName)
      : [...current, tagName]
    store.setLocalTags(cn, next)
    patch({ tags: next })
  }

  function setNotes(value) {
    const cn = currentCn.value
    if (!cn) return
    store.setLocalNotes(cn, value)
    patchDebounced({ notes: value }, 600)
  }

  function refresh() {
    const cn = currentCn.value
    if (cn) return store.fetchOne(cn, { force: true })
  }

  return {
    dossier,
    loading,
    error,
    saving,
    refresh,
    patch,
    toggleTag,
    setNotes,
  }
}
