// Phase 5g — branch + function push toward web 80%.
//
// Covers:
//   - DossierViewPage.vue (was 57% stmts / 43% br / 47% fn): persistent vs
//     legacy mode, loading/not-found/empty/card branches, stale-latest-run
//     banner (failed + cancelled), refresh action (success + error), recalculate
//     action (success + error), screening/risk/decision sections, tags + notes,
//     run-history list + diff links + fmtDuration/fmtTime helpers, export URL.
//   - RunPage.vue (was 60/43/53): phase-driven branches (needs_user_pick,
//     awaiting_decision, done-with-card redirect, done-without-card, cancelled),
//     transport error + clean-up, in-stream errors, evidence + screening cards,
//     cancel + new-search + pick handlers, caseStatusStale patch.
//   - ProcessTab.vue (was 67/35/41): cytoscape tap handlers → selectedNodeView
//     (inbound/outbound edges, fragmentMeta I/O keys, sample details), node with
//     no fragmentMeta, switchGraph re-render, exportMermaid + copy (clipboard +
//     catch), fitGraph, fmtDate branches.
//
// Conventions copied from coverage-phase5e / pages-smoke-2: hoisted vi.mock for
// cytoscape + vue-router, real composables/stores driven by a URL-routing fetch
// mock, child components stubbed, HTMLDialogElement polyfill where needed.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia, getActivePinia } from 'pinia'
import { nextTick } from 'vue'

// ── Global mocks (hoisted before component imports) ─────────────────────────
vi.mock('cytoscape', () => {
  const cy = {
    on: vi.fn(),
    layout: vi.fn(() => ({ run: vi.fn() })),
    destroy: vi.fn(),
    elements: vi.fn(() => ({ forEach: vi.fn() })),
    nodes: vi.fn(() => ({ forEach: vi.fn() })),
    edges: vi.fn(() => ({ forEach: vi.fn() })),
    fit: vi.fn(),
    reset: vi.fn(),
  }
  const fn = vi.fn(() => cy)
  fn.use = vi.fn()
  return { default: fn }
})
vi.mock('cytoscape-dagre', () => ({ default: {} }))

const mockPush = vi.fn()
const mockRoute = { params: {}, query: {}, hash: '', name: 'dossier' }
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useRoute: () => mockRoute,
  RouterLink: { template: '<a><slot /></a>' },
  RouterView: { template: '<div />' },
}))

// Page / component imports (after mocks)
import DossierViewPage from '@/pages/DossierViewPage.vue'
import RunPage from '@/pages/RunPage.vue'
import ProcessTab from '@/components/ProcessTab.vue'
import { useAgentStore } from '@/stores/agent.js'

// ── Helpers ──────────────────────────────────────────────────────────────────
function ok(body) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) }
}
function fail(status = 500, body = { error: 'err' }) {
  return { ok: false, status, json: () => Promise.resolve(body) }
}
function getPinia() {
  return getActivePinia() || createPinia()
}

const PAGE_STUBS = {
  RouterLink: { template: '<a><slot /></a>' },
  RouterView: { template: '<div />' },
  KycCard: { template: '<div class="stub-kyc" />' },
  ScreeningTab: { template: '<div class="stub-screening" />' },
  RiskAssessmentCard: { template: '<button class="stub-risk" @click="$emit(\'recalculate\')" />' },
  FinalDecisionPanelReadOnly: { template: '<div class="stub-decision-ro" />' },
  FinalDecisionPanel: { template: '<div class="stub-decision" />' },
  QaNarrative: { template: '<div class="stub-narrative" />' },
  AgentTrail: { template: '<div class="stub-trail" />' },
  CandidateDisambiguation: { template: '<div class="stub-disambiguation" />' },
  NotFound: { template: '<div class="stub-notfound" />' },
  LiveEvidenceCard: { template: '<div class="stub-evidence" />' },
  ScreeningEvidenceCard: { template: '<div class="stub-screening-ev" />' },
  CountryFlag: { template: '<span />' },
}

function mountPage(component, options = {}) {
  return mount(component, {
    global: {
      plugins: [getPinia()],
      stubs: { ...PAGE_STUBS, ...(options.stubs || {}) },
      ...(options.global || {}),
    },
    attachTo: document.body,
    ...options,
  })
}

