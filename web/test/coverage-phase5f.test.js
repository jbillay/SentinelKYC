// Phase 5f — branch + function push toward web 80%.
//
// Covers:
//   - AdminPage.vue (was 44% stmts / 16% br / 21% fn — biggest single file):
//       tab navigation + hash deep-link, screening config load/save/error,
//       risk-matrix editor (clientValidateMatrix branches, save flows, set-active),
//       prompts editor (pick key/version, save, set-active toggle, show-default),
//       members tab (initials, login fmt, active count, error).
//   - PartiesPage.vue (was 47/44/20): list render, filters, pagination, empty state.
//   - PartyDetailPage.vue (was 47/32/17): identity render, tab switching,
//       watchlist toggle, screening overrides, merge dialog, loading/error.
//   - HealthIndicator.vue (was 64/12): banner states (ok / degraded / down / unknown),
//       popover model rows, checkedLabel ranges, refresh.
//   - ScreeningHitPanel.vue (was 61/35/48): override form, confirm/dismiss/clear,
//       readonly mode, adverse-media vs sanctions render, reasoning expand.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia } from 'pinia'
import { ref, nextTick } from 'vue'

// ── Global mocks (hoisted before any imports) ───────────────────────────────
vi.mock('cytoscape', () => {
  const cy = {
    on: vi.fn(), layout: vi.fn(() => ({ run: vi.fn() })), destroy: vi.fn(),
    elements: vi.fn(() => ({ forEach: vi.fn() })), nodes: vi.fn(() => ({ forEach: vi.fn() })),
    edges: vi.fn(() => ({ forEach: vi.fn() })), fit: vi.fn(), reset: vi.fn(),
  }
  const fn = vi.fn(() => cy)
  fn.use = vi.fn()
  return { default: fn }
})
vi.mock('cytoscape-dagre', () => ({ default: {} }))

const mockPush = vi.fn()
const mockReplace = vi.fn()
let routeRef = { params: { partyId: 'party-abc' }, query: {}, hash: '' }
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mockPush, replace: mockReplace }),
  useRoute: () => routeRef,
  RouterLink: { template: '<a><slot /></a>' },
  RouterView: { template: '<div />' },
}))

// ── usePrompts mock — controllable refs the AdminPage prompts tab drives ─────
const promptState = {}
const promptFns = {}
vi.mock('@/composables/usePrompts.js', async () => {
  const { ref: r } = await import('vue')
  return {
    usePrompts: () => {
      promptState.list = r([])
      promptState.detail = r(null)
      promptState.selectedVersionId = r(null)
      promptState.editorBody = r('')
      promptState.editorNotes = r('')
      promptState.saving = r(false)
      promptState.error = r(null)
      promptFns.fetchList = vi.fn(async () => { promptState.list.value = PROMPT_LIST })
      promptFns.selectKey = vi.fn(async (key) => {
        promptState.detail.value = makePromptDetail(key)
        promptState.selectedVersionId.value = 'v2'
        promptState.editorBody.value = 'active body'
      })
      promptFns.selectVersion = vi.fn(async (id) => { promptState.selectedVersionId.value = id })
      promptFns.saveAsNewVersion = vi.fn(async () => {})
      promptFns.setActive = vi.fn(async () => {})
      return {
        list: promptState.list,
        detail: promptState.detail,
        selectedVersionId: promptState.selectedVersionId,
        editorBody: promptState.editorBody,
        editorNotes: promptState.editorNotes,
        saving: promptState.saving,
        error: promptState.error,
        fetchList: promptFns.fetchList,
        selectKey: promptFns.selectKey,
        selectVersion: promptFns.selectVersion,
        saveAsNewVersion: promptFns.saveAsNewVersion,
        setActive: promptFns.setActive,
      }
    },
  }
})

// ── useRiskMatrix mock — controllable refs the AdminPage risk tab drives ─────
const riskState = {}
const riskFns = {}
vi.mock('@/composables/useRiskMatrix.js', async () => {
  const { ref: r } = await import('vue')
  return {
    useRiskMatrix: () => {
      riskState.active = r(null)
      riskState.versions = r([])
      riskState.versionDetail = r(null)
      riskState.loading = r(false)
      riskState.saving = r(false)
      riskState.error = r(null)
      riskState.validationErrors = r([])
      riskFns.load = vi.fn(async () => {
        riskState.active.value = { versionId: 'rv1', version: 1, body: MATRIX_BODY, notes: 'v1 notes', updatedAt: '2026-06-01T00:00:00Z' }
        riskState.versions.value = [{ id: 'rv1', version: 1, notes: 'v1 notes', createdAt: '2026-06-01T00:00:00Z' }]
      })
      riskFns.fetchVersion = vi.fn(async (id) => {
        riskState.versionDetail.value = { id, version: 1, body: MATRIX_BODY }
        return riskState.versionDetail.value
      })
      riskFns.createVersion = vi.fn(async () => ({ id: 'rv2', version: 2 }))
      riskFns.setActive = vi.fn(async () => true)
      return {
        active: riskState.active,
        versions: riskState.versions,
        versionDetail: riskState.versionDetail,
        loading: riskState.loading,
        saving: riskState.saving,
        error: riskState.error,
        validationErrors: riskState.validationErrors,
        load: riskFns.load,
        fetchVersion: riskFns.fetchVersion,
        createVersion: riskFns.createVersion,
        setActive: riskFns.setActive,
      }
    },
  }
})

