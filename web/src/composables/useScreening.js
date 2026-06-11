import { ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAgentStore } from '../stores/agent.js'

// Fetches screening detail for a frozen run, derives per-subject groupings,
// and exposes optimistic override mutations + rescreen / carry-overrides
// helpers. The `report` ref is updated in place after a successful PATCH
// (the server re-derives it).
//
// Pass `companyNumber` and `runId` as refs (or static strings).
export function useScreening(companyNumber, runId) {
  const router = useRouter()
  const agent = useAgentStore()

  const report = ref(null)
  const hits = ref([])
  const evaluations = ref([])
  const loading = ref(false)
  const error = ref(null)

  const evalsByHit = computed(() => {
    const m = new Map()
    for (const e of evaluations.value) m.set(e.hitId, e)
    return m
  })

  // Effective decision = humanOverride || decision (matches services/screening/report.js).
  function effectiveDecision(ev) {
    if (!ev) return 'unevaluated'
    if (ev.humanOverride) return ev.humanOverride
    return ev.decision
  }

  // Group hits by subjectId. Subject metadata (name/kind/source) is pulled
  // from the report's perSubject array — that's the canonical source.
  const subjectGroups = computed(() => {
    const meta = new Map()
    for (const ps of report.value?.perSubject || []) {
      meta.set(ps.subjectId, {
        subjectId: ps.subjectId,
        name: ps.name,
        kind: ps.kind,
        source: ps.source,
        worstStatus: ps.worstStatus,
        buckets: ps.hits,
      })
    }

    const groups = new Map()
    for (const h of hits.value) {
      const key = h.subjectId
      if (!groups.has(key)) {
        groups.set(key, {
          ...(meta.get(key) || {
            subjectId: key,
            name: h.subjectName,
            kind: h.subjectKind,
            source: h.subjectSource,
          }),
          hits: [],
        })
      }
      const ev = evalsByHit.value.get(h.id) || null
      groups.get(key).hits.push({
        ...h,
        evaluation: ev,
        effective: effectiveDecision(ev),
      })
    }

    // Subject sort: confirmed > needs_review > dismissed > clean.
    const rank = { confirmed: 0, needs_review: 1, dismissed: 2, clean: 3 }
    return Array.from(groups.values()).sort((a, b) => {
      const ra = rank[a.worstStatus ?? 'clean'] ?? 3
      const rb = rank[b.worstStatus ?? 'clean'] ?? 3
      return ra - rb
    })
  })

  async function load() {
    const cn = companyNumber.value ?? companyNumber
    const rid = runId.value ?? runId
    if (!cn || !rid) return
    loading.value = true
    error.value = null
    try {
      const res = await fetch(
        `/api/dossiers/${encodeURIComponent(cn)}/runs/${encodeURIComponent(rid)}/screening`
      )
      if (!res.ok) throw new Error(`screening fetch failed: ${res.status}`)
      const data = await res.json()
      report.value = data.report || null
      hits.value = data.hits || []
      evaluations.value = data.evaluations || []
    } catch (err) {
      error.value = err.message
    } finally {
      loading.value = false
    }
  }

  watch(
    [() => companyNumber.value ?? companyNumber, () => runId.value ?? runId],
    () => load(),
    { immediate: true }
  )

  // Optimistic override: flip the local evaluation immediately; on PATCH
  // failure roll back. PATCH returns the freshly re-derived screeningReport,
  // which we replace into `report`.
  async function setOverride(hitId, decision, reason = null) {
    const cn = companyNumber.value ?? companyNumber
    const rid = runId.value ?? runId
    const idx = evaluations.value.findIndex((e) => e.hitId === hitId)
    const prior = idx >= 0 ? { ...evaluations.value[idx] } : null

    if (idx >= 0) {
      evaluations.value.splice(idx, 1, {
        ...evaluations.value[idx],
        humanOverride: decision ?? null,
        overrideReason: decision ? reason : null,
      })
    }

    try {
      const res = await fetch(
        `/api/dossiers/${encodeURIComponent(cn)}/runs/${encodeURIComponent(rid)}/hits/${encodeURIComponent(hitId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ decision, reason }),
        }
      )
      if (!res.ok) throw new Error(`override failed: ${res.status}`)
      const body = await res.json()
      if (body.evaluation) {
        const i = evaluations.value.findIndex((e) => e.hitId === hitId)
        if (i >= 0) evaluations.value.splice(i, 1, body.evaluation)
        else evaluations.value.push(body.evaluation)
      }
      if (body.report) report.value = body.report
      return body
    } catch (err) {
      if (prior && idx >= 0) evaluations.value.splice(idx, 1, prior)
      else if (idx >= 0) evaluations.value.splice(idx, 1)
      error.value = err.message
      throw err
    }
  }

  async function carryOverridesForward() {
    const cn = companyNumber.value ?? companyNumber
    const rid = runId.value ?? runId
    const res = await fetch(
      `/api/dossiers/${encodeURIComponent(cn)}/runs/${encodeURIComponent(rid)}/carry-overrides-forward`,
      { method: 'POST' }
    )
    if (!res.ok) throw new Error(`carry-forward failed: ${res.status}`)
    return res.json()
  }

  async function rescreen() {
    const cn = companyNumber.value ?? companyNumber
    const res = await fetch(`/api/dossiers/${encodeURIComponent(cn)}/rescreen`, {
      method: 'POST',
    })
    if (!res.ok) {
      const text = await res.text().catch(() => '')
      throw new Error(text || `rescreen failed: ${res.status}`)
    }
    const { threadId } = await res.json()
    agent.attach(threadId)
    if (router) router.push({ name: 'run', params: { threadId } })
    return threadId
  }

  return {
    report,
    hits,
    evaluations,
    subjectGroups,
    loading,
    error,
    refresh: load,
    setOverride,
    carryOverridesForward,
    rescreen,
  }
}