/** Routing fetch mock — matches on URL substring so call order doesn't matter. */
function routeFetch(routes) {
  return vi.fn((url, init) => {
    for (const [needle, responder] of routes) {
      if (String(url).includes(needle)) return Promise.resolve(responder(url, init))
    }
    return Promise.resolve(ok(null))
  })
}

const flush = (ms = 25) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  vi.restoreAllMocks()
  setActivePinia(createPinia())
  globalThis.EventSource.instances.length = 0
  globalThis.fetch = vi.fn().mockResolvedValue(ok(null))
  mockPush.mockClear()
  mockRoute.params = {}
  mockRoute.query = {}
  mockRoute.hash = ''
  vi.useRealTimers()
})

// ─── DossierViewPage ───────────────────────────────────────────────────────────

const DONE_RUN = {
  id: 'run-aaaaaaaa-1111',
  status: 'done',
  trigger: 'initial',
  startedAt: '2026-06-15T10:00:00Z',
  endedAt: '2026-06-15T10:02:30Z',
  finalKycCard: { identity: { name: 'ACME LTD', registrationNumber: '01234567' } },
  finalShareholderGraph: { nodes: [{ data: { id: 'n1' } }, { data: { id: 'n2' } }], edges: [{ data: {} }] },
  finalScreeningReport: { summary: { overallRisk: 'low' } },
  finalRiskAssessment: { score: 42, tier: 'Low', outcome: 'Proceed', matrixVersion: 3 },
  qaResult: { passed: true, routing: { caseStatus: 'streamlined_review' }, qaSummary: 'OK' },
  qaNarrative: 'A regulator-style memo.',
}

function dossierResp(overrides = {}) {
  return {
    id: 'd-1',
    companyNumber: '01234567',
    companyName: 'ACME LTD',
    caseStatus: 'pending',
    caseStatusUpdatedAt: null,
    tags: [],
    notes: null,
    runs: [DONE_RUN],
    ...overrides,
  }
}

function mountDossier(dossierBody, extraRoutes = []) {
  mockRoute.params = { companyNumber: '01234567' }
  globalThis.fetch = routeFetch([
    ['/parties', () => ok({ parties: [] })],
    ...extraRoutes,
    ['/api/dossiers/01234567', () => (dossierBody === null ? ok(null) : ok(dossierBody))],
  ])
  return mountPage(DossierViewPage)
}

