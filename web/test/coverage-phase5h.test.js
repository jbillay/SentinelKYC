// Phase 5h — FINAL branch + function cleanup toward web 80/75/80/80.
//
// Targets (per-file branch/fn stragglers after 5f/5g):
//   - PartyGraph.vue        (~42% br / 50% fn): cytoscape render lifecycle, tap
//     handlers (dossier nav / party nav / centre node / unknown kind / no data),
//     watch-driven re-render (destroy+rebuild), onBeforeUnmount, empty vs
//     populated graph, truncation banner.
//   - DataModelTab.vue      (~66% br / 48% fn): describeType variants, isExpandable
//     / childFields branches, fragmentGroups ordering, fmtDate, toggleSample,
//     copy success + clipboard-throw, section collapse toggles, persisted FK rows.
//   - AgentsPanel.vue       (~44% fn): coerce (number/boolean/multiselect/text),
//     isDirty, toggleMulti add+remove, onToggle, onSave (ok + fail), onReset,
//     canEdit true + false rendering.
//   - useParty / usePrompts / usePartyReviewQueue composables: error + catch +
//     guard branches not yet hit by composables-fetch.test.js.
//   - useRun.js: store-backed accessors + pick/cancel/remove + ensureAttached.
//
// Conventions copied from coverage-phase5g / coverage-phase5d: hoisted vi.mock
// for cytoscape + vue-router, vi.restoreAllMocks + setActivePinia in beforeEach,
// setTimeout flush helper.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mount } from '@vue/test-utils'
import { setActivePinia, createPinia, getActivePinia } from 'pinia'
import { nextTick, ref } from 'vue'

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
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mockPush }),
  useRoute: () => ({ params: {}, query: {}, hash: '', name: 'x' }),
  RouterLink: { template: '<a><slot /></a>' },
  RouterView: { template: '<div />' },
}))

import PartyGraph from '@/components/PartyGraph.vue'
import DataModelTab from '@/components/DataModelTab.vue'
import AgentsPanel from '@/components/AgentsPanel.vue'
import RiskAssessmentCard from '@/components/RiskAssessmentCard.vue'
import ScreeningEvidenceCard from '@/components/ScreeningEvidenceCard.vue'
import LiveEvidenceCard from '@/components/LiveEvidenceCard.vue'
import WatchlistPage from '@/pages/WatchlistPage.vue'
import SearchPage from '@/pages/SearchPage.vue'
import { useParty } from '@/composables/useParty.js'
import { usePrompts } from '@/composables/usePrompts.js'
import { usePartyReviewQueue } from '@/composables/usePartyReviewQueue.js'
import { useRun } from '@/composables/useRun.js'
import { useAgentStore } from '@/stores/agent.js'
import { useAuthStore } from '@/stores/auth.js'

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
const flush = (ms = 25) => new Promise((r) => setTimeout(r, ms))

function mountC(component, props = {}, options = {}) {
  return mount(component, {
    props,
    global: { plugins: [getPinia()], ...(options.global || {}) },
    attachTo: document.body,
    ...options,
  })
}

beforeEach(() => {
  vi.restoreAllMocks()
  setActivePinia(createPinia())
  globalThis.fetch = vi.fn().mockResolvedValue(ok(null))
  mockPush.mockClear()
})

// ─── PartyGraph ────────────────────────────────────────────────────────────────

async function getCy() {
  const cytoscape = (await import('cytoscape')).default
  return cytoscape.mock.results.at(-1)?.value
}
async function getNodeTap() {
  const cy = await getCy()
  if (!cy) return null
  return cy.on.mock.calls.findLast(([evt, sel]) => evt === 'tap' && sel === 'node')?.[2]
}

const POP_GRAPH = {
  nodes: [
    { data: { id: 'p:center', label: 'John Smith', kind: 'individual', partyId: 'p1', isCenter: true } },
    { data: { id: 'p:other', label: 'Jane Doe', kind: 'individual', partyId: 'p2' } },
    { data: { id: 'org:x', label: 'ACME LTD', kind: 'organisation', partyId: 'p3' } },
    { data: { id: 'dossier:1', label: '01234567', kind: 'dossier', companyNumber: '01234567' } },
  ],
  edges: [{ data: { id: 'e1', source: 'p:center', target: 'dossier:1', role: 'officer', status: 'active' } }],
  counts: { truncated: true },
  limit: 50,
}