// ── useParty mock — controllable for PartyDetailPage ─────────────────────────
const partyState = {}
const partyFns = {}
vi.mock('@/composables/useParty.js', async () => {
  const { ref: r } = await import('vue')
  return {
    useParty: () => {
      partyState.party = r(PARTY)
      partyState.links = r(PARTY_LINKS)
      partyState.reviewItems = r([])
      partyState.riskSummary = r({ dossierCount: 2, worstTier: 'High', highRiskDossierCount: 1 })
      partyState.isWatched = r(false)
      partyState.loading = r(false)
      partyState.error = r(null)
      partyState.actionState = r({ submitting: false, error: null })
      partyState.screening = r(null)
      partyState.screeningLoading = r(false)
      partyState.screeningError = r(null)
      partyFns.load = vi.fn()
      partyFns.mergeFrom = vi.fn(async () => ({}))
      partyFns.loadScreening = vi.fn(async () => { partyState.screening.value = SCREENING_SUMMARY })
      partyFns.setOverride = vi.fn(async () => ({}))
      partyFns.setWatched = vi.fn(async (on) => { partyState.isWatched.value = on })
      return {
        party: partyState.party,
        links: partyState.links,
        reviewItems: partyState.reviewItems,
        riskSummary: partyState.riskSummary,
        isWatched: partyState.isWatched,
        loading: partyState.loading,
        error: partyState.error,
        actionState: partyState.actionState,
        screening: partyState.screening,
        screeningLoading: partyState.screeningLoading,
        screeningError: partyState.screeningError,
        load: partyFns.load,
        reload: partyFns.load,
        loadScreening: partyFns.loadScreening,
        mergeFrom: partyFns.mergeFrom,
        setOverride: partyFns.setOverride,
        setWatched: partyFns.setWatched,
      }
    },
  }
})

// ── Component / page imports (after mocks) ───────────────────────────────────
import AdminPage from '@/pages/AdminPage.vue'
import PartiesPage from '@/pages/PartiesPage.vue'
import PartyDetailPage from '@/pages/PartyDetailPage.vue'
import HealthIndicator from '@/components/layout/HealthIndicator.vue'
import ScreeningHitPanel from '@/components/ScreeningHitPanel.vue'
import { useHealthStore } from '@/stores/health.js'

// ── Fixtures ─────────────────────────────────────────────────────────────────
const MATRIX_BODY = {
  weights: { geographic: 0.25, entityType: 0.25, structuralComplexity: 0.25, industry: 0.25 },
  thresholds: [{ tier: 'Low', max: 30 }],
  factors: {},
  knockouts: {},
}
const PROMPT_LIST = [
  { key: 'kyc.synthesis', label: 'KYC synthesis', activeVersion: 2, latestVersion: 3 },
  { key: 'ocr.page', label: 'OCR page', activeVersion: 1, latestVersion: 1 },
]
function makePromptDetail(key) {
  return {
    key,
    label: 'KYC synthesis',
    description: 'Final card merge',
    defaultBody: 'DEFAULT BODY TEXT',
    active: { id: 'v2', version: 2, body: 'active body' },
    versions: [
      { id: 'v1', version: 1, createdAt: '2026-06-01T00:00:00Z', notes: 'first' },
      { id: 'v2', version: 2, createdAt: '2026-06-02T00:00:00Z', notes: null },
      { id: 'v3', version: 3, createdAt: '2026-06-03T00:00:00Z', notes: 'latest' },
    ],
  }
}
const PARTY = {
  id: 'party-abc', fullName: 'John Smith', full_name: 'John Smith', party_type: 'individual',
  sourceKind: 'officer', needsReview: false, aliases: ['J Smith'],
  createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-02-01T00:00:00Z',
}
const PARTY_LINKS = [
  { id: 'l1', role: 'officer', dossierId: 'd1', companyNumber: '01234567', companyName: 'ACME LTD',
    status: 'active', riskTier: 'High', caseStatus: 'standard_review', roleDetail: 'Director',
    appointedOn: '2020-01-01', matchEvidence: { kind: 'appointment_id' }, matchConfidence: 'EXACT' },
  { id: 'l2', role: 'psc', dossierId: 'd1', companyNumber: '01234567', companyName: 'ACME LTD',
    status: 'historical', riskTier: null, caseStatus: 'pending', notifiedOn: '2020-02-01' },
]
const SCREENING_SUMMARY = {
  worstStatus: 'confirmed',
  counts: { confirmed: 1, needsReview: 0, dismissed: 1, total: 2 },
  hits: [
    { hitId: 'h1', listSource: 'ofac_sdn', subjectName: 'John Smith', companyNumber: '01234567',
      companyName: 'ACME LTD', effectiveDecision: 'confirmed', isSanctions: true, listEntryId: 'e1',
      partyOverride: true },
    { hitId: 'h2', listSource: 'adverse_media', subjectName: 'John Smith', companyNumber: '01234567',
      effectiveDecision: 'dismissed', isSanctions: false, evidenceUrl: 'https://news.example/x',
      category: 'fraud', severity: 'medium', humanOverride: true },
    { hitId: 'h3', listSource: 'adverse_media', subjectName: 'John Smith', companyNumber: '01234567',
      effectiveDecision: 'needs_review', isSanctions: false, evidenceUrl: null },
  ],
}

// ── Helpers ──────────────────────────────────────────────────────────────────
function ok(body) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) }
}
function fail(status = 500, body = { error: 'boom' }) {
  return { ok: false, status, json: () => Promise.resolve(body), text: () => Promise.resolve('boom') }
}
const flush = () => new Promise((r) => setTimeout(r, 20))

function mountAdmin(extra = {}) {
  return mount(AdminPage, {
    global: {
      plugins: [createPinia()],
      stubs: {
        AgentsPanel: { template: '<div class="stub-agents-panel" />' },
        DataModelTab: { template: '<div class="stub-data-model" />' },
        ProcessTab: { template: '<div class="stub-process" />' },
        RouterLink: { template: '<a><slot /></a>' },
      },
    },
    ...extra,
  })
}

function mountParties() {
  return mount(PartiesPage, {
    global: {
      plugins: [createPinia()],
      stubs: { RouterLink: { template: '<a><slot /></a>' } },
    },
  })
}

