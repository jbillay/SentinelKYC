// Phase 2 — the agent store: SSE event handling, run lifecycle, the screening
// slice, and derived run list. Events are driven through the mocked EventSource
// from test/setup.js (its onmessage is assigned by the store's openStream).
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useAgentStore } from '@/stores/agent.js'

function jsonRes(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: () => Promise.resolve(body) }
}

// Fire an SSE event into the most-recently-opened EventSource.
function emit(evt) {
  const src = globalThis.EventSource.instances.at(-1)
  src.onmessage({ data: JSON.stringify(evt) })
}

beforeEach(() => {
  setActivePinia(createPinia())
  globalThis.EventSource.instances.length = 0
})

async function startRun(store, input = { name: 'ACME' }) {
  globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({ threadId: 't1' }))
  return store.startRun(input)
}

describe('agent store — run lifecycle', () => {
  it('startRun opens a stream and marks the slice running', async () => {
    const s = useAgentStore()
    const threadId = await startRun(s)
    expect(threadId).toBe('t1')
    expect(s.getRun('t1').phase).toBe('running')
    expect(globalThis.EventSource.instances).toHaveLength(1)
  })

  it('throws when /api/run fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({}, { ok: false, status: 500 }))
    const s = useAgentStore()
    await expect(s.startRun({})).rejects.toThrow(/run failed/)
  })
})

describe('agent store — handleEvent', () => {
  let s
  beforeEach(async () => {
    s = useAgentStore()
    await startRun(s)
  })

  it('appends trace, error and progress', () => {
    emit({ type: 'trace', node: 'searchCh', msg: 'searching', ts: 1 })
    emit({ type: 'error', node: 'fetchApis', message: 'boom', ts: 2 })
    emit({ type: 'progress', node: 'x', pct: 50 })
    const slice = s.getRun('t1')
    expect(slice.trace).toHaveLength(1)
    expect(slice.errors[0].message).toBe('boom')
    expect(slice.progress.pct).toBe(50)
  })

  it('upserts fragments by id', () => {
    emit({ type: 'fragment', fragment: { id: 'f1', summary: 'a' } })
    emit({ type: 'fragment', fragment: { id: 'f1', summary: 'a-updated' } })
    emit({ type: 'fragment', fragment: { id: 'f2', summary: 'b' } })
    const slice = s.getRun('t1')
    expect(slice.fragments).toHaveLength(2)
    expect(slice.fragments.find((f) => f.id === 'f1').summary).toBe('a-updated')
  })

  it('handles an entity-selection interrupt', () => {
    emit({ type: 'interrupt', payload: { candidates: [{ companyNumber: '1', title: 'ACME LTD' }] } })
    const slice = s.getRun('t1')
    expect(slice.phase).toBe('needs_user_pick')
    expect(slice.candidates).toHaveLength(1)
  })

  it('handles a final-decision interrupt by seeding QA/risk payload', () => {
    emit({
      type: 'interrupt',
      kind: 'final_decision',
      payload: { qaResult: { passed: true }, riskAssessment: { tier: 'Low' }, runId: 'run9', caseStatus: 'streamlined_review' },
    })
    const slice = s.getRun('t1')
    expect(slice.phase).toBe('awaiting_decision')
    expect(slice.qaResult).toEqual({ passed: true })
    expect(slice.runId).toBe('run9')
  })

  it('freezes final snapshots and closes on done', () => {
    emit({ type: 'done', state: { kycCard: { identity: { name: 'ACME' } }, runId: 'r1', caseStatus: 'auto_approved' } })
    const slice = s.getRun('t1')
    expect(slice.phase).toBe('done')
    expect(slice.caseStatus).toBe('auto_approved')
    expect(slice._source).toBeNull() // stream closed
  })

  it('accumulates the screening slice across subject/hit/evaluation events', () => {
    emit({ type: 'screening_subject_started', subjectId: 's1', subjectName: 'Jane', listSource: 'ofac_sdn', ts: 1 })
    emit({ type: 'screening_hit', hit: { hitId: 'h1', subjectId: 's1', listSource: 'ofac_sdn' }, ts: 2 })
    emit({ type: 'screening_hit_evaluated', hitId: 'h1', decision: 'dismissed', llmScore: 0.1, ts: 3 })
    emit({ type: 'screening_hit_evaluated', hitId: 'h1', decision: 'confirmed', llmScore: 0.9, ts: 4 }) // upsert
    const sc = s.getRun('t1').screening
    expect(sc.subjects).toHaveLength(1)
    expect(sc.screenedByList.ofac_sdn.s1).toBe(true)
    expect(sc.hits).toHaveLength(1)
    expect(sc.evaluations).toHaveLength(1)
    expect(sc.evaluations[0].decision).toBe('confirmed')
  })

  it('caps the screening lastEvents window at 8', () => {
    for (let i = 0; i < 12; i++) emit({ type: 'screening_subject_started', subjectId: `s${i}`, listSource: 'uk_hmt', ts: i })
    expect(s.getRun('t1').screening.lastEvents).toHaveLength(8)
  })
})

describe('agent store — derived list & lifecycle ops', () => {
  it('runningRuns lists active runs with a derived subject name', async () => {
    const s = useAgentStore()
    await startRun(s, { name: 'ACME WIDGETS' })
    const list = s.runningRuns
    expect(list).toHaveLength(1)
    expect(list[0].subjectName).toBe('ACME WIDGETS')
  })

  it('deriveSubjectName falls back through the known signals', () => {
    const s = useAgentStore()
    expect(s.deriveSubjectName({ kycCard: { companyName: 'A' }, candidates: [] })).toBe('A')
    expect(s.deriveSubjectName({ profile: { company_name: 'B' }, candidates: [] })).toBe('B')
    expect(s.deriveSubjectName({ lastInput: { companyNumber: '99' }, candidates: [] })).toBe('Company #99')
    expect(s.deriveSubjectName({ candidates: [] })).toBe('New search')
  })

  it('cancelRun marks cancelled and posts cancel', async () => {
    const s = useAgentStore()
    await startRun(s)
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({ ok: true }))
    await s.cancelRun('t1')
    expect(s.getRun('t1').phase).toBe('cancelled')
  })

  it('removeRun deletes the slice', async () => {
    const s = useAgentStore()
    await startRun(s)
    s.removeRun('t1')
    expect(s.getRun('t1')).toBeNull()
  })

  it('resume records the chosen candidate and posts', async () => {
    const s = useAgentStore()
    await startRun(s)
    emit({ type: 'interrupt', payload: { candidates: [{ companyNumber: '1', title: 'ACME LTD' }] } })
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({ ok: true }))
    await s.resume('t1', '1')
    expect(s.getRun('t1').resolution.chosen).toBe('1')
    expect(s.getRun('t1').phase).toBe('running')
  })
})