describe('PartyGraph', () => {
  it('renders the empty state when there are no nodes', () => {
    const w = mountC(PartyGraph, { graph: { nodes: [], edges: [], counts: {} } })
    expect(w.html()).toContain('No network')
    expect(w.html()).toContain("isn't linked to any dossier yet")
  })

  it('renders the canvas + truncation banner when nodes are present', async () => {
    const w = mountC(PartyGraph, { graph: POP_GRAPH })
    await nextTick()
    expect(w.find('.canvas').exists()).toBe(true)
    expect(w.html()).toContain('Truncated at 50 nodes')
    // cytoscape was constructed
    const cy = await getCy()
    expect(cy).toBeTruthy()
  })

  it('tap on a dossier node navigates to the dossier', async () => {
    const w = mountC(PartyGraph, { graph: POP_GRAPH })
    await nextTick()
    const nodeTap = await getNodeTap()
    expect(nodeTap).toBeTypeOf('function')
    nodeTap({ target: { data: () => ({ kind: 'dossier', companyNumber: '01234567' }) } })
    expect(mockPush).toHaveBeenCalledWith({ name: 'dossier', params: { companyNumber: '01234567' } })
    w.unmount()
  })

  it('tap on a non-centre individual node navigates to party detail', async () => {
    const w = mountC(PartyGraph, { graph: POP_GRAPH })
    await nextTick()
    const nodeTap = await getNodeTap()
    nodeTap({ target: { data: () => ({ kind: 'individual', partyId: 'p2', isCenter: false }) } })
    expect(mockPush).toHaveBeenCalledWith({ name: 'party-detail', params: { partyId: 'p2' } })
  })

  it('tap on an organisation node navigates to party detail', async () => {
    const w = mountC(PartyGraph, { graph: POP_GRAPH })
    await nextTick()
    const nodeTap = await getNodeTap()
    nodeTap({ target: { data: () => ({ kind: 'organisation', partyId: 'p3', isCenter: false }) } })
    expect(mockPush).toHaveBeenCalledWith({ name: 'party-detail', params: { partyId: 'p3' } })
  })

  it('tap on the centre node does NOT navigate', async () => {
    const w = mountC(PartyGraph, { graph: POP_GRAPH })
    await nextTick()
    const nodeTap = await getNodeTap()
    nodeTap({ target: { data: () => ({ kind: 'individual', partyId: 'p1', isCenter: true }) } })
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('tap on a node with no data is a no-op', async () => {
    const w = mountC(PartyGraph, { graph: POP_GRAPH })
    await nextTick()
    const nodeTap = await getNodeTap()
    nodeTap({ target: { data: () => null } })
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('tap on a dossier node without a companyNumber does not navigate', async () => {
    const w = mountC(PartyGraph, { graph: POP_GRAPH })
    await nextTick()
    const nodeTap = await getNodeTap()
    nodeTap({ target: { data: () => ({ kind: 'dossier' }) } })
    expect(mockPush).not.toHaveBeenCalled()
  })

  it('re-renders (destroy + rebuild) when the graph prop changes', async () => {
    const w = mountC(PartyGraph, { graph: POP_GRAPH })
    await nextTick()
    const cy = await getCy()
    await w.setProps({ graph: { ...POP_GRAPH, nodes: [...POP_GRAPH.nodes] } })
    await nextTick()
    // the previous instance was destroyed before the new render
    expect(cy.destroy).toHaveBeenCalled()
  })

  it('destroys cytoscape on unmount', async () => {
    const w = mountC(PartyGraph, { graph: POP_GRAPH })
    await nextTick()
    const cy = await getCy()
    cy.destroy.mockClear()
    w.unmount()
    expect(cy.destroy).toHaveBeenCalled()
  })

  it('render bails out cleanly when nodes/edges arrays are absent', async () => {
    // hasGraph is false → the canvas is not rendered, so container is null and
    // render() returns early without constructing cytoscape.
    const w = mountC(PartyGraph, { graph: { counts: {} } })
    await nextTick()
    expect(w.find('.empty').exists()).toBe(true)
  })
})

// ─── DataModelTab ────────────────────────────────────────────────────────────────

const DM_DATA = {
  state: {
    fields: [
      { name: 'companyNumber', schema: { type: 'string' }, producedBy: null },
      { name: 'profile', schema: { anyOf: [{ type: 'object' }, { type: 'null' }] }, producedBy: 'fetchApis' },
      { name: 'officers', schema: { $ref: '#/definitions/Officers' }, producedBy: 'fetchApis' },
      { name: 'status', schema: { enum: ['active', 'dissolved'] }, producedBy: null },
      {
        name: 'kycCard',
        producedBy: 'synthesizeCard',
        schema: {
          type: 'object',
          properties: {
            identity: {
              type: 'object',
              properties: { name: { type: 'string' }, number: { type: 'string' } },
            },
            redFlags: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      {
        name: 'parties',
        schema: { type: 'array', items: { type: 'object', properties: { id: { type: 'string' } } } },
        producedBy: 'resolveParties',
      },
      { name: 'kinds', schema: { type: ['string', 'null'] }, producedBy: null },
      { name: 'either', schema: { oneOf: [{ type: 'string' }, { type: 'number' }] }, producedBy: null },
    ],
    jsonSchema: { type: 'object', properties: {} },
  },
  fragmentsByNode: [
    {
      nodeId: 'qa_check',
      classification: 'decision',
      occurrences: 3,
      lastSeenAt: '2026-01-01T00:00:00Z',
      observedInputKeys: ['riskAssessment'],
      observedOutputKeys: ['qaResult'],
      sample: { fragmentId: 'frag-1', summary: 'QA ran', inputs: { a: 1 }, outputs: { b: 2 } },
    },
    {
      nodeId: 'gather_input',
      classification: 'audit',
      occurrences: 1,
      lastSeenAt: null,
      observedInputKeys: [],
      observedOutputKeys: [],
      sample: { fragmentId: 'frag-2', summary: 'Gathered', inputs: {}, outputs: {} },
    },
    {
      nodeId: 'human_decision',
      classification: 'human_action',
      occurrences: 2,
      lastSeenAt: '2026-01-02T00:00:00Z',
      observedInputKeys: ['decision'],
      observedOutputKeys: ['caseStatus'],
      sample: { fragmentId: 'frag-3', summary: 'Decided', inputs: {}, outputs: {} },
    },
  ],
  persisted: [
    {
      label: 'Core',
      tables: [
        {
          tableName: 'dossiers',
          foreignKeys: [
            { name: 'fk1', columns: ['run_id'], foreignTable: 'runs', foreignColumns: ['id'] },
            { name: 'fk2', columns: ['user_id'], foreignTable: 'users', foreignColumns: ['id'] },
          ],
          columns: [
            { name: 'id', type: 'uuid', primary: true, notNull: true, producedBy: null },
            { name: 'company_number', type: 'text', primary: false, notNull: true, producedBy: 'gatherInput' },
            { name: 'notes', type: 'text', primary: false, notNull: false, producedBy: null },
          ],
        },
      ],
    },
  ],
}

function mountDataModel(body = DM_DATA) {
  globalThis.fetch = vi.fn().mockResolvedValue(ok(body))
  return mountC(DataModelTab)
}

describe('DataModelTab', () => {
  it('renders all three sections and field rows after load', async () => {
    const w = mountDataModel()
    await flush()
    const html = w.html()
    expect(html).toContain('State schema')
    expect(html).toContain('Fragments per node')
    expect(html).toContain('Persisted entity')
    // describeType variants: $ref, anyOf, enum, array<object>, union types
    expect(html).toContain('Officers') // $ref stripped
    expect(html).toContain('object | null') // anyOf
    expect(html).toContain('enum(active | dissolved)')
    expect(html).toContain('array&lt;object&gt;') || expect(html).toContain('array<object>')
    expect(html).toContain('string | number') // oneOf
  })

  it('renders fragment groups in classification order with the right pills', async () => {
    const w = mountDataModel()
    await flush()
    const html = w.html()
    expect(html).toContain('dm-class-pill--decision')
    expect(html).toContain('dm-class-pill--audit')
    expect(html).toContain('dm-class-pill--human_action')
    expect(html).toContain('qa_check')
    expect(html).toContain('human_decision')
  })

  it('toggles a fragment sample open and closed (toggleSample + fmtDate)', async () => {
    const w = mountDataModel()
    await flush()
    const viewBtn = w.findAll('button').find((b) => b.text().includes('View sample'))
    expect(viewBtn).toBeTruthy()
    await viewBtn.trigger('click')
    expect(w.html()).toContain('Sample fragment')
    expect(w.html()).toContain('frag-1')
    // fmtDate '—' branch for the null lastSeenAt row
    expect(w.html()).toContain('—')
    const hideBtn = w.findAll('button').find((b) => b.text().includes('Hide sample'))
    await hideBtn.trigger('click')
    expect(w.html()).not.toContain('Sample fragment')
  })

  it('renders persisted tables with FK rows + constraint pills + producedBy', async () => {
    const w = mountDataModel()
    await flush()
    const html = w.html()
    expect(html).toContain('dossiers')
    expect(html).toContain('2 FKs') // plural branch
    expect(html).toContain('runs(id)')
    expect(html).toContain('PK')
    expect(html).toContain('NOT NULL')
    expect(html).toContain('gatherInput')
  })

  it('copy buttons write JSON to the clipboard and flip the label', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.assign(navigator, { clipboard: { writeText } })
    const w = mountDataModel()
    await flush()
    const copyBtn = w.findAll('button').find((b) => b.text().includes('Copy as JSON'))
    await copyBtn.trigger('click')
    await flush()
    expect(writeText).toHaveBeenCalled()
    expect(w.html()).toContain('Copied')
  })

  it('copy swallows clipboard errors without crashing', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    Object.assign(navigator, { clipboard: { writeText } })
    const w = mountDataModel()
    await flush()
    const copyBtn = w.findAll('button').find((b) => b.text().includes('Copy as JSON'))
    await copyBtn.trigger('click')
    await flush()
    expect(w.html()).toContain('Copy as JSON') // label unchanged
  })

  it('collapses each section on header click', async () => {
    const w = mountDataModel()
    await flush()
    const toggles = w.findAll('.dm-section-toggle')
    expect(toggles.length).toBe(3)
    for (const t of toggles) await t.trigger('click')
    // collapsed → bodies hidden; no field rows visible
    expect(w.findAll('.dm-tree').length).toBe(0)
  })

  it('shows the no-fragments message when fragmentsByNode is empty', async () => {
    const w = mountDataModel({ ...DM_DATA, fragmentsByNode: [] })
    await flush()
    expect(w.html()).toContain('No fragments captured yet')
  })

  it('shows the error banner when the fetch fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fail(503))
    const w = mountC(DataModelTab)
    await flush()
    expect(w.html()).toContain('HTTP 503')
  })
})

// ─── AgentsPanel ─────────────────────────────────────────────────────────────────

const AGENTS = [
  {
    id: 'entity-resolution',
    name: 'Entity resolution',
    description: 'Resolves the entity.',
    required: true,
    enabled: true,
    activeVersion: 3,
    config: { autoMatchThreshold: 0.85, leadCount: 3 },
    fields: [
      { key: 'autoMatchThreshold', label: 'Threshold', type: 'number', min: 0, max: 1, step: 0.05, description: 'Min score' },
      { key: 'leadCount', label: 'Lead count', type: 'number', min: 1, max: 10 },
    ],
  },
  {
    id: 'document-manager',
    name: 'Document manager',
    description: 'Manages documents.',
    required: false,
    enabled: true,
    activeVersion: 1,
    config: { pageCapEnabled: true },
    fields: [{ key: 'pageCapEnabled', label: 'Page cap', type: 'boolean' }],
  },
  {
    id: 'screening',
    name: 'Screening',
    description: 'Screens subjects.',
    required: false,
    enabled: true,
    activeVersion: 2,
    config: { pageSelection: 'relevance', label: 'hello' },
    fields: [
      { key: 'pageSelection', label: 'Page selection', type: 'select', options: ['relevance', 'first'] },
      { key: 'label', label: 'Label', type: 'text' },
    ],
  },
  {
    id: 'ubo-structure',
    name: 'UBO structure',
    description: 'Resolves UBO.',
    required: false,
    enabled: false,
    activeVersion: 1,
    config: { enrichmentVendors: ['mock'] },
    fields: [{ key: 'enrichmentVendors', label: 'Vendors', type: 'multiselect', options: ['mock', 'orbis'] }],
  },
]

function seedAuth(role = 'admin') {
  const auth = useAuthStore()
  auth.user = { userId: '1', username: 'admin', displayName: 'Admin', role, active: true }
  return auth
}

// Fresh deep clone each time — the composable assigns `agents.value = res.json()`
// by reference, so a shared array would leak mutations across tests.
const cloneAgents = () => JSON.parse(JSON.stringify(AGENTS))

describe('AgentsPanel', () => {
  function mountPanel(role = 'admin', agents = cloneAgents()) {
    globalThis.fetch = vi.fn().mockResolvedValue(ok(agents))
    seedAuth(role)
    return mountC(AgentsPanel)
  }

  it('renders all field types for an admin (number / boolean / select / multiselect / text)', async () => {
    const w = mountPanel('admin')
    await flush()
    expect(w.findAll('input[type="number"]').length).toBeGreaterThanOrEqual(2)
    expect(w.findAll('select').length).toBeGreaterThanOrEqual(1)
    expect(w.findAll('input[type="text"]').length).toBeGreaterThanOrEqual(1)
    // multiselect checkboxes for the two vendor options
    expect(w.html()).toContain('mock')
    expect(w.html()).toContain('orbis')
  })

  it('editing a number field marks the card dirty and enables Save', async () => {
    const w = mountPanel('admin')
    await flush()
    const numInput = w.find('input[type="number"]')
    await numInput.setValue('0.9')
    await nextTick()
    const saveBtn = w.findAll('button').find((b) => /Save changes/.test(b.text()))
    expect(saveBtn).toBeTruthy()
    expect(saveBtn.attributes('disabled')).toBeUndefined()
  })

  it('Save POSTs the coerced config and re-seeds on success', async () => {
    seedAuth('admin')
    const updated = { ...AGENTS[0], config: { autoMatchThreshold: 0.9, leadCount: 3 }, activeVersion: 4 }
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(ok(cloneAgents())) // fetchAgents
      .mockResolvedValueOnce(ok({ agent: updated })) // saveConfig
    const w = mountC(AgentsPanel)
    await flush()
    await w.find('input[type="number"]').setValue('0.9')
    await nextTick()
    const saveBtn = w.findAll('button').find((b) => /Save changes/.test(b.text()))
    await saveBtn.trigger('click')
    await flush()
    const postCall = globalThis.fetch.mock.calls.find((c) => String(c[0]).includes('/config'))
    expect(postCall).toBeTruthy()
    expect(JSON.parse(postCall[1].body).body.autoMatchThreshold).toBe(0.9)
  })

  it('Save failure surfaces the error and leaves the draft', async () => {
    seedAuth('admin')
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(ok(cloneAgents())) // fetchAgents
      .mockResolvedValueOnce(fail(400, { error: 'invalid_config', validationErrors: ['too low'] }))
    const w = mountC(AgentsPanel)
    await flush()
    await w.find('input[type="number"]').setValue('0.9')
    await nextTick()
    const saveBtn = w.findAll('button').find((b) => /Save changes/.test(b.text()))
    await saveBtn.trigger('click')
    await flush()
    expect(w.html()).toContain('invalid_config')
  })

  it('Reset restores the draft and disables the buttons again', async () => {
    const w = mountPanel('admin')
    await flush()
    const numInput = w.find('input[type="number"]')
    await numInput.setValue('0.99')
    await nextTick()
    const resetBtn = w.findAll('button').find((b) => b.text() === 'Reset')
    expect(resetBtn.attributes('disabled')).toBeUndefined()
    await resetBtn.trigger('click')
    await nextTick()
    // after reset the field value is back to the original
    expect(w.find('input[type="number"]').element.value).toBe('0.85')
  })

  it('toggling a multiselect option adds then removes it from the draft', async () => {
    const w = mountPanel('admin')
    await flush()
    // find the 'orbis' checkbox (not currently selected)
    const multiInputs = w.findAll('.multiselect-opt input[type="checkbox"]')
    expect(multiInputs.length).toBe(2)
    // toggle the second option on
    await multiInputs[1].setValue(true)
    await nextTick()
    // toggle it back off
    await multiInputs[1].setValue(false)
    await nextTick()
    expect(w.html().length).toBeGreaterThan(50)
  })

  it('flipping a boolean field checkbox updates the draft', async () => {
    const w = mountPanel('admin')
    await flush()
    // the document-manager pageCapEnabled boolean field (a field-level checkbox)
    const fieldCheckbox = w
      .findAll('.field input[type="checkbox"]')
      .find((c) => !c.element.closest('.multiselect'))
    expect(fieldCheckbox).toBeTruthy()
    await fieldCheckbox.setValue(false)
    await nextTick()
    expect(w.html().length).toBeGreaterThan(50)
  })

  it('toggling an agent enable switch calls setEnabled and re-seeds', async () => {
    seedAuth('admin')
    const toggled = { ...AGENTS[1], enabled: false }
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(ok(cloneAgents())) // fetchAgents
      .mockResolvedValueOnce(ok({ agent: toggled })) // setEnabled
    const w = mountC(AgentsPanel)
    await flush()
    // the document-manager toggle (not required, so enabled)
    const toggle = w
      .findAll('.agent-switch input[type="checkbox"]')
      .find((c) => c.attributes('disabled') === undefined)
    expect(toggle).toBeTruthy()
    await toggle.setValue(false)
    await flush()
    const enabledCall = globalThis.fetch.mock.calls.find((c) => String(c[0]).includes('/enabled'))
    expect(enabledCall).toBeTruthy()
  })

  it('non-admin users see read-only fields and the read-only notice', async () => {
    const w = mountPanel('analyst')
    await flush()
    expect(w.html()).toContain('editing requires the admin role')
    // form-actions (Save/Reset) are gated behind canEdit
    expect(w.findAll('.form-actions').length).toBe(0)
    // inputs are disabled
    expect(w.find('input[type="number"]').attributes('disabled')).toBeDefined()
  })
})

// ─── useParty (error / catch / guard branches) ──────────────────────────────────

describe('useParty branches', () => {
  it('load surfaces a server error (non-ok)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fail(403, { error: 'forbidden' }))
    const { error, load } = useParty('p1')
    await load()
    expect(error.value).toBe('forbidden')
  })

  it('load surfaces a fetch throw via the catch path', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network down'))
    const { error, load } = useParty('p1')
    await load()
    expect(error.value).toBe('network down')
  })

  it('loadScreening returns early with no partyId', async () => {
    globalThis.fetch = vi.fn()
    const { loadScreening, screening } = useParty(null)
    await loadScreening()
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(screening.value).toBeNull()
  })

  it('loadScreening sets screeningError on non-ok and clears screening', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fail(500, { error: 'boom' }))
    const { loadScreening, screeningError, screening } = useParty('p1')
    screening.value = { stale: true }
    await loadScreening()
    expect(screeningError.value).toBe('boom')
    expect(screening.value).toBeNull()
  })

  it('loadScreening catches a fetch throw', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('offline'))
    const { loadScreening, screeningError } = useParty('p1')
    await loadScreening()
    expect(screeningError.value).toBe('offline')
  })

  it('setWatched throws when partyId is missing', async () => {
    const { setWatched } = useParty(null)
    await expect(setWatched(true)).rejects.toThrow(/partyId required/)
  })

  it('setWatched surfaces a non-ok error and rethrows', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fail(409, { error: 'conflict' }))
    const { setWatched, actionState } = useParty('p1')
    await expect(setWatched(true, { reason: 'x' })).rejects.toThrow(/conflict/)
    expect(actionState.value.error).toBe('conflict')
  })

  it('mergeFrom throws when loserId is missing', async () => {
    const { mergeFrom } = useParty('p1')
    await expect(mergeFrom(null)).rejects.toThrow(/partyId \+ loserId required/)
  })

  it('mergeFrom surfaces a non-ok error (message wins over error)', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fail(400, { message: 'cannot merge', error: 'bad' }))
    const { mergeFrom, actionState } = useParty('p1')
    await expect(mergeFrom('p2')).rejects.toThrow(/cannot merge/)
    expect(actionState.value.error).toBe('cannot merge')
  })

  it('setOverride throws when partyId is missing', async () => {
    const { setOverride } = useParty(null)
    await expect(setOverride({ decision: null })).rejects.toThrow(/partyId required/)
  })

  it('setOverride surfaces a non-ok error and rethrows', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fail(500, { error: 'write failed' }))
    const { setOverride, actionState } = useParty('p1')
    await expect(setOverride({ listSource: 'ofac_sdn', decision: 'confirmed' })).rejects.toThrow(/write failed/)
    expect(actionState.value.error).toBe('write failed')
  })
})