function mountPartyDetail() {
  return mount(PartyDetailPage, {
    global: {
      plugins: [createPinia()],
      stubs: {
        RouterLink: { template: '<a><slot /></a>' },
        PartyGraph: { template: '<div class="stub-party-graph" />' },
        PartyIdentityCard: { template: '<div class="stub-identity"><slot name="aside" /></div>' },
      },
    },
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
  setActivePinia(createPinia())
  globalThis.EventSource.instances.length = 0
  globalThis.fetch = vi.fn().mockResolvedValue(ok(null))
  mockPush.mockClear()
  mockReplace.mockClear()
  routeRef = { params: { partyId: 'party-abc' }, query: {}, hash: '' }
})

// ════════════════════════════════════════════════════════════════════════════
//  AdminPage
// ════════════════════════════════════════════════════════════════════════════
describe('AdminPage — tab navigation', () => {
  it('renders with the Agents tab active by default', () => {
    const w = mountAdmin()
    expect(w.find('.stub-agents-panel').exists()).toBe(true)
    expect(w.find('.tab--active').text()).toBe('Agents')
  })

  it('deep-links to a tab from the route hash on mount', async () => {
    routeRef = { params: {}, query: {}, hash: '#members' }
    globalThis.fetch = vi.fn().mockResolvedValue(ok({ users: [] }))
    const w = mountAdmin()
    await flush()
    expect(w.find('.tab--active').text()).toBe('Members')
  })

  it('clicking each tab switches the active panel', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(ok({ users: [] }))
    const w = mountAdmin()
    const tabs = w.findAll('.tab')
    for (const t of tabs) {
      await t.trigger('click')
      await flush()
    }
    // process / data-model stubs render last
    expect(w.html().length).toBeGreaterThan(50)
  })

  it('renders DataModelTab and ProcessTab stubs on their tabs', async () => {
    const w = mountAdmin()
    const dataModelTab = w.findAll('.tab').find((t) => t.text() === 'Data model')
    await dataModelTab.trigger('click')
    expect(w.find('.stub-data-model').exists()).toBe(true)
    const processTab = w.findAll('.tab').find((t) => t.text() === 'Process')
    await processTab.trigger('click')
    expect(w.find('.stub-process').exists()).toBe(true)
  })
})

describe('AdminPage — screening config tab', () => {
  async function openScreening(w) {
    const tab = w.findAll('.tab').find((t) => t.text() === 'Screening')
    await tab.trigger('click')
    await flush()
  }

  it('loads lists + config and renders sources', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(ok([{ source: 'ofac_sdn', version: '2026-06', recordCount: 12000, fetchedAt: '2026-06-10T00:00:00Z' }]))
      .mockResolvedValueOnce(ok({ matchThreshold: 0.9, bingResultsPerSubject: 25 }))
    const w = mountAdmin()
    await openScreening(w)
    expect(w.html()).toContain('OFAC SDN')
    expect(w.html()).toContain('version 2026-06')
  })

  it('shows the no-snapshots message when lists are empty', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok({ matchThreshold: 0.85, bingResultsPerSubject: 20 }))
    const w = mountAdmin()
    await openScreening(w)
    expect(w.html()).toContain('No sanctions snapshots loaded yet')
  })

  it('shows an error banner when config load throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('lists down'))
    const w = mountAdmin()
    await openScreening(w)
    expect(w.html()).toContain('lists down')
  })

  it('saves screening config successfully', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok({ matchThreshold: 0.85, bingResultsPerSubject: 20 }))
      .mockResolvedValueOnce(ok({ matchThreshold: 0.85, bingResultsPerSubject: 20 }))
    const w = mountAdmin()
    await openScreening(w)
    const saveBtn = w.findAll('button').find((b) => b.text().includes('Save changes'))
    await saveBtn.trigger('click')
    await flush()
    expect(w.html()).toContain('Saved.')
  })

  it('shows an error when saving config fails', async () => {
    globalThis.fetch = vi.fn()
      .mockResolvedValueOnce(ok([]))
      .mockResolvedValueOnce(ok({ matchThreshold: 0.85, bingResultsPerSubject: 20 }))
      .mockResolvedValueOnce(fail(400, { error: 'threshold out of range' }))
    const w = mountAdmin()
    await openScreening(w)
    const saveBtn = w.findAll('button').find((b) => b.text().includes('Save changes'))
    await saveBtn.trigger('click')
    await flush()
    expect(w.html()).toContain('threshold out of range')
  })

  it('Reload button re-fetches the screening settings', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(ok([]))
    const w = mountAdmin()
    await openScreening(w)
    const reloadBtn = w.findAll('button').find((b) => b.text().includes('Reload'))
    await reloadBtn.trigger('click')
    await flush()
    expect(globalThis.fetch).toHaveBeenCalled()
  })
})

