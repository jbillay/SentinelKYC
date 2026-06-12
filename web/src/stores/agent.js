import { defineStore } from 'pinia'
import { reactive, computed, markRaw } from 'vue'

const TRANSPORT_NODES = new Set(['run', 'resume', 'stream'])

function createSlice() {
  return {
    threadId: null,
    phase: 'idle',
    trace: [],
    errors: [],
    fragments: [],
    candidates: [],
    resolution: null,
    kycCard: null,
    shareholderGraph: null,
    documents: [],
    profile: null,
    progress: null,
    lastInput: null,
    startedAt: null,
    finishedAt: null,
    runId: null,
    dossierId: null,
    companyNumber: null,
    companyName: null,
    screening: createScreeningSlice(),
    screeningReport: null,
    riskAssessment: null,
    qaResult: null,
    qaNarrative: null,
    caseStatus: null,
    _source: null,
  }
}

function createScreeningSlice() {
  return {
    subjects: [],         // [{ id, name, kind, source }] cumulative — surfaced from screening_subject_started events
    hits: [],             // [hit] from screening_hit events
    evaluations: [],      // [{ hitId, decision, llmScore, fragmentId }] from screening_hit_evaluated events
    currentSubjectId: null,
    currentList: null,    // 'ofac_sdn' | 'uk_hmt' | 'adverse_media'
    // Cumulative per-list progress: subjectId → true once a
    // screening_subject_started event was seen for (subjectId, list).
    // lastEvents is a capped rolling window, so counts must NOT be
    // derived from it — that's what this map is for.
    screenedByList: { ofac_sdn: {}, uk_hmt: {}, adverse_media: {} },
    lastEvents: [],       // rolling window of {kind, ts, ...} for the live feed (cap 8)
  }
}

function deriveSubjectName(slice) {
  if (slice.kycCard?.companyName) return slice.kycCard.companyName
  if (slice.profile?.company_name) return slice.profile.company_name
  const chosen = slice.resolution?.chosen
  const chosenCandidate = chosen
    ? slice.candidates.find((c) => c.companyNumber === chosen)
    : null
  if (chosenCandidate?.title) return chosenCandidate.title
  if (slice.resolution?.chosenTitle) return slice.resolution.chosenTitle
  if (slice.companyName) return slice.companyName
  if (slice.lastInput?.name) return slice.lastInput.name
  if (slice.lastInput?.companyNumber) return `Company #${slice.lastInput.companyNumber}`
  if (slice.companyNumber) return `Company #${slice.companyNumber}`
  return 'New search'
}

