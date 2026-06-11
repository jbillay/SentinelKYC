import { computed, watch, onBeforeUnmount } from 'vue'
import { useAgentStore } from '../stores/agent.js'

// Reactive accessor for a single run slice keyed by threadId.
// Auto-attaches an SSE stream if the slice is unknown (e.g. after a page reload).
export function useRun(threadIdRef) {
  const store = useAgentStore()

  const slice = computed(() => {
    const id = threadIdRef.value
    if (!id) return null
    return store.runs[id] || null
  })

  // Terminal phases that should never trigger a (re)attach. `error` is included
  // here so a slice that already gave up on its SSE connection doesn't loop
  // back through openStream → onerror → openStream → … on every watcher tick.
  // See CODE_REVIEW §4.3.
  const TERMINAL_PHASES = new Set(['done', 'cancelled', 'error'])
  function ensureAttached(id) {
    if (!id) return
    const existing = store.runs[id]
    if (!existing || (!existing._source && !TERMINAL_PHASES.has(existing.phase))) {
      store.attach(id)
    }
  }

  watch(
    threadIdRef,
    (id) => ensureAttached(id),
    { immediate: true }
  )

  const phase = computed(() => slice.value?.phase || 'idle')
  const fragments = computed(() => slice.value?.fragments || [])
  const trace = computed(() => slice.value?.trace || [])
  const errors = computed(() => slice.value?.errors || [])
  const candidates = computed(() => slice.value?.candidates || [])
  const resolution = computed(() => slice.value?.resolution || null)
  const kycCard = computed(() => slice.value?.kycCard || null)
  const shareholderGraph = computed(() => slice.value?.shareholderGraph || null)
  const documents = computed(() => slice.value?.documents || [])
  const profile = computed(() => slice.value?.profile || null)
  const progress = computed(() => slice.value?.progress || null)
  const lastInput = computed(() => slice.value?.lastInput || null)
  const startedAt = computed(() => slice.value?.startedAt || null)
  const finishedAt = computed(() => slice.value?.finishedAt || null)
  const runId = computed(() => slice.value?.runId || null)
  const dossierId = computed(() => slice.value?.dossierId || null)
  const companyNumber = computed(() => slice.value?.companyNumber || null)
  const qaResult = computed(() => slice.value?.qaResult || null)
  const qaNarrative = computed(() => slice.value?.qaNarrative || null)
  const caseStatus = computed(() => slice.value?.caseStatus || null)
  const screening = computed(
    () =>
      slice.value?.screening || {
        subjects: [],
        hits: [],
        evaluations: [],
        currentSubjectId: null,
        currentList: null,
        lastEvents: [],
      }
  )

  const isRunning = computed(
    () =>
      phase.value === 'running' ||
      phase.value === 'needs_user_pick' ||
      phase.value === 'awaiting_decision'
  )
  const subjectName = computed(() =>
    slice.value ? store.deriveSubjectName(slice.value) : 'New search'
  )

  function pick(num) {
    if (threadIdRef.value) store.resume(threadIdRef.value, num)
  }
  function cancel() {
    if (threadIdRef.value) store.cancelRun(threadIdRef.value)
  }
  function remove() {
    if (threadIdRef.value) store.removeRun(threadIdRef.value)
  }

  onBeforeUnmount(() => {
    // Streams are owned by the store and live across component unmounts,
    // so background runs continue when the user navigates away.
  })

  return {
    slice,
    phase,
    fragments,
    trace,
    errors,
    candidates,
    resolution,
    kycCard,
    shareholderGraph,
    documents,
    profile,
    progress,
    lastInput,
    startedAt,
    finishedAt,
    runId,
    dossierId,
    companyNumber,
    qaResult,
    qaNarrative,
    caseStatus,
    screening,
    isRunning,
    subjectName,
    pick,
    cancel,
    remove,
  }
}