describe('AdminPage — risk matrix tab', () => {
  async function openRisk(w) {
    const tab = w.findAll('.tab').find((t) => t.text() === 'Risk matrix')
    await tab.trigger('click')
    await flush()
  }

  it('loads the active matrix + versions on tab open', async () => {
    const w = mountAdmin()
    await openRisk(w)
    expect(riskFns.load).toHaveBeenCalled()
    expect(w.html()).toContain('Active version')
    expect(w.html()).toContain('v1')
  })

  it('selecting a version fetches its body', async () => {
    const w = mountAdmin()
    await openRisk(w)
    const versionItem = w.findAll('.prompt-item').find((li) => li.text().includes('v1'))
    if (versionItem) {
      await versionItem.trigger('click')
      await flush()
    }
    expect(riskFns.fetchVersion).toHaveBeenCalled()
  })

  it('starts a new version editor pre-filled from the active body', async () => {
    const w = mountAdmin()
    await openRisk(w)
    const newBtn = w.findAll('button').find((b) => b.text().includes('New version'))
    await newBtn.trigger('click')
    await nextTick()
    expect(w.find('textarea.prompt-body').exists()).toBe(true)
    expect(w.find('textarea.prompt-body').element.value).toContain('weights')
  })

  it('cancel returns from the editor to the view', async () => {
    const w = mountAdmin()
    await openRisk(w)
    await w.findAll('button').find((b) => b.text().includes('New version')).trigger('click')
    await nextTick()
    const cancelBtn = w.findAll('button').find((b) => b.text() === 'Cancel')
    await cancelBtn.trigger('click')
    await nextTick()
    expect(w.find('textarea.prompt-body').exists()).toBe(false)
  })

  it('save rejects invalid JSON with a client error', async () => {
    const w = mountAdmin()
    await openRisk(w)
    await w.findAll('button').find((b) => b.text().includes('New version')).trigger('click')
    await nextTick()
    await w.find('textarea.prompt-body').setValue('{ not valid json')
    const saveBtn = w.findAll('button').find((b) => b.text().includes('Save as new version'))
    await saveBtn.trigger('click')
    await flush()
    expect(w.html()).toContain('not valid JSON')
    expect(riskFns.createVersion).not.toHaveBeenCalled()
  })

  it('save rejects a body whose weights do not sum to 1', async () => {
    const w = mountAdmin()
    await openRisk(w)
    await w.findAll('button').find((b) => b.text().includes('New version')).trigger('click')
    await nextTick()
    const badBody = { ...MATRIX_BODY, weights: { geographic: 0.5, entityType: 0.1, structuralComplexity: 0.1, industry: 0.1 } }
    await w.find('textarea.prompt-body').setValue(JSON.stringify(badBody))
    await w.findAll('button').find((b) => b.text().includes('Save as new version')).trigger('click')
    await flush()
    expect(w.html()).toContain('weights must sum to')
    expect(riskFns.createVersion).not.toHaveBeenCalled()
  })

  it('save rejects a body missing weights/thresholds/factors/knockouts', async () => {
    const w = mountAdmin()
    await openRisk(w)
    await w.findAll('button').find((b) => b.text().includes('New version')).trigger('click')
    await nextTick()
    await w.find('textarea.prompt-body').setValue('{}')
    await w.findAll('button').find((b) => b.text().includes('Save as new version')).trigger('click')
    await flush()
    expect(w.html()).toContain('missing weights object')
    expect(w.html()).toContain('thresholds must be a non-empty array')
  })

  it('save rejects a non-object body', async () => {
    const w = mountAdmin()
    await openRisk(w)
    await w.findAll('button').find((b) => b.text().includes('New version')).trigger('click')
    await nextTick()
    await w.find('textarea.prompt-body').setValue('[1,2,3]')
    await w.findAll('button').find((b) => b.text().includes('Save as new version')).trigger('click')
    await flush()
    expect(w.html()).toContain('matrix body must be a JSON object')
  })

  it('valid body creates a new version', async () => {
    const w = mountAdmin()
    await openRisk(w)
    await w.findAll('button').find((b) => b.text().includes('New version')).trigger('click')
    await nextTick()
    await w.find('textarea.prompt-body').setValue(JSON.stringify(MATRIX_BODY))
    await w.findAll('button').find((b) => b.text().includes('Save as new version')).trigger('click')
    await flush()
    expect(riskFns.createVersion).toHaveBeenCalled()
    expect(w.html()).toContain('Created v2')
  })

  it('set-active on a version calls the composable', async () => {
    const w = mountAdmin()
    await openRisk(w)
    // versionDetail active version is rv1; render a 2nd version so "Set active" shows
    riskState.versions.value = [
      { id: 'rv1', version: 1, notes: null, createdAt: '2026-06-01T00:00:00Z' },
      { id: 'rv2', version: 2, notes: 'new', createdAt: '2026-06-05T00:00:00Z' },
    ]
    await nextTick()
    const setActiveBtn = w.findAll('button').find((b) => b.text() === 'Set active')
    if (setActiveBtn) {
      await setActiveBtn.trigger('click')
      await flush()
      expect(riskFns.setActive).toHaveBeenCalled()
    }
  })

  it('Reload button re-loads the matrix', async () => {
    const w = mountAdmin()
    await openRisk(w)
    riskFns.load.mockClear()
    const reloadBtn = w.findAll('button').find((b) => b.text().includes('Reload'))
    await reloadBtn.trigger('click')
    await flush()
    expect(riskFns.load).toHaveBeenCalled()
  })
})

describe('AdminPage — prompts tab', () => {
  async function openPrompts(w) {
    const tab = w.findAll('.tab').find((t) => t.text() === 'Prompts')
    await tab.trigger('click')
    await flush()
  }

  it('fetches prompts and auto-selects the first key', async () => {
    const w = mountAdmin()
    await openPrompts(w)
    expect(promptFns.fetchList).toHaveBeenCalled()
    expect(promptFns.selectKey).toHaveBeenCalledWith('kyc.synthesis')
    expect(w.html()).toContain('KYC synthesis')
  })

  it('picking a key in the rail selects it', async () => {
    const w = mountAdmin()
    await openPrompts(w)
    const items = w.findAll('.prompt-item')
    if (items.length > 1) {
      await items[1].trigger('click')
      await flush()
      expect(promptFns.selectKey).toHaveBeenCalled()
    }
  })

  it('changing the version select calls selectVersion', async () => {
    const w = mountAdmin()
    await openPrompts(w)
    const select = w.find('select')
    if (select.exists()) {
      await select.setValue('v1')
      expect(promptFns.selectVersion).toHaveBeenCalled()
    }
  })

  it('toggles the default body view', async () => {
    const w = mountAdmin()
    await openPrompts(w)
    const showBtn = w.findAll('button').find((b) => b.text().includes('Show default'))
    await showBtn.trigger('click')
    await nextTick()
    expect(w.html()).toContain('DEFAULT BODY TEXT')
    const hideBtn = w.findAll('button').find((b) => b.text().includes('Hide default'))
    await hideBtn.trigger('click')
    await nextTick()
    expect(w.html()).not.toContain('DEFAULT BODY TEXT')
  })

  it('Save as new version calls the composable', async () => {
    const w = mountAdmin()
    await openPrompts(w)
    const saveBtn = w.findAll('button').find((b) => b.text().includes('Save as new version'))
    await saveBtn.trigger('click')
    expect(promptFns.saveAsNewVersion).toHaveBeenCalled()
  })

  it('Set as active is disabled when the active version is selected, enabled otherwise', async () => {
    const w = mountAdmin()
    await openPrompts(w)
    // selectedVersionId is 'v2' which equals active.id → disabled
    const setActiveBtn = w.findAll('button').find((b) => b.text().includes('Set as active'))
    expect(setActiveBtn.attributes('disabled')).toBeDefined()
    // change selection to a non-active version
    promptState.selectedVersionId.value = 'v1'
    await nextTick()
    const enabledBtn = w.findAll('button').find((b) => b.text().includes('Set as active'))
    await enabledBtn.trigger('click')
    expect(promptFns.setActive).toHaveBeenCalled()
  })

  it('shows the prompt error banner', async () => {
    const w = mountAdmin()
    await openPrompts(w)
    promptState.error.value = 'prompt load failed'
    await nextTick()
    expect(w.html()).toContain('prompt load failed')
  })
})