// ─── usePrompts (error / early-return branches) ─────────────────────────────────

describe('usePrompts branches', () => {
  it('fetchList sets error on non-ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fail(500))
    const { fetchList, error } = usePrompts()
    await fetchList()
    expect(error.value).toContain('prompts list failed')
  })

  it('selectKey sets error on non-ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fail(404))
    const { selectKey, error } = usePrompts()
    await selectKey('kyc.synthesis')
    expect(error.value).toContain('prompt detail failed')
  })

  it('selectKey falls back to defaultBody + versions[0] when no active version', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      ok({ key: 'kyc.synthesis', versions: [{ id: 'vA' }], defaultBody: 'DEFAULT' }),
    )
    const { selectKey, editorBody, selectedVersionId } = usePrompts()
    await selectKey('kyc.synthesis')
    expect(editorBody.value).toBe('DEFAULT')
    expect(selectedVersionId.value).toBe('vA')
  })

  it('selectVersion returns early when detail is null', async () => {
    globalThis.fetch = vi.fn()
    const { selectVersion } = usePrompts()
    await selectVersion('v2')
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('selectVersion sets error on non-ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fail(500))
    const { selectVersion, detail, error } = usePrompts()
    detail.value = { key: 'kyc.synthesis' }
    await selectVersion('vBad')
    expect(error.value).toContain('version load failed')
  })

  it('saveAsNewVersion returns early when detail is null', async () => {
    globalThis.fetch = vi.fn()
    const { saveAsNewVersion } = usePrompts()
    await saveAsNewVersion()
    expect(globalThis.fetch).not.toHaveBeenCalled()
  })

  it('saveAsNewVersion surfaces the server error on non-ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fail(400, { error: 'body too short' }))
    const { saveAsNewVersion, detail, editorBody, error } = usePrompts()
    detail.value = { key: 'kyc.synthesis' }
    editorBody.value = 'x'
    await saveAsNewVersion()
    expect(error.value).toBe('body too short')
  })

  it('setActive POSTs then re-fetches on success', async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(ok({ ok: true })) // POST active
      .mockResolvedValueOnce(ok({ key: 'kyc.synthesis', active: { id: 'v1', body: 'b' }, versions: [{ id: 'v1' }] })) // selectKey
      .mockResolvedValueOnce(ok([{ key: 'kyc.synthesis' }])) // fetchList
    const { setActive, detail, selectedVersionId } = usePrompts()
    detail.value = { key: 'kyc.synthesis' }
    selectedVersionId.value = 'v1'
    await setActive()
    expect(globalThis.fetch.mock.calls.length).toBe(3)
  })

  it('setActive surfaces the server error on non-ok', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fail(409, { error: 'already active' }))
    const { setActive, detail, selectedVersionId, error } = usePrompts()
    detail.value = { key: 'kyc.synthesis' }
    selectedVersionId.value = 'v1'
    await setActive()
    expect(error.value).toBe('already active')
  })
})