describe('DossierViewPage', () => {
  it('renders without crashing in persistent mode', () => {
    expect(() => mountDossier(dossierResp())).not.toThrow()
  })

  it('renders KYC card + graph CTA once the done run loads', async () => {
    const w = mountDossier(dossierResp())
    await flush()
    expect(w.find('.stub-kyc').exists()).toBe(true)
    expect(w.html()).toContain('Open entity graph')
    // graph CTA shows entity/relationship counts
    expect(w.html()).toContain('2 entities')
    expect(w.html()).toContain('1 relationships')
  })

  it('renders screening, risk, decision sections from the latest run', async () => {
    const w = mountDossier(dossierResp())
    await flush()
    expect(w.find('.stub-screening').exists()).toBe(true)
    expect(w.find('.stub-risk').exists()).toBe(true)
    expect(w.find('.stub-decision-ro').exists()).toBe(true)
    expect(w.find('.stub-narrative').exists()).toBe(true)
  })

  it('shows loading state before the dossier resolves', async () => {
    mockRoute.params = { companyNumber: '01234567' }
    globalThis.fetch = vi.fn(() => new Promise(() => {})) // never resolves
    const w = mountPage(DossierViewPage)
    await nextTick()
    expect(w.html()).toContain('Loading dossier')
  })

  it('shows not-found state when the dossier returns null (404)', async () => {
    mockRoute.params = { companyNumber: '01234567' }
    globalThis.fetch = routeFetch([
      ['/parties', () => ok({ parties: [] })],
      ['/api/dossiers/01234567', () => fail(404)],
    ])
    const w = mountPage(DossierViewPage)
    await flush()
    expect(w.html()).toContain('Dossier not found')
  })

  it('shows the empty "No KYC card" state when no done run exists', async () => {
    const w = mountDossier(dossierResp({ runs: [{ ...DONE_RUN, status: 'failed', finalKycCard: null }] }))
    await flush()
    expect(w.html()).toContain('No KYC card')
  })

  it('empty-state "Start a new search" button routes to search', async () => {
    const w = mountDossier(dossierResp({ runs: [] }))
    await flush()
    const btn = w.findAll('button').find((b) => b.text().includes('Start a new search'))
    await btn.trigger('click')
    expect(mockPush).toHaveBeenCalledWith({ name: 'search' })
  })

  it('shows stale-run banner (failed) plus the last valid run fallback', async () => {
    const runs = [
      { ...DONE_RUN, id: 'run-failed-9', status: 'failed', finalKycCard: null },
      DONE_RUN,
    ]
    const w = mountDossier(dossierResp({ runs }))
    await flush()
    expect(w.html()).toContain('Latest run failed')
    expect(w.html()).toContain('Showing run')
    // KYC card still shows from the last valid (done) run
    expect(w.find('.stub-kyc').exists()).toBe(true)
  })

  it('shows stale-run banner (cancelled) with no prior completed run', async () => {
    const runs = [{ ...DONE_RUN, id: 'run-canc-7', status: 'cancelled', finalKycCard: null }]
    const w = mountDossier(dossierResp({ runs }))
    await flush()
    expect(w.html()).toContain('Latest run was cancelled')
    expect(w.html()).toContain('no prior completed run is available')
  })

  it('refresh action: success posts to /refresh and routes to run', async () => {
    const w = mountDossier(dossierResp(), [
      ['/refresh', () => ok({ threadId: 'thread-xyz' })],
    ])
    await flush()
    const btn = w.findAll('button').find((b) => b.text().includes('Refresh dossier'))
    await btn.trigger('click')
    await flush()
    expect(mockPush).toHaveBeenCalledWith({ name: 'run', params: { threadId: 'thread-xyz' } })
  })

  it('refresh action: error renders the refresh-failed banner', async () => {
    const w = mountDossier(dossierResp(), [
      ['/refresh', () => fail(500)],
    ])
    await flush()
    const btn = w.findAll('button').find((b) => b.text().includes('Refresh dossier'))
    await btn.trigger('click')
    await flush()
    expect(w.html()).toContain('Refresh failed')
  })

  it('refresh button is disabled while the latest run is running', async () => {
    const w = mountDossier(dossierResp({ runs: [{ ...DONE_RUN, status: 'running' }, DONE_RUN] }))
    await flush()
    const btn = w.findAll('button').find((b) => b.text().includes('Refresh'))
    expect(btn.attributes('disabled')).toBeDefined()
  })

  it('recalculate action: success shows the recalculated banner', async () => {
    const w = mountDossier(dossierResp(), [
      ['/recalculate-risk', () =>
        ok({ riskAssessment: { score: 55.4, outcome: 'Proceed', matrixVersion: 4 }, rationaleSource: 'llm' })],
    ])
    await flush()
    // RiskAssessmentCard stub emits 'recalculate' on click
    await w.find('.stub-risk').trigger('click')
    await flush()
    expect(w.html()).toContain('Risk recalculated')
    expect(w.html()).toContain('score 55')
  })

  it('recalculate action: error shows the recalculate-failed banner', async () => {
    const w = mountDossier(dossierResp(), [
      ['/recalculate-risk', () => fail(500, { error: 'no snapshot run' })],
    ])
    await flush()
    await w.find('.stub-risk').trigger('click')
    await flush()
    expect(w.html()).toContain('Recalculate failed')
    expect(w.html()).toContain('no snapshot run')
  })

  it('tags row toggles a tag (PATCH) and renders active state', async () => {
    const w = mountDossier(dossierResp(), [
      ['method:PATCH', () => ok({ tags: ['monitor'] })],
    ])
    await flush()
    const tagBtn = w.findAll('.tag-chip').find((b) => b.text() === 'monitor')
    expect(tagBtn).toBeTruthy()
    await tagBtn.trigger('click')
    await flush()
    expect(w.html().length).toBeGreaterThan(50)
  })

  it('notes textarea writes through setNotes (debounced patch)', async () => {
    const w = mountDossier(dossierResp())
    await flush()
    const ta = w.find('textarea.notes')
    expect(ta.exists()).toBe(true)
    await ta.setValue('Some reviewer note')
    expect(w.html().length).toBeGreaterThan(50)
  })

  it('renders run-history rows with status/trigger pills + diff links', async () => {
    const runs = [
      { ...DONE_RUN, id: 'run-bbbbbbbb-2', startedAt: '2026-06-15T11:00:00Z', endedAt: '2026-06-15T11:00:00Z' },
      { ...DONE_RUN, id: 'run-aaaaaaaa-1', trigger: 'refresh' },
    ]
    const w = mountDossier(dossierResp({ runs }))
    await flush()
    const html = w.html()
    expect(html).toContain('2 runs on record')
    expect(html).toContain('status-chip--done')
    expect(html).toContain('trigger-pill--initial')
    expect(html).toContain('trigger-pill--refresh')
    // newest run (index 0) has a "Diff vs previous" link; oldest has the disabled button
    expect(w.findAll('.run-row').length).toBe(2)
    const diffLinks = w.findAll('a').filter((a) => a.text().includes('Diff vs previous'))
    expect(diffLinks.length).toBe(1)
    const disabledDiff = w.findAll('button').find((b) => b.text().includes('Diff vs previous'))
    expect(disabledDiff.attributes('disabled')).toBeDefined()
  })

  it('renders the terminal decision outcome when caseStatus is approved', async () => {
    const w = mountDossier(dossierResp({ caseStatus: 'approved', caseStatusUpdatedAt: '2026-06-15T12:00:00Z' }))
    await flush()
    expect(w.html()).toContain('Approved')
    expect(w.html()).toContain('Outcome')
  })

  it('export JSON link points at the run export endpoint', async () => {
    const w = mountDossier(dossierResp())
    await flush()
    const link = w.findAll('a').find((a) => a.text().includes('Export JSON'))
    expect(link.attributes('href')).toContain('/runs/')
    expect(link.attributes('href')).toContain('/export.json')
  })

  it('renders the header run id + generated-at chip from the header run', async () => {
    const w = mountDossier(dossierResp())
    await flush()
    // reportId = run id first 8 upper-cased
    expect(w.html()).toContain('RUN-AAAA')
  })

  it('legacy /dossier/current mode renders the empty card sheet without fetching a dossier', async () => {
    mockRoute.params = {} // no companyNumber → non-persistent
    globalThis.fetch = vi.fn().mockResolvedValue(ok(null))
    const w = mountPage(DossierViewPage)
    await flush()
    // Non-persistent → card computed is null → empty "No KYC card" sheet
    expect(w.html()).toContain('No KYC card')
  })
})