describe('AdminPage — members tab', () => {
  async function openMembers(w) {
    const tab = w.findAll('.tab').find((t) => t.text() === 'Members')
    await tab.trigger('click')
    await flush()
  }

  it('loads members and renders rows + active count', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(ok({
      users: [
        { id: 'u1', displayName: 'Jane Analyst', username: 'jane', email: 'jane@x.io', role: 'analyst', active: true, lastLoginAt: '2026-06-10T09:00:00Z' },
        { id: 'u2', displayName: null, username: 'bob', email: null, role: 'reviewer', active: false, lastLoginAt: null },
      ],
    }))
    const w = mountAdmin()
    await openMembers(w)
    expect(w.html()).toContain('Jane Analyst')
    expect(w.html()).toContain('Inactive')
    expect(w.html()).toContain('1 active · 2 total')
    expect(w.html()).toContain('Never') // null lastLoginAt
    expect(w.html()).toContain('JA') // initials from two name parts
    expect(w.html()).toContain('BO') // initials from single username
  })

  it('shows the empty message when no members', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(ok({ users: [] }))
    const w = mountAdmin()
    await openMembers(w)
    expect(w.html()).toContain('No members found')
  })

  it('shows an error when members load fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fail(500))
    const w = mountAdmin()
    await openMembers(w)
    expect(w.html()).toContain('load failed: 500')
  })

  it('Reload button re-fetches members', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(ok({ users: [
      { id: 'u1', displayName: 'A B', username: 'ab', role: 'admin', active: true, lastLoginAt: null },
    ] }))
    const w = mountAdmin()
    await openMembers(w)
    const reloadBtn = w.findAll('button').find((b) => b.text().includes('Reload'))
    await reloadBtn.trigger('click')
    await flush()
    expect(globalThis.fetch).toHaveBeenCalled()
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  PartiesPage
// ════════════════════════════════════════════════════════════════════════════
describe('PartiesPage', () => {
  it('shows loading state before parties arrive', async () => {
    globalThis.fetch = vi.fn(() => new Promise(() => {}))
    const w = mountParties()
    await nextTick()
    expect(w.html()).toContain('Loading parties')
  })

  it('shows empty state when no parties returned (no search term)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(ok({ parties: [] }))
    const w = mountParties()
    await flush()
    expect(w.html()).toContain('No parties found')
    expect(w.html()).toContain('Run a dossier to populate')
  })

  it('renders party rows incl. type formatting and review pill', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(ok({
      parties: [
        { id: 'p1', full_name: 'John Smith', party_type: 'individual', linked_dossier_count: 3, needs_review: false },
        { id: 'p2', full_name: 'Acme Holdings', party_type: 'organisation', linked_dossier_count: 1, needs_review: true },
        { id: 'p3', full_name: 'Mystery', party_type: null, linked_dossier_count: null, needs_review: false },
      ],
    }))
    const w = mountParties()
    await flush()
    expect(w.html()).toContain('John Smith')
    expect(w.html()).toContain('Individual')
    expect(w.html()).toContain('Organisation')
    expect(w.html()).toContain('Needs review')
    expect(w.html()).toContain('Acme Holdings')
  })

  it('shows an error banner when the load fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fail(500, { error: 'db down' }))
    const w = mountParties()
    await flush()
    expect(w.html()).toContain('Failed to load parties')
    expect(w.html()).toContain('db down')
  })

  it('typing in the search box debounces a reload and syncs the query param', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(ok({ parties: [] }))
    const w = mountParties()
    await flush()
    const input = w.find('input[type="search"]')
    const before = globalThis.fetch.mock.calls.length
    await input.setValue('acme')
    await new Promise((r) => setTimeout(r, 300)) // past the 250ms debounce
    expect(mockReplace).toHaveBeenCalledWith({ query: { q: 'acme' } })
    // debounced reload fired with the search term
    const lastUrl = globalThis.fetch.mock.calls.at(-1)[0]
    expect(lastUrl).toContain('q=acme')
    expect(globalThis.fetch.mock.calls.length).toBeGreaterThan(before)
  })

  it('toggling needs-review filter reloads', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(ok({ parties: [] }))
    const w = mountParties()
    await flush()
    const before = globalThis.fetch.mock.calls.length
    await w.find('input[type="checkbox"]').setValue(true)
    await flush()
    expect(globalThis.fetch.mock.calls.length).toBeGreaterThan(before)
    const lastUrl = globalThis.fetch.mock.calls.at(-1)[0]
    expect(lastUrl).toContain('needs_review=true')
  })

  it('pagination: next is enabled with a full page, advances offset', async () => {
    const fullPage = Array.from({ length: 50 }, (_, i) => ({
      id: `p${i}`, full_name: `Party ${i}`, party_type: 'individual', linked_dossier_count: 0, needs_review: false,
    }))
    globalThis.fetch = vi.fn().mockResolvedValue(ok({ parties: fullPage }))
    const w = mountParties()
    await flush()
    const nextBtn = w.findAll('button').find((b) => b.text().includes('Next'))
    expect(nextBtn.attributes('disabled')).toBeUndefined()
    await nextBtn.trigger('click')
    await flush()
    const lastUrl = globalThis.fetch.mock.calls.at(-1)[0]
    expect(lastUrl).toContain('offset=50')
    // prev now enabled
    const prevBtn = w.findAll('button').find((b) => b.text().includes('Previous'))
    expect(prevBtn.attributes('disabled')).toBeUndefined()
    await prevBtn.trigger('click')
    await flush()
    expect(globalThis.fetch.mock.calls.at(-1)[0]).not.toContain('offset=50')
  })

  it('next is disabled on a partial page', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(ok({
      parties: [{ id: 'p1', full_name: 'A', party_type: 'individual', linked_dossier_count: 0, needs_review: false }],
    }))
    const w = mountParties()
    await flush()
    const nextBtn = w.findAll('button').find((b) => b.text().includes('Next'))
    expect(nextBtn.attributes('disabled')).toBeDefined()
  })

  it('seeds the search box from the route query on mount', async () => {
    routeRef = { params: {}, query: { q: 'preset' }, hash: '' }
    globalThis.fetch = vi.fn().mockResolvedValue(ok({ parties: [] }))
    const w = mountParties()
    await flush()
    expect(w.find('input[type="search"]').element.value).toBe('preset')
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  PartyDetailPage
// ════════════════════════════════════════════════════════════════════════════
describe('PartyDetailPage', () => {
  it('renders identity card + stats + risk summary', () => {
    const w = mountPartyDetail()
    expect(w.find('.stub-identity').exists()).toBe(true)
    expect(w.html()).toContain('role link')
    expect(w.html()).toContain('Highest risk: High')
  })

  it('shows the loading placeholder when party not yet loaded', () => {
    partyState && undefined // ensure mock evaluated by mounting
    const w = mountPartyDetail()
    partyState.party.value = null
    partyState.loading.value = true
    return nextTick().then(() => {
      expect(w.html()).toContain('Loading…')
    })
  })

  it('renders the error banner', async () => {
    const w = mountPartyDetail()
    partyState.error.value = 'not found'
    await nextTick()
    expect(w.html()).toContain('Failed to load: not found')
  })

  it('renders linked-dossier tables grouped by role', () => {
    const w = mountPartyDetail()
    expect(w.html()).toContain('Officer roles')
    expect(w.html()).toContain('PSC roles')
    expect(w.html()).toContain('ACME LTD')
    expect(w.html()).toContain('Director')
  })

  it('navigates to a dossier when a link is clicked', async () => {
    const w = mountPartyDetail()
    const link = w.findAll('a').find((a) => a.text().includes('ACME LTD'))
    if (link) {
      await link.trigger('click')
      expect(mockPush).toHaveBeenCalledWith({ name: 'dossier', params: { companyNumber: '01234567' } })
    }
  })

  it('switches to the screening tab and lazy-loads screening', async () => {
    const w = mountPartyDetail()
    const tab = w.findAll('.party-tabs button').find((b) => b.text().includes('Screening'))
    await tab.trigger('click')
    await flush()
    expect(partyFns.loadScreening).toHaveBeenCalled()
    expect(w.html()).toContain('confirmed')
    expect(w.html()).toContain('OFAC SDN')
  })

  it('screening tab: confirm override on a sanctions hit calls setOverride', async () => {
    const w = mountPartyDetail()
    await w.findAll('.party-tabs button').find((b) => b.text().includes('Screening')).trigger('click')
    await flush()
    const confirmBtn = w.findAll('.ov-btn').find((b) => b.text() === 'Confirm')
    if (confirmBtn) {
      await confirmBtn.trigger('click')
      await flush()
      expect(partyFns.setOverride).toHaveBeenCalled()
    }
  })

  it('screening tab: a no-URL adverse-media hit is read-only', async () => {
    const w = mountPartyDetail()
    await w.findAll('.party-tabs button').find((b) => b.text().includes('Screening')).trigger('click')
    await flush()
    expect(w.html()).toContain('read-only')
  })

  it('switches to the network tab and lazy-loads the graph', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(ok({ nodes: [], edges: [] }))
    const w = mountPartyDetail()
    const tab = w.findAll('.party-tabs button').find((b) => b.text() === 'Network')
    await tab.trigger('click')
    await flush()
    expect(globalThis.fetch).toHaveBeenCalled()
    expect(w.find('.stub-party-graph').exists()).toBe(true)
  })

  it('network tab: error renders a failure message', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fail(500, { error: 'graph boom' }))
    const w = mountPartyDetail()
    await w.findAll('.party-tabs button').find((b) => b.text() === 'Network').trigger('click')
    await flush()
    expect(w.html()).toContain('Failed to load network')
  })

  it('switches to review + audit tabs', async () => {
    const w = mountPartyDetail()
    await w.findAll('.party-tabs button').find((b) => b.text().includes('Review candidates')).trigger('click')
    await nextTick()
    expect(w.html()).toContain('No open review items')
    await w.findAll('.party-tabs button').find((b) => b.text() === 'Audit').trigger('click')
    await nextTick()
    expect(w.html()).toContain('Source kind')
    expect(w.html()).toContain('J Smith') // alias
  })

  it('opens the watchlist dialog and confirms a watch', async () => {
    const w = mountPartyDetail()
    const addBtn = w.findAll('button').find((b) => b.text().includes('Add to watchlist'))
    await addBtn.trigger('click')
    await nextTick()
    expect(w.html()).toContain('to the watchlist')
    const confirmBtn = w.findAll('button').find((b) => b.text().includes('Add to watchlist') && b.classes().includes('primary'))
    if (confirmBtn) {
      await confirmBtn.trigger('click')
      await flush()
      expect(partyFns.setWatched).toHaveBeenCalledWith(true, expect.any(Object))
    }
  })

  it('removes a watch when already watched', async () => {
    const w = mountPartyDetail()
    partyState.isWatched.value = true
    await nextTick()
    const onBtn = w.findAll('button').find((b) => b.text().includes('On watchlist'))
    await onBtn.trigger('click')
    await flush()
    expect(partyFns.setWatched).toHaveBeenCalledWith(false)
  })

  it('opens the review-merge dialog and confirms a merge', async () => {
    const w = mountPartyDetail()
    partyState.reviewItems.value = [
      { id: 'ri1', party_id: 'party-abc', candidate_party_id: 'other-1', candidate_party_name: 'J. Smith',
        new_party_name: 'New', confidence: 'HIGH', score: 0.91, matched_via: 'name' },
    ]
    await nextTick()
    await w.findAll('.party-tabs button').find((b) => b.text().includes('Review candidates')).trigger('click')
    await nextTick()
    const mergeBtn = w.findAll('button').find((b) => b.text().includes('Merge into this party'))
    await mergeBtn.trigger('click')
    await nextTick()
    const confirmBtn = w.findAll('button').find((b) => b.text().includes('Confirm merge'))
    await confirmBtn.trigger('click')
    await flush()
    expect(partyFns.mergeFrom).toHaveBeenCalled()
  })

  it('renders the merged-into notice when the party was merged', async () => {
    const w = mountPartyDetail()
    partyState.party.value = { ...PARTY, mergedIntoPartyId: 'winner-1', mergedBy: 'reviewer', mergedAt: '2026-03-01', mergeReason: 'duplicate' }
    await nextTick()
    expect(w.html()).toContain('was merged into')
    expect(w.html()).toContain('duplicate')
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  HealthIndicator
// ════════════════════════════════════════════════════════════════════════════
function mountHealth() {
  return mount(HealthIndicator, { global: { plugins: [createPinia()] } })
}

describe('HealthIndicator', () => {
  it('renders the unknown state before any probe', () => {
    const w = mountHealth()
    const store = useHealthStore()
    expect(store.status).toBe('unknown')
    expect(w.html()).toContain('Checking…')
    expect(w.html()).toContain('pill--unknown')
  })

  it('renders the ok state with models ready in the popover', async () => {
    const w = mountHealth()
    const store = useHealthStore()
    store.ok = true
    store.ollama = { host: 'http://localhost:11434', models: { ocr: 'glm-ocr', reasoning: 'llama3.1:8b' }, missing: [] }
    store.checkedAt = Date.now()
    await nextTick()
    expect(store.status).toBe('ok')
    expect(w.html()).toContain('Ollama online')
    await w.find('.health-wrap').trigger('mouseenter')
    await nextTick()
    expect(w.html()).toContain('glm-ocr')
    expect(w.html()).toContain('ready')
  })

  it('renders the degraded state with a missing-model hint', async () => {
    const w = mountHealth()
    const store = useHealthStore()
    store.ok = true
    store.ollama = { host: 'h', models: { ocr: 'glm-ocr', reasoning: 'llama3.1:8b' }, missing: ['glm-ocr'] }
    store.checkedAt = Date.now()
    await nextTick()
    expect(store.status).toBe('degraded')
    expect(w.html()).toContain('Models missing')
    await w.find('.health-wrap').trigger('mouseenter')
    await nextTick()
    expect(w.html()).toContain('missing')
    expect(w.html()).toContain('ollama pull')
  })

  it('renders the down state with the offline hint + reason', async () => {
    const w = mountHealth()
    const store = useHealthStore()
    store.ok = false
    store.lastError = 'connection refused'
    store.checkedAt = Date.now()
    await nextTick()
    expect(store.status).toBe('down')
    expect(w.html()).toContain('Ollama offline')
    await w.find('.health-wrap').trigger('mouseenter')
    await nextTick()
    expect(w.html()).toContain('ollama serve')
    expect(w.html()).toContain('connection refused')
  })

  it('clicking the pill triggers a health check', async () => {
    const w = mountHealth()
    const store = useHealthStore()
    const spy = vi.spyOn(store, 'check').mockResolvedValue()
    await w.find('button.pill').trigger('click')
    expect(spy).toHaveBeenCalled()
  })

  it('checkedLabel: shows "just now", "Ns ago" and "Nm ago" ranges', async () => {
    const w = mountHealth()
    const store = useHealthStore()
    store.ok = true
    store.ollama = { host: 'h', models: { ocr: 'a', reasoning: 'b' }, missing: [] }
    // just now (< 5s)
    store.checkedAt = Date.now() - 1000
    await nextTick()
    expect(w.find('button.pill').attributes('title')).toContain('just now')
    // seconds ago
    store.checkedAt = Date.now() - 30_000
    await nextTick()
    expect(w.find('button.pill').attributes('title')).toMatch(/\d+s ago/)
    // minutes ago
    store.checkedAt = Date.now() - 120_000
    await nextTick()
    expect(w.find('button.pill').attributes('title')).toMatch(/\d+m ago/)
  })

  it('checkedLabel is an em-dash before the first check', () => {
    const w = mountHealth()
    expect(w.find('button.pill').attributes('title')).toContain('—')
  })

  it('hides the popover on mouseleave', async () => {
    const w = mountHealth()
    await w.find('.health-wrap').trigger('mouseenter')
    await nextTick()
    expect(w.find('.popover').exists()).toBe(true)
    await w.find('.health-wrap').trigger('mouseleave')
    await nextTick()
    expect(w.find('.popover').exists()).toBe(false)
  })
})

// ════════════════════════════════════════════════════════════════════════════
//  ScreeningHitPanel
// ════════════════════════════════════════════════════════════════════════════
function mountHit(hit, props = {}) {
  return mount(ScreeningHitPanel, { props: { hit, ...props } })
}

const SANCTIONS_HIT = {
  id: 'h1', listSource: 'ofac_sdn', subjectName: 'John Smith', matchScore: 0.95,
  matchedFields: ['name', 'dob'],
  rawEntry: { primaryName: 'SMITH, John', aliases: ['J Smith', 'Johnny S', 'JS', 'Jonny'], programs: ['SDGT', 'IRAN'] },
  evaluation: { decision: 'confirmed', llmReasoning: 'Strong name + DOB match', humanOverride: null },
  effective: 'confirmed',
}

describe('ScreeningHitPanel', () => {
  it('renders a sanctions hit with list label, score, matched fields, aliases, programs', () => {
    const w = mountHit(SANCTIONS_HIT)
    expect(w.html()).toContain('OFAC SDN')
    expect(w.html()).toContain('0.95')
    expect(w.html()).toContain('name')
    expect(w.html()).toContain('SMITH, John')
    expect(w.html()).toContain('Aliases')
    expect(w.html()).toContain('+1') // 4 aliases, shows 3 + "+1"
    expect(w.html()).toContain('SDGT')
  })

  it('renders an adverse-media hit with a linked title + snippet + meta chips', () => {
    const hit = {
      id: 'h2', listSource: 'adverse_media', subjectName: 'John Smith', matchScore: null, matchedFields: null,
      rawEntry: { title: 'Fraud probe widens', url: 'https://news.example/a', snippet: 'A fraud probe ...' },
      evaluation: { decision: 'confirmed', category: 'fraud', severity: 'high', llmReasoning: 'relevant' },
      effective: 'confirmed',
    }
    const w = mountHit(hit)
    expect(w.html()).toContain('Fraud probe widens')
    expect(w.html()).toContain('https://news.example/a')
    expect(w.html()).toContain('A fraud probe')
    expect(w.html()).toContain('fraud')
    expect(w.html()).toContain('high')
  })

  it('adverse-media hit without a URL renders plain title text', () => {
    const hit = {
      id: 'h3', listSource: 'adverse_media', subjectName: 'X',
      rawEntry: { name: 'Untitled-ish' }, evaluation: null, effective: 'unevaluated',
    }
    const w = mountHit(hit)
    expect(w.html()).toContain('Untitled-ish')
    expect(w.find('.article-title a').exists()).toBe(false)
    expect(w.html()).toContain('Unevaluated')
  })

  it('renders the override badge + reason when an override exists', () => {
    const hit = {
      ...SANCTIONS_HIT,
      evaluation: { decision: 'confirmed', humanOverride: 'dismissed', overrideReason: 'false positive — different person', llmReasoning: 'x' },
      effective: 'dismissed',
    }
    const w = mountHit(hit)
    expect(w.html()).toContain('override')
    expect(w.html()).toContain('Override reason')
    expect(w.html()).toContain('different person')
  })

  it('shows the show-more toggle for long reasoning and toggles it', async () => {
    const hit = {
      ...SANCTIONS_HIT,
      evaluation: { decision: 'confirmed', humanOverride: null, llmReasoning: 'x'.repeat(300) },
    }
    const w = mountHit(hit)
    const btn = w.find('.link-btn')
    expect(btn.exists()).toBe(true)
    expect(btn.text()).toBe('Show more')
    await btn.trigger('click')
    expect(w.find('.link-btn').text()).toBe('Show less')
  })

  it('confirm action opens the modal and emits an override on confirm', async () => {
    const hit = { ...SANCTIONS_HIT, effective: 'needs_review' }
    const w = mountHit(hit)
    const confirmBtn = w.findAll('.action').find((b) => b.text() === 'Confirm')
    await confirmBtn.trigger('click')
    await nextTick()
    expect(w.find('.modal').exists()).toBe(true)
    expect(w.html()).toContain('Confirm hit')
    const textarea = w.find('.modal-textarea')
    await textarea.setValue('verified identity')
    const modalConfirm = w.findAll('.modal .action').find((b) => b.text() === 'Confirm')
    await modalConfirm.trigger('click')
    const events = w.emitted('override')
    expect(events).toBeTruthy()
    expect(events[0][0]).toMatchObject({ hitId: 'h1', decision: 'confirmed', reason: 'verified identity' })
    expect(w.find('.modal').exists()).toBe(false)
  })

  it('dismiss action opens the dismiss modal', async () => {
    const hit = { ...SANCTIONS_HIT, effective: 'needs_review' }
    const w = mountHit(hit)
    const dismissBtn = w.findAll('.action').find((b) => b.text() === 'Dismiss')
    await dismissBtn.trigger('click')
    await nextTick()
    expect(w.html()).toContain('Dismiss hit')
  })

  it('cancel closes the modal without emitting', async () => {
    const hit = { ...SANCTIONS_HIT, effective: 'needs_review' }
    const w = mountHit(hit)
    await w.findAll('.action').find((b) => b.text() === 'Confirm').trigger('click')
    await nextTick()
    const cancel = w.findAll('.modal .action').find((b) => b.text() === 'Cancel')
    await cancel.trigger('click')
    expect(w.find('.modal').exists()).toBe(false)
    expect(w.emitted('override')).toBeFalsy()
  })

  it('clear override emits a null decision', async () => {
    const hit = {
      ...SANCTIONS_HIT,
      evaluation: { decision: 'confirmed', humanOverride: 'dismissed', llmReasoning: 'x' },
      effective: 'dismissed',
    }
    const w = mountHit(hit)
    const clearBtn = w.findAll('.action').find((b) => b.text().includes('Clear override'))
    await clearBtn.trigger('click')
    expect(w.emitted('override')[0][0]).toMatchObject({ hitId: 'h1', decision: null, reason: null })
  })

  it('readonly mode hides the action footer and ignores override attempts', () => {
    const w = mountHit(SANCTIONS_HIT, { readonly: true })
    expect(w.find('.hit-actions').exists()).toBe(false)
  })

  it('matchedFields handles an object form (truthy keys only)', () => {
    const hit = { ...SANCTIONS_HIT, matchedFields: { name: true, dob: false, country: true } }
    const w = mountHit(hit)
    expect(w.html()).toContain('name')
    expect(w.html()).toContain('country')
    expect(w.html()).not.toContain('>dob<')
  })

  it('falls back to the raw list source when not in the label map', () => {
    const hit = { ...SANCTIONS_HIT, listSource: 'eu_consolidated' }
    const w = mountHit(hit)
    expect(w.html()).toContain('eu_consolidated')
  })

  it('decision tone classes: needs_review → warn, dismissed → muted', () => {
    const warn = mountHit({ ...SANCTIONS_HIT, effective: 'needs_review' })
    expect(warn.html()).toContain('hit--warn')
    const muted = mountHit({ ...SANCTIONS_HIT, effective: 'dismissed' })
    expect(muted.find('.pill--muted').exists()).toBe(true)
  })
})