// ─── usePartyReviewQueue (catch + error-shape branches) ─────────────────────────

describe('usePartyReviewQueue branches', () => {
  it('load catches a fetch throw and clears items', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('LISTEN failed'))
    const { load, items, error } = usePartyReviewQueue()
    items.value = [{ id: 'stale' }]
    await load()
    expect(error.value).toBe('LISTEN failed')
    expect(items.value).toHaveLength(0)
  })

  it('resolveItem throws the message-shaped server error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(fail(409, { message: 'queue closed' }))
    const { resolveItem, submitting } = usePartyReviewQueue()
    await expect(resolveItem('q1', { action: 'merge' })).rejects.toThrow(/queue closed/)
    expect(submitting.value).toBe(false)
  })
})

// ─── useRun (store-backed accessors + actions) ──────────────────────────────────

describe('useRun', () => {
  function seedRun(threadId, slice) {
    const store = useAgentStore()
    store.runs[threadId] = { phase: 'idle', _source: null, fragments: [], trace: [], errors: [], ...slice }
    return store
  }

  it('attaches when the slice is unknown', () => {
    const store = useAgentStore()
    const attachSpy = vi.spyOn(store, 'attach').mockImplementation(() => {})
    useRun(ref('thread-new'))
    expect(attachSpy).toHaveBeenCalledWith('thread-new')
  })

  it('does NOT attach for a terminal-phase slice with no source', () => {
    const store = seedRun('thread-done', { phase: 'done', _source: null })
    const attachSpy = vi.spyOn(store, 'attach').mockImplementation(() => {})
    useRun(ref('thread-done'))
    expect(attachSpy).not.toHaveBeenCalled()
  })

  it('attaches a running slice that lost its source (reconnect)', () => {
    const store = seedRun('thread-running', { phase: 'running', _source: null })
    const attachSpy = vi.spyOn(store, 'attach').mockImplementation(() => {})
    useRun(ref('thread-running'))
    expect(attachSpy).toHaveBeenCalledWith('thread-running')
  })

  it('returns null slice + idle phase for a falsy threadId', () => {
    const { slice, phase, isRunning } = useRun(ref(null))
    expect(slice.value).toBeNull()
    expect(phase.value).toBe('idle')
    expect(isRunning.value).toBe(false)
  })

  it('exposes the screening default when the slice has none', () => {
    seedRun('thread-1', { phase: 'running', _source: {} })
    const { screening } = useRun(ref('thread-1'))
    expect(screening.value.subjects).toEqual([])
    expect(screening.value.screenedByList).toHaveProperty('ofac_sdn')
  })

  it('isRunning is true for needs_user_pick / awaiting_decision phases', () => {
    seedRun('thread-pick', { phase: 'needs_user_pick', _source: {} })
    const { isRunning } = useRun(ref('thread-pick'))
    expect(isRunning.value).toBe(true)
  })

  it('pick / cancel / remove delegate to the store with the threadId', () => {
    const store = seedRun('thread-act', { phase: 'running', _source: {} })
    const resume = vi.spyOn(store, 'resume').mockImplementation(() => {})
    const cancelRun = vi.spyOn(store, 'cancelRun').mockImplementation(() => {})
    const removeRun = vi.spyOn(store, 'removeRun').mockImplementation(() => {})
    const { pick, cancel, remove } = useRun(ref('thread-act'))
    pick('01234567')
    cancel()
    remove()
    expect(resume).toHaveBeenCalledWith('thread-act', '01234567')
    expect(cancelRun).toHaveBeenCalledWith('thread-act')
    expect(removeRun).toHaveBeenCalledWith('thread-act')
  })

  it('pick / cancel / remove are no-ops when the threadId is falsy', () => {
    const store = useAgentStore()
    const resume = vi.spyOn(store, 'resume').mockImplementation(() => {})
    vi.spyOn(store, 'attach').mockImplementation(() => {})
    const { pick, cancel, remove } = useRun(ref(''))
    pick('x')
    cancel()
    remove()
    expect(resume).not.toHaveBeenCalled()
  })

  it('subjectName falls back to "New search" when there is no slice', () => {
    const { subjectName } = useRun(ref(null))
    expect(subjectName.value).toBe('New search')
  })
})