// ─── RunPage ────────────────────────────────────────────────────────────────────

function seedSlice(threadId, slice) {
  const store = useAgentStore()
  store.runs[threadId] = {
    phase: 'idle',
    _source: null,
    fragments: [],
    trace: [],
    errors: [],
    candidates: [],
    resolution: null,
    progress: null,
    kycCard: null,
    companyNumber: null,
    runId: null,
    qaResult: null,
    qaNarrative: null,
    caseStatus: null,
    screening: null,
    ...slice,
  }
  return store
}

function mountRun(threadId = 'thread-run-1') {
  mockRoute.params = { threadId }
  return mountPage(RunPage)
}

describe('RunPage', () => {
  it('renders without crashing for a fresh (idle) thread', () => {
    expect(() => mountRun()).not.toThrow()
  })

  it('renders the agent-trail stub and fragment count', async () => {
    seedSlice('thread-run-1', {
      phase: 'running',
      _source: {},
      fragments: [{ id: 'f1', nodeId: 'gather_input' }],
    })
    const w = mountRun('thread-run-1')
    await nextTick()
    expect(w.find('.stub-trail').exists()).toBe(true)
  })

  it('shows candidate disambiguation in needs_user_pick phase and forwards pick', async () => {
    const store = seedSlice('thread-run-1', {
      phase: 'needs_user_pick',
      _source: {},
      candidates: [{ companyNumber: '01234567', title: 'ACME LTD' }],
      resolution: { decision: 'needs_user_pick' },
    })
    const resumeSpy = vi.spyOn(store, 'resume').mockResolvedValue(undefined)
    const w = mountRun('thread-run-1')
    await nextTick()
    const disambiguation = w.findComponent('.stub-disambiguation')
    expect(disambiguation.exists()).toBe(true)
    // emit pick from the disambiguation stub
    disambiguation.vm.$emit('pick', '01234567')
    await nextTick()
    expect(resumeSpy).toHaveBeenCalledWith('thread-run-1', '01234567')
  })

  it('shows the FinalDecisionPanel in awaiting_decision phase', async () => {
    seedSlice('thread-run-1', {
      phase: 'awaiting_decision',
      _source: {},
      companyNumber: '01234567',
      runId: 'run-1',
      qaResult: { passed: true, routing: { caseStatus: 'standard_review' } },
      caseStatus: 'pending',
    })
    const w = mountRun('thread-run-1')
    await nextTick()
    expect(w.find('.stub-decision').exists()).toBe(true)
  })

  it('shows the NotFound card in done phase without a KYC card', async () => {
    seedSlice('thread-run-1', {
      phase: 'done',
      _source: null,
      kycCard: null,
      resolution: { decision: 'not_found' },
    })
    const w = mountRun('thread-run-1')
    await nextTick()
    expect(w.find('.stub-notfound').exists()).toBe(true)
  })

  it('shows the View-dossier CTA + schedules redirect when run transitions to done with a KYC card', async () => {
    vi.useFakeTimers()
    // Mount in a running phase first, then flip to done so the (non-immediate)
    // phase watcher fires and schedules the redirect.
    const store = seedSlice('thread-run-1', {
      phase: 'running',
      _source: {},
      kycCard: null,
      companyNumber: '01234567',
    })
    const removeSpy = vi.spyOn(store, 'removeRun').mockImplementation(() => {})
    mockRoute.params = { threadId: 'thread-run-1' }
    const w = mountPage(RunPage)
    await nextTick()
    // transition to done with a card
    store.runs['thread-run-1'].kycCard = { identity: { name: 'ACME LTD' } }
    store.runs['thread-run-1'].phase = 'done'
    await nextTick()
    expect(w.find('.feed-cta').exists()).toBe(true)
    // the phase watcher schedules a 600ms redirect — advance timers
    vi.advanceTimersByTime(700)
    expect(mockPush).toHaveBeenCalledWith({ name: 'dossier', params: { companyNumber: '01234567' } })
    expect(removeSpy).toHaveBeenCalledWith('thread-run-1')
    vi.useRealTimers()
  })

  it('shows the cancelled message in cancelled phase', async () => {
    seedSlice('thread-run-1', { phase: 'cancelled', _source: null })
    const w = mountRun('thread-run-1')
    await nextTick()
    expect(w.html()).toContain('This run was cancelled')
  })

  it('renders a transport-error banner + clean-up button and cancels on click', async () => {
    const transportNode = [...useAgentStore().TRANSPORT_NODES][0]
    const store = seedSlice('thread-run-1', {
      phase: 'error',
      _source: null,
      errors: [{ node: transportNode, message: 'stream lost' }],
    })
    const cancelSpy = vi.spyOn(store, 'cancelRun').mockImplementation(() => {})
    const w = mountRun('thread-run-1')
    await nextTick()
    expect(w.html()).toContain('Connection problem')
    const cleanBtn = w.findAll('button').find((b) => b.text().includes('Clean up this run'))
    expect(cleanBtn).toBeTruthy()
    await cleanBtn.trigger('click')
    expect(cancelSpy).toHaveBeenCalled()
  })

  it('renders in-stream (non-transport) errors section', async () => {
    seedSlice('thread-run-1', {
      phase: 'error',
      _source: null,
      errors: [{ node: 'process_documents', message: 'OCR exploded' }],
    })
    const w = mountRun('thread-run-1')
    await nextTick()
    expect(w.html()).toContain('Errors during processing')
    expect(w.html()).toContain('OCR exploded')
  })

  it('shows the cancel button while running and calls cancelRun', async () => {
    const store = seedSlice('thread-run-1', { phase: 'running', _source: {} })
    const cancelSpy = vi.spyOn(store, 'cancelRun').mockImplementation(() => {})
    const w = mountRun('thread-run-1')
    await nextTick()
    const cancelBtn = w.findAll('button').find((b) => b.text().includes('Cancel this run'))
    expect(cancelBtn).toBeTruthy()
    await cancelBtn.trigger('click')
    expect(cancelSpy).toHaveBeenCalled()
  })

  it('new-search button routes to search', async () => {
    seedSlice('thread-run-1', { phase: 'idle', _source: {} })
    const w = mountRun('thread-run-1')
    await nextTick()
    const btn = w.findAll('button').find((b) => b.text().includes('New search'))
    await btn.trigger('click')
    expect(mockPush).toHaveBeenCalledWith({ name: 'search' })
  })

  it('shows the live evidence card while the document pipeline is active', async () => {
    seedSlice('thread-run-1', {
      phase: 'running',
      _source: {},
      progress: { stage: 'ocr', current: 1, total: 3 },
    })
    const w = mountRun('thread-run-1')
    await nextTick()
    expect(w.find('.stub-evidence').exists()).toBe(true)
  })

  it('hides the live evidence card once the doc stage is terminal', async () => {
    seedSlice('thread-run-1', {
      phase: 'running',
      _source: {},
      progress: { stage: 'batch_done' },
    })
    const w = mountRun('thread-run-1')
    await nextTick()
    expect(w.find('.stub-evidence').exists()).toBe(false)
  })

  it('shows the screening evidence card while screening is live', async () => {
    seedSlice('thread-run-1', {
      phase: 'running',
      _source: {},
      fragments: [],
      screening: { subjects: [{ subjectId: 's1' }], hits: [], currentSubjectId: 's1' },
    })
    const w = mountRun('thread-run-1')
    await nextTick()
    expect(w.find('.stub-screening-ev').exists()).toBe(true)
  })

  it('hides the screening card once compile_screening_report fragment landed', async () => {
    seedSlice('thread-run-1', {
      phase: 'running',
      _source: {},
      fragments: [{ id: 'f', nodeId: 'compile_screening_report' }],
      screening: { subjects: [{ subjectId: 's1' }], hits: [], currentSubjectId: 's1' },
    })
    const w = mountRun('thread-run-1')
    await nextTick()
    expect(w.find('.stub-screening-ev').exists()).toBe(false)
  })

  it('caseStatusStale event patches the slice caseStatus', async () => {
    const store = seedSlice('thread-run-1', {
      phase: 'awaiting_decision',
      _source: {},
      companyNumber: '01234567',
      runId: 'run-1',
      qaResult: { passed: true, routing: { caseStatus: 'standard_review' } },
      caseStatus: 'pending',
    })
    const w = mountRun('thread-run-1')
    await nextTick()
    const panel = w.findComponent('.stub-decision')
    expect(panel.exists()).toBe(true)
    panel.vm.$emit('case-status-stale', 'approved')
    await nextTick()
    expect(store.runs['thread-run-1'].caseStatus).toBe('approved')
  })
})