export const useAgentStore = defineStore('agent', () => {
  const runs = reactive({})
  let hydrated = false
  let hydratePromise = null

  function getRun(threadId) {
    return runs[threadId] || null
  }

  function ensureSlice(threadId) {
    if (!runs[threadId]) {
      const slice = createSlice()
      slice.threadId = threadId
      runs[threadId] = slice
    }
    return runs[threadId]
  }

  function closeStream(slice) {
    if (slice._source) {
      try {
        slice._source.close()
      } catch {
        // noop
      }
      slice._source = null
    }
  }

  function handleEvent(threadId, evt) {
    const slice = runs[threadId]
    if (!slice) return
    switch (evt.type) {
      case 'trace':
        slice.trace.push({ node: evt.node, ts: evt.ts, msg: evt.msg, extra: evt.extra })
        break
      case 'error':
        slice.errors.push({ node: evt.node, message: evt.message, ts: evt.ts })
        break
      case 'progress':
        slice.progress = { ...evt }
        break
      case 'fragment': {
        if (evt.fragment) {
          const idx = slice.fragments.findIndex((f) => f.id === evt.fragment.id)
          if (idx >= 0) slice.fragments.splice(idx, 1, evt.fragment)
          else slice.fragments.push(evt.fragment)
        }
        break
      }
      case 'interrupt': {
        const payload = evt.payload || {}
        const kind = evt.kind || payload.kind || 'entity_selection'
        if (kind === 'final_decision') {
          // QA finished, run is paused waiting for the reviewer's decision.
          // We seed the latest QA / risk / kyc / runId payload on the slice
          // so the Run page can render FinalDecisionPanel inline.
          slice.qaResult = payload.qaResult || slice.qaResult || null
          slice.qaNarrative = payload.qaNarrative || slice.qaNarrative || null
          slice.riskAssessment = payload.riskAssessment || slice.riskAssessment || null
          slice.kycCard = payload.kycCard || slice.kycCard || null
          slice.screeningReport = payload.screeningReport || slice.screeningReport || null
          if (payload.companyNumber) slice.companyNumber = payload.companyNumber
          if (payload.runId) slice.runId = payload.runId
          if (payload.caseStatus) slice.caseStatus = payload.caseStatus
          slice.phase = 'awaiting_decision'
        } else {
          slice.candidates = payload.candidates || []
          slice.resolution = payload.resolution || null
          slice.phase = 'needs_user_pick'
        }
        break
      }
      case 'cancelled': {
        slice.phase = 'cancelled'
        slice.finishedAt = Date.now()
        closeStream(slice)
        break
      }
      case 'done': {
        const s = evt.state || {}
        slice.kycCard = s.kycCard || null
        slice.shareholderGraph = s.shareholderGraph || null
        slice.documents = s.documents || []
        slice.profile = s.profile || null
        if (s.resolution) slice.resolution = s.resolution
        if (s.runId) slice.runId = s.runId
        if (s.dossierId) slice.dossierId = s.dossierId
        if (s.companyNumber) slice.companyNumber = s.companyNumber
        if (s.screeningReport) slice.screeningReport = s.screeningReport
        if (s.riskAssessment) slice.riskAssessment = s.riskAssessment
        if (s.qaResult) slice.qaResult = s.qaResult
        if (s.qaNarrative) slice.qaNarrative = s.qaNarrative
        if (s.caseStatus) slice.caseStatus = s.caseStatus
        slice.phase = 'done'
        slice.finishedAt = Date.now()
        closeStream(slice)
        break
      }
      case 'screening_subject_started': {
        const sc = slice.screening
        const list = evt.listSource || evt.list || null
        sc.currentSubjectId = evt.subjectId || null
        sc.currentList = list || sc.currentList
        if (list && sc.screenedByList[list] && evt.subjectId) {
          sc.screenedByList[list][evt.subjectId] = true
        }
        const exists = sc.subjects.find((s) => s.id === evt.subjectId)
        if (!exists && evt.subjectId) {
          sc.subjects.push({
            id: evt.subjectId,
            name: evt.subjectName || evt.subjectId,
            kind: evt.subjectKind || null,
            source: evt.subjectSource || null,
          })
        }
        sc.lastEvents.push({ kind: 'subject', ts: evt.ts, subjectId: evt.subjectId, list })
        if (sc.lastEvents.length > 8) sc.lastEvents.splice(0, sc.lastEvents.length - 8)
        break
      }
      case 'screening_hit': {
        const sc = slice.screening
        const h = evt.hit || {}
        const id = h.hitId || h.id
        if (id && !sc.hits.find((x) => (x.hitId || x.id) === id)) {
          sc.hits.push(h)
        }
        sc.lastEvents.push({ kind: 'hit', ts: evt.ts, hitId: id, subjectId: h.subjectId, list: h.listSource })
        if (sc.lastEvents.length > 8) sc.lastEvents.splice(0, sc.lastEvents.length - 8)
        break
      }
      case 'screening_hit_evaluated': {
        const sc = slice.screening
        const idx = sc.evaluations.findIndex((e) => e.hitId === evt.hitId)
        const row = {
          hitId: evt.hitId,
          decision: evt.decision,
          llmScore: evt.llmScore,
          fragmentId: evt.fragmentId,
        }
        if (idx >= 0) sc.evaluations.splice(idx, 1, row)
        else sc.evaluations.push(row)
        sc.lastEvents.push({ kind: 'evaluation', ts: evt.ts, hitId: evt.hitId, decision: evt.decision })
        if (sc.lastEvents.length > 8) sc.lastEvents.splice(0, sc.lastEvents.length - 8)
        break
      }
      default:
        break
    }
  }

  function openStream(threadId) {
    const slice = ensureSlice(threadId)
    closeStream(slice)
    const source = new EventSource(`/api/stream/${threadId}`)
    slice._source = markRaw(source)
    source.onmessage = (e) => {
      let evt
      try {
        evt = JSON.parse(e.data)
      } catch {
        return
      }
      handleEvent(threadId, evt)
    }
    source.onerror = () => {
      const s = runs[threadId]
      if (!s) return
      // EventSource reports both transient drops (readyState=0, CONNECTING)
      // and permanent failures (readyState=2, CLOSED). For a transient drop
      // the browser will reconnect on its own; if we close the source we
      // short-circuit that recovery. Only treat readyState=CLOSED as terminal.
      const closed = source.readyState === 2
      if (!closed) return
      if (s.phase !== 'done' && s.phase !== 'error' && s.phase !== 'cancelled') {
        s.phase = 'error'
        s.errors.push({ node: 'stream', message: 'SSE connection error', ts: Date.now() })
      }
      closeStream(s)
    }
  }

  async function startRun(input) {
    const res = await fetch('/api/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input || {}),
    })
    if (!res.ok) throw new Error(`run failed: ${res.status}`)
    const { threadId } = await res.json()
    const slice = ensureSlice(threadId)
    slice.phase = 'running'
    slice.lastInput = input
    slice.startedAt = Date.now()
    openStream(threadId)
    return threadId
  }

  // Optional `meta` ({ companyNumber, companyName }) lets callers that already
  // know the subject (refresh from a dossier page, resume-failed) seed those
  // fields so deriveSubjectName doesn't fall through to "New search" while
  // waiting for the first SSE state event to arrive.
  function attach(threadId, meta = null) {
    const slice = ensureSlice(threadId)
    if (slice.phase === 'idle') {
      slice.phase = 'running'
      slice.startedAt = slice.startedAt || Date.now()
    }
    if (meta) {
      if (meta.companyNumber && !slice.companyNumber) slice.companyNumber = meta.companyNumber
      if (meta.companyName && !slice.companyName) slice.companyName = meta.companyName
      if (meta.companyNumber && !slice.lastInput) {
        slice.lastInput = { companyNumber: meta.companyNumber, name: meta.companyName || undefined }
      }
    }
    if (!slice._source) openStream(threadId)
    return slice
  }

  async function hydrate({ force = false } = {}) {
    if (hydrated && !force) return
    if (hydratePromise) return hydratePromise
    hydratePromise = (async () => {
      try {
        const res = await fetch('/api/runs/active')
        if (!res.ok) return
        const list = await res.json()
        for (const r of list) {
          if (!r?.threadId) continue
          const existing = runs[r.threadId]
          const slice = ensureSlice(r.threadId)
          if (!existing) {
            if (r.phase === 'needs_user_pick') slice.phase = 'needs_user_pick'
            else if (r.phase === 'awaiting_decision') slice.phase = 'awaiting_decision'
            else slice.phase = 'running'
            slice.startedAt = r.startedAt || Date.now()
          }
          if (!slice.lastInput && r.lastInput) slice.lastInput = r.lastInput
          if (!slice.companyNumber && r.companyNumber) slice.companyNumber = r.companyNumber
          if (!slice.companyName && r.companyName) slice.companyName = r.companyName
          if (!slice.runId && r.runId) slice.runId = r.runId
          if (!slice.qaResult && r.qaResult) slice.qaResult = r.qaResult
          if (!slice.qaNarrative && r.qaNarrative) slice.qaNarrative = r.qaNarrative
          if (!slice.kycCard && r.kycCard) slice.kycCard = r.kycCard
          if (!existing) {
            if (Array.isArray(r.candidates) && r.candidates.length) {
              slice.candidates = r.candidates
            }
            if (r.resolution) slice.resolution = r.resolution
            openStream(r.threadId)
          }
        }
        hydrated = true
      } catch {
        // silent — hydration is best-effort
      } finally {
        hydratePromise = null
      }
    })()
    return hydratePromise
  }

  async function resume(threadId, companyNumber) {
    const slice = runs[threadId]
    if (!slice) return
    const picked = slice.candidates.find((c) => c.companyNumber === companyNumber)
    slice.resolution = {
      ...slice.resolution,
      chosen: companyNumber,
      chosenTitle: picked?.title || slice.resolution?.chosenTitle || null,
    }
    slice.phase = 'running'
    slice.candidates = []
    try {
      const res = await fetch(`/api/resume/${threadId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ companyNumber }),
      })
      if (!res.ok) throw new Error(`resume failed: ${res.status}`)
    } catch (err) {
      slice.phase = 'error'
      slice.errors.push({ node: 'resume', message: err.message, ts: Date.now() })
    }
  }

  async function cancelRun(threadId) {
    const slice = runs[threadId]
    if (!slice) return
    slice.phase = 'cancelled'
    slice.finishedAt = Date.now()
    closeStream(slice)
    try {
      await fetch(`/api/cancel/${threadId}`, { method: 'POST' })
    } catch (err) {
      slice.errors.push({
        node: 'cancel',
        message: `Cancel request failed: ${err.message}`,
        ts: Date.now(),
      })
    }
  }

  function removeRun(threadId) {
    const slice = runs[threadId]
    if (!slice) return
    closeStream(slice)
    delete runs[threadId]
  }

  const runningRuns = computed(() =>
    Object.values(runs)
      .filter((s) =>
        s.phase === 'running' ||
        s.phase === 'needs_user_pick' ||
        s.phase === 'awaiting_decision',
      )
      .map((s) => ({
        threadId: s.threadId,
        subjectName: deriveSubjectName(s),
        phase: s.phase,
        startedAt: s.startedAt,
      }))
      .sort((a, b) => (a.startedAt || 0) - (b.startedAt || 0))
  )

  return {
    runs,
    runningRuns,
    getRun,
    startRun,
    attach,
    hydrate,
    resume,
    cancelRun,
    removeRun,
    deriveSubjectName,
    TRANSPORT_NODES,
  }
})