// ─── ScreeningEvidenceCard (pure prop-driven branches) ──────────────────────────

const SCR_STUBS = {} // none needed

function screening(over = {}) {
  return {
    subjects: [
      { id: 's1', name: 'John Smith' },
      { id: 's2', name: 'ACME LTD' },
    ],
    hits: [],
    evaluations: [],
    currentSubjectId: null,
    currentList: null,
    screenedByList: { ofac_sdn: {}, uk_hmt: {}, adverse_media: {} },
    lastEvents: [],
    ...over,
  }
}

describe('ScreeningEvidenceCard', () => {
  it('renders the subject counter (plural)', () => {
    const w = mountC(ScreeningEvidenceCard, { screening: screening() })
    expect(w.html()).toContain('2 subjects identified')
  })

  it('renders the singular subject counter', () => {
    const w = mountC(ScreeningEvidenceCard, { screening: screening({ subjects: [{ id: 's1', name: 'Solo' }] }) })
    expect(w.html()).toContain('1 subject identified')
  })

  it('computes per-list progress percentages from screenedByList', () => {
    const w = mountC(ScreeningEvidenceCard, {
      screening: screening({ screenedByList: { ofac_sdn: { s1: 1 }, uk_hmt: {}, adverse_media: {} } }),
    })
    // ofac 1/2 → 50%
    expect(w.html()).toContain('1/2')
    expect(w.html()).toContain('width: 50%')
  })

  it('renders the zero-subjects progress branch (progressPct returns 0)', () => {
    const w = mountC(ScreeningEvidenceCard, { screening: screening({ subjects: [] }) })
    expect(w.html()).toContain('width: 0%')
  })

  it('counts confirmed / needs_review / dismissed / evaluating from hits + evaluations', () => {
    const w = mountC(ScreeningEvidenceCard, {
      screening: screening({
        hits: [
          { hitId: 'h1', subjectName: 'A', listSource: 'ofac_sdn', matchScore: 0.91 },
          { id: 'h2', subjectName: 'B', listSource: 'uk_hmt', matchScore: 0.8 },
          { hitId: 'h3', subjectName: 'C', listSource: 'adverse_media', matchScore: null },
          { hitId: 'h4', subjectName: 'D', listSource: 'ofac_sdn', matchScore: 0.7 },
        ],
        evaluations: [
          { hitId: 'h1', decision: 'confirmed' },
          { hitId: 'h2', decision: 'needs_review' },
          { hitId: 'h3', decision: 'dismissed' },
          // h4 has no evaluation → evaluating
        ],
      }),
    })
    const html = w.html()
    expect(html).toContain('1 confirmed')
    expect(html).toContain('1 need review')
    expect(html).toContain('1 dismissed')
    expect(html).toContain('1 evaluating')
  })

  it('renders the current-subject section with a known subject + list', () => {
    const w = mountC(ScreeningEvidenceCard, {
      screening: screening({ currentSubjectId: 's1', currentList: 'ofac_sdn' }),
    })
    expect(w.html()).toContain('Currently evaluating')
    expect(w.html()).toContain('John Smith')
    expect(w.html()).toContain('on OFAC SDN')
  })

  it('falls back to the raw id when the current subject is unknown', () => {
    const w = mountC(ScreeningEvidenceCard, {
      screening: screening({ currentSubjectId: 'ghost', currentList: 'weird_list' }),
    })
    expect(w.html()).toContain('ghost')
    expect(w.html()).toContain('on weird_list') // LIST_LABEL fallback
  })

  it('renders the recent-hits feed with all decision tones + score formatting', () => {
    const w = mountC(ScreeningEvidenceCard, {
      screening: screening({
        hits: [
          { hitId: 'h1', subjectName: 'A', listSource: 'ofac_sdn', matchScore: 0.91 },
          { hitId: 'h2', subjectName: 'B', listSource: 'unknown_list', matchScore: null },
        ],
        evaluations: [{ hitId: 'h1', decision: 'confirmed' }],
      }),
    })
    const html = w.html()
    expect(html).toContain('Recent hits')
    expect(html).toContain('0.91') // score.toFixed(2)
    expect(html).toContain('feed-decision--danger') // confirmed tone
    expect(html).toContain('Evaluating…') // h2 has no eval → null decision
    expect(html).toContain('unknown_list') // LIST_LABEL fallback in the feed
  })
})