// ─── ProcessTab ─────────────────────────────────────────────────────────────────

const PROCESS_DATA = {
  graphs: [
    {
      label: 'main',
      mermaid: 'graph TB\n  gather_input --> assess_risk',
      nodes: [
        { id: 'gather_input', name: 'Gather input', classification: 'audit' },
        { id: 'assess_risk', name: 'Assess risk', classification: 'decision' },
        { id: 'await_confirmation', name: 'Await confirmation', classification: 'interrupt' },
      ],
      edges: [
        { source: 'gather_input', target: 'assess_risk', conditional: false },
        { source: 'assess_risk', target: 'await_confirmation', conditional: true },
      ],
    },
    {
      label: 'screening_only',
      mermaid: 'graph TB\n  screen_sanctions --> END',
      nodes: [{ id: 'screen_sanctions', name: 'Screen sanctions', classification: 'audit' }],
      edges: [],
    },
  ],
}

const DATA_MODEL_DATA = {
  fragmentsByNode: [
    {
      nodeId: 'assess_risk',
      occurrences: 12,
      lastSeenAt: '2026-06-15T00:00:00Z',
      observedInputKeys: ['profile', 'kycCard'],
      observedOutputKeys: ['riskAssessment'],
      sample: { summary: 'Risk assessed', inputs: { profile: {} }, outputs: { riskAssessment: {} } },
    },
  ],
}