// ─── RiskAssessmentCard (delta tones, tierDiffers, factor switch, receipt) ──────

function assessment(over = {}) {
  return {
    score: 42.4,
    tier: 'Medium',
    outcome: 'Medium',
    factors: [
      { factor: 'geographic', label: 'Geographic', weight: 0.4, baseScore: 20, contribution: 8, attribute: { matched: true, iso2: 'GB', label: 'United Kingdom' } },
      { factor: 'entityType', label: 'Entity type', weight: 0.25, baseScore: 50, contribution: 12.5, attribute: { matched: false, type: 'ltd', rawType: 'ltd' } },
      { factor: 'structuralComplexity', label: 'Structure', weight: 0.2, baseScore: 30, contribution: 6, attribute: { corporatePscCount: 2, shareholderLayers: 1 } },
      { factor: 'industry', label: 'Industry', weight: 0.15, baseScore: 10, contribution: 1.5, attribute: { matched: true, label: 'Consulting', prefix: '70', sicCode: '70229' } },
    ],
    knockoutsTriggered: [],
    deltaFromPrevious: 6,
    deltaFlagged: false,
    matrixVersion: 3,
    calculatedAt: '2026-01-01T12:00:00Z',
    rationale: 'A defensible rationale.',
    receipt: { scoreBeforeKnockouts: 42.4, trajectory: { previousScore: 36 }, warnings: ['Country not stated'] },
    ...over,
  }
}

function mountRisk(props, role = null) {
  const auth = useAuthStore()
  if (role) auth.user = { userId: '1', username: 'u', role, active: true }
  return mountC(RiskAssessmentCard, props, {
    global: { plugins: [getPinia()], stubs: { RouterLink: { template: '<a><slot /></a>' } } },
  })
}

describe('RiskAssessmentCard branches', () => {
  it('renders the up delta tone with previous score + factor attributes', () => {
    const w = mountRisk({ assessment: assessment() })
    const html = w.html()
    expect(html).toContain('delta-chip--up')
    expect(html).toContain('vs 36')
    // factor attribute switch: geographic matched, entityType unmapped, structural, industry matched
    expect(html).toContain('United Kingdom (GB)')
    expect(html).toContain('ltd — unmapped (default)')
    expect(html).toContain('2 corporate PSC · 1 ownership layer')
    expect(html).toContain('Consulting (SIC 70229)')
    // warnings rendered
    expect(html).toContain('Country not stated')
  })

  it('renders the down delta tone (delta <= -5)', () => {
    const w = mountRisk({ assessment: assessment({ deltaFromPrevious: -8 }) })
    expect(w.html()).toContain('delta-chip--down')
    expect(w.html()).toContain('trending_down')
  })

  it('renders the up-flagged delta tone with a flag marker', () => {
    const w = mountRisk({ assessment: assessment({ deltaFromPrevious: 18, deltaFlagged: true }) })
    expect(w.html()).toContain('delta-chip--up-flagged')
    expect(w.html()).toContain('delta-flag')
  })

  it('shows "no prior run" when there is no delta', () => {
    const w = mountRisk({ assessment: assessment({ deltaFromPrevious: null, receipt: { scoreBeforeKnockouts: 42 } }) })
    expect(w.html()).toContain('no prior run')
  })

  it('notes a differing score tier and renders knockouts when outcome != tier', () => {
    const w = mountRisk({
      assessment: assessment({
        outcome: 'Prohibited',
        tier: 'Medium',
        knockoutsTriggered: ['screeningProhibited', 'mystery_knockout'],
      }),
    })
    const html = w.html()
    expect(html).toContain('score tier: Medium')
    expect(html).toContain('Confirmed sanctions hit — outcome forced to Prohibited')
    expect(html).toContain('mystery_knockout') // KNOCKOUT_LABEL fallback
  })

  it('covers the unmatched-geographic + no-SIC factor attribute branches', () => {
    const w = mountRisk({
      assessment: assessment({
        factors: [
          { factor: 'geographic', label: 'Geo', weight: 0.4, baseScore: 20, contribution: 8, attribute: { label: 'Atlantis' } },
          { factor: 'geographic', label: 'Geo2', weight: 0.4, baseScore: 20, contribution: 8, attribute: {} },
          { factor: 'entityType', label: 'ET', weight: 0.25, baseScore: 50, contribution: 12.5, attribute: { matched: true, type: 'PLC' } },
          { factor: 'structuralComplexity', label: 'Struct', weight: 0.2, baseScore: 30, contribution: 6, attribute: {} },
          { factor: 'industry', label: 'Ind', weight: 0.15, baseScore: 10, contribution: 1.5, attribute: { matched: false } },
          { factor: 'unknownFactor', label: 'Unknown', weight: 0.1, baseScore: 5, contribution: 0.5, attribute: { foo: 'bar' } },
          { factor: 'emptyFactor', label: 'Empty', weight: 0.1, baseScore: 5, contribution: 0.5, attribute: {} },
        ],
      }),
    })
    const html = w.html()
    expect(html).toContain('Atlantis — unrecognised (default)')
    expect(html).toContain('Country not stated (default)')
    expect(html).toContain('1 ownership layer') // default shareholderLayers ?? 1
    expect(html).toContain('No SIC match (default)')
    expect(html).toContain('foo') // default JSON.stringify branch
  })

  it('toggles the calculation receipt JSON open', async () => {
    const w = mountRisk({ assessment: assessment() })
    const toggle = w.find('.receipt-toggle')
    await toggle.trigger('click')
    expect(w.html()).toContain('receipt-json')
    expect(w.html()).toContain('scoreBeforeKnockouts')
  })

  it('renders a template-rationale note when rationaleSource is template', () => {
    const w = mountRisk({ assessment: assessment(), rationaleSource: 'template' })
    expect(w.html()).toContain('generated offline')
  })

  it('shows the admin matrix link for admins and plain text otherwise', () => {
    const adminW = mountRisk({ assessment: assessment() }, 'admin')
    expect(adminW.find('.matrix-link').exists()).toBe(true)
    setActivePinia(createPinia())
    const analystW = mountRisk({ assessment: assessment() }, 'analyst')
    expect(analystW.find('.matrix-link').exists()).toBe(false)
    expect(analystW.html()).toContain('Matrix v3')
  })

  it('shows the recalculating label while a recalc is in flight', () => {
    const w = mountRisk({ assessment: assessment(), recalculating: true })
    expect(w.html()).toContain('Recalculating…')
  })

  it('renders the empty state when assessment is null', () => {
    const w = mountRisk({ assessment: null })
    expect(w.html()).toContain('Not yet assessed')
  })
})

// ─── LiveEvidenceCard (stage-driven percent + eta + fmtDuration branches) ───────

describe('LiveEvidenceCard branches', () => {
  it('renders the idle state (no progress)', () => {
    const w = mountC(LiveEvidenceCard, { progress: null })
    expect(w.html().length).toBeGreaterThan(10)
  })

  it('renders an OCR page in progress with page counts + ETA from pageDurations', () => {
    const w = mountC(LiveEvidenceCard, {
      progress: {
        stage: 'ocr_page',
        category: 'confirmation-statement',
        date: '2024-01-01',
        transactionId: 'tx-1',
        pages: 5,
        page: 2,
        pageDurations: [40000, 42000],
      },
    })
    const html = w.html()
    expect(html).toContain('Confirmation Statement') // filingType title-cased
    expect(html).toContain('tx-1')
    w.unmount()
  })

  it('renders the extracting stage (percent 85→95 creep, no page signal)', () => {
    const w = mountC(LiveEvidenceCard, {
      progress: { stage: 'extracting', category: 'accounts', pages: 0 },
    })
    expect(w.html().length).toBeGreaterThan(20)
    w.unmount()
  })

  it('renders the text_extracted stage', () => {
    const w = mountC(LiveEvidenceCard, { progress: { stage: 'text_extracted', category: 'accounts' } })
    expect(w.html().length).toBeGreaterThan(20)
  })

  it('renders the terminal done/batch_done/failed/skipped stages', () => {
    for (const stage of ['done', 'batch_done', 'failed', 'skipped', 'rasterizing', 'preparing']) {
      const w = mountC(LiveEvidenceCard, { progress: { stage, category: 'accounts', pages: 3, page: 1 } })
      expect(w.html().length).toBeGreaterThan(10)
      w.unmount()
    }
  })

  it('handles ocr_page_done with full page completion', () => {
    const w = mountC(LiveEvidenceCard, {
      progress: { stage: 'ocr_page_done', pages: 3, page: 3, pageDurations: [30000, 31000, 29000] },
    })
    expect(w.html().length).toBeGreaterThan(10)
    w.unmount()
  })
})

// ─── WatchlistPage (loadWatched, fmtDate, review-queue handlers) ────────────────

const PAGE_STUBS = {
  RouterLink: { template: '<a><slot /></a>' },
  RouterView: { template: '<div />' },
}