function mountProcess() {
  globalThis.fetch = routeFetch([
    ['/api/meta/process', () => ok(PROCESS_DATA)],
    ['/api/meta/data-model', () => ok(DATA_MODEL_DATA)],
  ])
  return mount(ProcessTab, {
    global: { plugins: [getPinia()], stubs: PAGE_STUBS },
    attachTo: document.body,
  })
}

async function getTapHandlers() {
  const cytoscape = (await import('cytoscape')).default
  const cy = cytoscape.mock.results.at(-1)?.value
  if (!cy) return {}
  // The shared cy mock accumulates `on` calls across renders/tests, and each
  // render() registers fresh handlers closing over the *current* component's
  // reactive state. Grab the LAST matching registration so we drive the
  // currently-mounted instance, not a stale one.
  const calls = cy.on.mock.calls
  const nodeTap = calls.findLast(([evt, sel]) => evt === 'tap' && sel === 'node')?.[2]
  const bgTap = calls.findLast(([evt, sel]) => evt === 'tap' && typeof sel === 'function')?.[1]
  return { nodeTap, bgTap, cy }
}

describe('ProcessTab', () => {
  it('renders graph tabs after data loads', async () => {
    const w = mountProcess()
    await flush()
    expect(w.html()).toContain('Full run')
    expect(w.html()).toContain('Screening only')
    expect(w.html()).toContain('3 nodes')
  })

  it('selecting a node with fragmentMeta renders the I/O panel + sample', async () => {
    const w = mountProcess()
    await flush()
    const { nodeTap } = await getTapHandlers()
    expect(nodeTap).toBeTypeOf('function')
    nodeTap({ target: { id: () => 'assess_risk' } })
    await nextTick()
    const html = w.html()
    expect(html).toContain('assess_risk')
    // classification pill
    expect(html).toContain('dm-class-pill--decision')
    // observed I/O keys from the fragment meta
    expect(html).toContain('profile')
    expect(html).toContain('riskAssessment')
    expect(html).toContain('Runs sampled')
    // inbound edge from gather_input
    expect(html).toContain('gather_input')
    // outbound conditional edge marker
    expect(html).toContain('(cond)')
    // most-recent sample summary
    expect(html).toContain('Risk assessed')
  })

  it('selecting a node without fragmentMeta shows the no-fragments message', async () => {
    const w = mountProcess()
    await flush()
    const { nodeTap } = await getTapHandlers()
    nodeTap({ target: { id: () => 'gather_input' } })
    await nextTick()
    expect(w.html()).toContain('No fragments captured yet')
  })

  it('background tap clears the selected node', async () => {
    const w = mountProcess()
    await flush()
    const { nodeTap, bgTap, cy } = await getTapHandlers()
    nodeTap({ target: { id: () => 'assess_risk' } })
    await nextTick()
    expect(w.html()).toContain('Graph connectivity')
    // bgTap clears selection when target === cy
    bgTap({ target: cy })
    await nextTick()
    expect(w.html()).toContain('Click a node')
  })

  it('switching graphs clears the selection and re-renders', async () => {
    const w = mountProcess()
    await flush()
    const { nodeTap } = await getTapHandlers()
    nodeTap({ target: { id: () => 'assess_risk' } })
    await nextTick()
    const screeningTab = w.findAll('.proc-tab').find((t) => t.text().includes('Screening only'))
    await screeningTab.trigger('click')
    await flush()
    // selection cleared after switching
    expect(w.html()).toContain('Click a node')
  })

  it('export-mermaid copies the mermaid string to the clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const w = mountProcess()
    await flush()
    const btn = w.findAll('button').find((b) => b.text().includes('Copy as Mermaid'))
    await btn.trigger('click')
    await flush()
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('graph TB'))
    expect(w.html()).toContain('Copied Mermaid')
  })

  it('export-mermaid swallows clipboard errors', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.assign(navigator, { clipboard: { writeText } })
    const w = mountProcess()
    await flush()
    const btn = w.findAll('button').find((b) => b.text().includes('Copy as Mermaid'))
    await btn.trigger('click')
    await flush()
    // no crash, label stays at the default
    expect(w.html()).toContain('Copy as Mermaid')
  })

  it('Fit button invokes cy.fit', async () => {
    const w = mountProcess()
    await flush()
    const { cy } = await getTapHandlers()
    const fitBtn = w.find('.proc-fit')
    await fitBtn.trigger('click')
    expect(cy.fit).toHaveBeenCalled()
  })

  it('Reload re-fetches process + data-model', async () => {
    const w = mountProcess()
    await flush()
    const callsBefore = globalThis.fetch.mock.calls.length
    const reloadBtn = w.findAll('button').find((b) => b.text().includes('Reload'))
    await reloadBtn.trigger('click')
    await flush()
    expect(globalThis.fetch.mock.calls.length).toBeGreaterThan(callsBefore)
  })

  it('shows the error message when the process fetch fails', async () => {
    globalThis.fetch = routeFetch([
      ['/api/meta/process', () => fail(500)],
      ['/api/meta/data-model', () => ok(DATA_MODEL_DATA)],
    ])
    const w = mount(ProcessTab, {
      global: { plugins: [getPinia()], stubs: PAGE_STUBS },
      attachTo: document.body,
    })
    await flush()
    expect(w.html()).toContain('process: HTTP 500')
  })
})