function routeFetch(routes) {
  return vi.fn((url, init) => {
    for (const [needle, responder] of routes) {
      if (String(url).includes(needle)) return Promise.resolve(responder(url, init))
    }
    return Promise.resolve(ok(null))
  })
}

function mountWatchlist(routes) {
  globalThis.fetch = routeFetch(routes)
  return mountC(WatchlistPage, {}, { global: { plugins: [getPinia()], stubs: PAGE_STUBS } })
}

const REVIEW_ITEM = {
  id: 'q1',
  party_id: 'p-new',
  candidate_party_id: 'p-cand',
  new_party_name: 'John Smith',
  new_party_type: 'individual',
  candidate_party_name: 'Jon Smith',
  candidate_party_type: 'individual',
  confidence: 'review',
  score: 0.6321,
  matched_via: 'name',
}

describe('WatchlistPage', () => {
  it('renders watched parties from the watchlist endpoint', async () => {
    const w = mountWatchlist([
      ['/api/parties/watchlist', () => ok({ items: [{ watchlist_id: 'w1', party_id: 'p1', full_name: 'Watched Co', party_type: 'organisation', linked_dossier_count: 2, reason: 'monitor', added_at: '2026-01-01T00:00:00Z' }] })],
      ['/api/parties/review-queue', () => ok({ items: [] })],
    ])
    await flush()
    const html = w.html()
    expect(html).toContain('Watched Co')
    expect(html).toContain('2026-01-01') // fmtDate slice
    expect(html).toContain('monitor')
  })

  it('shows the watchlist error state', async () => {
    const w = mountWatchlist([
      ['/api/parties/watchlist', () => fail(500, { error: 'no access' })],
      ['/api/parties/review-queue', () => ok({ items: [] })],
    ])
    await flush()
    expect(w.html()).toContain('no access')
  })

  it('shows the empty watched-parties state', async () => {
    const w = mountWatchlist([
      ['/api/parties/watchlist', () => ok({ items: [] })],
      ['/api/parties/review-queue', () => ok({ items: [] })],
    ])
    await flush()
    expect(w.html()).toContain('No watched parties')
  })

  it('switches to the review-queue tab and opens then cancels the reject form', async () => {
    const w = mountWatchlist([
      ['/api/parties/watchlist', () => ok({ items: [] })],
      ['/api/parties/review-queue', () => ok({ items: [REVIEW_ITEM] })],
    ])
    await flush()
    const reviewTab = w.findAll('.tab').find((t) => t.text().includes('Party review queue'))
    await reviewTab.trigger('click')
    await flush()
    expect(w.html()).toContain('John Smith')
    expect(w.html()).toContain('score 0.632')
    // open the reject form (openReject)
    const rejectBtn = w.findAll('button').find((b) => b.text() === 'Reject')
    await rejectBtn.trigger('click')
    expect(w.html()).toContain('Mark the candidate match as wrong')
    // cancel (closeAction)
    const cancelBtn = w.findAll('button').find((b) => b.text() === 'Cancel')
    await cancelBtn.trigger('click')
    expect(w.html()).not.toContain('Mark the candidate match as wrong')
  })

  it('opens the merge form and submits it (submitAction → resolveItem)', async () => {
    const w = mountWatchlist([
      ['/api/parties/watchlist', () => ok({ items: [] })],
      ['/resolve', () => ok({ ok: true })],
      ['/api/parties/review-queue', () => ok({ items: [REVIEW_ITEM] })],
    ])
    await flush()
    const reviewTab = w.findAll('.tab').find((t) => t.text().includes('Party review queue'))
    await reviewTab.trigger('click')
    await flush()
    const mergeBtn = w.findAll('button').find((b) => b.text() === 'Merge')
    await mergeBtn.trigger('click')
    expect(w.html()).toContain('Soft-merge the NEW party')
    const input = w.find('.review-row-form input[type="text"]')
    await input.setValue('same person')
    const confirmBtn = w.findAll('button').find((b) => /Confirm merge/.test(b.text()))
    await confirmBtn.trigger('click')
    await flush()
    const resolveCall = globalThis.fetch.mock.calls.find((c) => String(c[0]).includes('/resolve'))
    expect(resolveCall).toBeTruthy()
    expect(JSON.parse(resolveCall[1].body).action).toBe('merge')
  })

  it('shows the empty review-queue state', async () => {
    const w = mountWatchlist([
      ['/api/parties/watchlist', () => ok({ items: [] })],
      ['/api/parties/review-queue', () => ok({ items: [] })],
    ])
    await flush()
    const reviewTab = w.findAll('.tab').find((t) => t.text().includes('Party review queue'))
    await reviewTab.trigger('click')
    await flush()
    expect(w.html()).toContain('No open review items')
  })
})

// ─── SearchPage (onSubmit + rerun handlers) ─────────────────────────────────────

describe('SearchPage', () => {
  function mountSearch(dossiers = []) {
    globalThis.fetch = routeFetch([
      ['kpis', () => ok({})],
      ['/api/dossiers', () => ok(dossiers)],
    ])
    return mountC(SearchPage, {}, {
      global: {
        plugins: [getPinia()],
        stubs: { ...PAGE_STUBS, SearchForm: { template: '<button class="stub-form" @click="$emit(\'submit\', { name: \'ACME\' })">go</button>' } },
      },
    })
  }

  it('onSubmit starts a run and routes to the run page', async () => {
    const store = useAgentStore()
    const startSpy = vi.spyOn(store, 'startRun').mockResolvedValue('thread-abc')
    const w = mountSearch()
    await flush()
    await w.find('.stub-form').trigger('click')
    await flush()
    expect(startSpy).toHaveBeenCalledWith({ name: 'ACME' })
    expect(mockPush).toHaveBeenCalledWith({ name: 'run', params: { threadId: 'thread-abc' } })
  })

  it('rerun starts a run for a recent dossier and routes', async () => {
    const store = useAgentStore()
    const startSpy = vi.spyOn(store, 'startRun').mockResolvedValue('thread-rerun')
    const w = mountSearch([{ id: 'd1', companyNumber: '01234567', companyName: 'ACME LTD' }])
    await flush()
    const rerunBtn = w.find('.recent-item')
    expect(rerunBtn.exists()).toBe(true)
    await rerunBtn.trigger('click')
    await flush()
    expect(startSpy).toHaveBeenCalledWith({ companyNumber: '01234567' })
    expect(mockPush).toHaveBeenCalledWith({ name: 'run', params: { threadId: 'thread-rerun' } })
  })

  it('shows the no-prior-searches empty state', async () => {
    const w = mountSearch([])
    await flush()
    expect(w.html()).toContain('No prior searches yet')
  })
})
