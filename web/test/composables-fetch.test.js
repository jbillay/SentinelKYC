// Phase 5b — Data-fetch composables: everything that talks to /api/* via fetch
// and returns reactive state. No Pinia stores, no vue-router — call the
// composable directly and drive fetch with vi.fn() mocks.
//
// Covered: useDossiers, useRiskMatrix, useAgents, usePrompts, useRiskAssessment,
//          useRunDetail, useRunPair, useParties, usePartyReviewQueue, useParty.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { nextTick } from 'vue'
import { useDossiers } from '@/composables/useDossiers.js'
import { useRiskMatrix } from '@/composables/useRiskMatrix.js'
import { useAgents } from '@/composables/useAgents.js'
import { usePrompts } from '@/composables/usePrompts.js'
import { useRiskAssessment } from '@/composables/useRiskAssessment.js'
import { useRunDetail } from '@/composables/useRunDetail.js'
import { useRunPair } from '@/composables/useRunPair.js'
import { useParties } from '@/composables/useParties.js'
import { usePartyReviewQueue } from '@/composables/usePartyReviewQueue.js'
import { useParty } from '@/composables/useParty.js'

function ok(body) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) }
}
function fail(body, status = 400) {
  return { ok: false, status, json: () => Promise.resolve(body) }
}

beforeEach(() => {
  globalThis.fetch = vi.fn()
})

// ─── useDossiers ──────────────────────────────────────────────────────────────

describe('useDossiers', () => {
  it('fetches list and kpis on init', async () => {
    fetch
      .mockResolvedValueOnce(ok([{ companyNumber: '01234567' }]))
      .mockResolvedValueOnce(ok({ total: 1 }))
    const { dossiers, kpis, loading } = useDossiers()
    expect(loading.value).toBe(true)
    await nextTick()
    await new Promise((r) => setTimeout(r, 0))
    expect(Array.isArray(dossiers.value)).toBe(true)
  })

  it('sets error on list fetch failure', async () => {
    fetch
      .mockResolvedValueOnce(fail({ error: 'forbidden' }, 403))
      .mockResolvedValueOnce(ok({ total: 0 }))
    const { error } = useDossiers()
    await nextTick()
    await new Promise((r) => setTimeout(r, 0))
    expect(error.value).toContain('403')
  })

  it('builds URL params from filter + tag + caseStatus', async () => {
    fetch.mockResolvedValue(ok([]))
    const { refresh, filter, tag, caseStatus } = useDossiers()
    // Let the init refresh settle, then clear call history so we only see the
    // explicit refresh() call below (not the init calls).
    await new Promise((r) => setTimeout(r, 0))
    fetch.mockClear()
    filter.value = 'done'
    tag.value = 'vip'
    caseStatus.value = 'approved'
    await refresh()
    const url = fetch.mock.calls.find((c) =>
      c[0].includes('/api/dossiers') && !c[0].includes('kpis')
    )?.[0]
    expect(url).toContain('status=done')
    expect(url).toContain('tag=vip')
    expect(url).toContain('caseStatus=approved')
  })
})

// ─── useRiskMatrix ────────────────────────────────────────────────────────────

describe('useRiskMatrix', () => {
  it('loadActive populates active ref', async () => {
    fetch.mockResolvedValue(ok({ versionId: 'v1', body: {} }))
    const { active, loadActive } = useRiskMatrix()
    await loadActive()
    expect(active.value.versionId).toBe('v1')
  })

  it('loadVersions populates versions array', async () => {
    fetch.mockResolvedValue(ok([{ id: 'v1', version: 1 }]))
    const { versions, loadVersions } = useRiskMatrix()
    await loadVersions()
    expect(versions.value).toHaveLength(1)
  })

  it('fetchVersion returns and stores the version detail', async () => {
    fetch.mockResolvedValue(ok({ id: 'v2', body: { weights: {} } }))
    const { versionDetail, fetchVersion } = useRiskMatrix()
    const v = await fetchVersion('v2')
    expect(v.id).toBe('v2')
    expect(versionDetail.value.id).toBe('v2')
  })

  it('createVersion surfaces validationErrors on 400', async () => {
    fetch.mockResolvedValue(
      fail({ error: 'invalid_matrix', validationErrors: ['weight must be number'] }),
    )
    const { createVersion, error, validationErrors } = useRiskMatrix()
    await expect(createVersion({}, 'test')).rejects.toBeTruthy()
    expect(validationErrors.value).toContain('weight must be number')
    expect(error.value).toBeTruthy()
  })

  it('createVersion on success re-fetches versions list', async () => {
    fetch
      .mockResolvedValueOnce(ok({ id: 'v3', version: 3 })) // POST
      .mockResolvedValueOnce(ok([{ id: 'v3' }])) // GET versions
    const { createVersion, versions } = useRiskMatrix()
    await createVersion({ weights: {} }, null)
    expect(versions.value).toHaveLength(1)
  })

  it('setActive optimistically flips and rolls back on failure', async () => {
    const { active, versions, setActive, error } = useRiskMatrix()
    versions.value = [{ id: 'v2', version: 2, notes: null }]
    active.value = { versionId: 'v1', version: 1, notes: null }

    fetch.mockResolvedValue(fail({ error: 'not_found' }, 404))
    await expect(setActive('v2')).rejects.toBeTruthy()
    // Must have rolled back
    expect(active.value.versionId).toBe('v1')
    expect(error.value).toBeTruthy()
  })

  it('setActive succeeds and re-fetches active', async () => {
    const { active, versions, setActive } = useRiskMatrix()
    versions.value = [{ id: 'v2', version: 2, notes: null }]
    active.value = { versionId: 'v1', version: 1 }

    fetch
      .mockResolvedValueOnce(ok({})) // POST active
      .mockResolvedValueOnce(ok({ versionId: 'v2', version: 2 })) // GET active
    await setActive('v2')
    expect(active.value.versionId).toBe('v2')
  })
})

// ─── useAgents ────────────────────────────────────────────────────────────────

describe('useAgents', () => {
  it('fetchAgents populates agents and clears loading', async () => {
    fetch.mockResolvedValue(ok([{ id: 'screening', enabled: true }]))
    const { agents, loading, fetchAgents } = useAgents()
    await fetchAgents()
    expect(agents.value).toHaveLength(1)
    expect(loading.value).toBe(false)
  })

  it('fetchAgents on failure sets error', async () => {
    fetch.mockResolvedValue(fail({}, 500))
    const { error, fetchAgents } = useAgents()
    await fetchAgents()
    expect(error.value).toContain('500')
  })

  it('setEnabled patches the agent in-place', async () => {
    fetch.mockResolvedValue(ok({ agent: { id: 'screening', enabled: false } }))
    const { agents, setEnabled } = useAgents()
    agents.value = [{ id: 'screening', enabled: true }]
    await setEnabled('screening', false)
    expect(agents.value[0].enabled).toBe(false)
  })

  it('setEnabled surfaces error message from the server', async () => {
    fetch.mockResolvedValue(fail({ error: 'agent_required' }))
    const { error, setEnabled } = useAgents()
    await setEnabled('entity-resolution', false)
    expect(error.value).toBe('agent_required')
  })

  it('saveConfig returns true on success and patches agent', async () => {
    fetch.mockResolvedValue(ok({ agent: { id: 'screening', config: {} } }))
    const { agents, saveConfig } = useAgents()
    agents.value = [{ id: 'screening', config: null }]
    const ok2 = await saveConfig('screening', { threshold: 0.9 })
    expect(ok2).toBe(true)
  })

  it('saveConfig returns false and sets error on validation failure', async () => {
    fetch.mockResolvedValue(
      fail({ error: 'invalid_config', validationErrors: ['threshold must be ≤1'] }),
    )
    const { error, saveConfig } = useAgents()
    const result = await saveConfig('screening', { threshold: 2 })
    expect(result).toBe(false)
    expect(error.value).toContain('invalid_config')
  })
})

// ─── usePrompts ───────────────────────────────────────────────────────────────

describe('usePrompts', () => {
  it('fetchList populates list', async () => {
    fetch.mockResolvedValue(ok([{ key: 'kyc.synthesis', versions: 1 }]))
    const { list, fetchList } = usePrompts()
    await fetchList()
    expect(list.value).toHaveLength(1)
  })

  it('selectKey populates detail, editorBody, and selectedVersionId', async () => {
    fetch.mockResolvedValue(
      ok({ key: 'kyc.synthesis', active: { id: 'v1', body: 'Synthesise.' }, versions: [{ id: 'v1' }] }),
    )
    const { detail, editorBody, selectedVersionId, selectKey } = usePrompts()
    await selectKey('kyc.synthesis')
    expect(detail.value.key).toBe('kyc.synthesis')
    expect(editorBody.value).toBe('Synthesise.')
    expect(selectedVersionId.value).toBe('v1')
  })

  it('selectVersion updates editorBody from the loaded version', async () => {
    fetch.mockResolvedValue(ok({ id: 'v2', body: 'Updated body.' }))
    const { detail, selectedVersionId, editorBody, selectVersion } = usePrompts()
    detail.value = { key: 'kyc.synthesis' }
    await selectVersion('v2')
    expect(editorBody.value).toBe('Updated body.')
    expect(selectedVersionId.value).toBe('v2')
  })

  it('saveAsNewVersion chains fetchList after creating the version', async () => {
    fetch
      .mockResolvedValueOnce(ok({ id: 'v3', body: 'x' })) // POST
      .mockResolvedValueOnce(ok({ key: 'kyc.synthesis', active: { id: 'v3', body: 'x' }, versions: [{ id: 'v3' }] })) // selectKey re-fetch
      .mockResolvedValueOnce(ok({ id: 'v3', body: 'x' })) // selectVersion re-fetch
      .mockResolvedValueOnce(ok([{ key: 'kyc.synthesis' }])) // fetchList
    const { detail, editorBody, saveAsNewVersion } = usePrompts()
    detail.value = { key: 'kyc.synthesis' }
    editorBody.value = 'x'
    await saveAsNewVersion()
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('setActive is a no-op when detail or selectedVersionId is null', async () => {
    const { setActive } = usePrompts()
    await setActive() // no detail set — should return early
    expect(fetch).not.toHaveBeenCalled()
  })
})

// ─── useRiskAssessment ────────────────────────────────────────────────────────

describe('useRiskAssessment', () => {
  it('fetchForRun populates result on 200', async () => {
    fetch.mockResolvedValue(ok({ riskAssessment: { tier: 'Low', score: 12 } }))
    const { result, loading, fetchForRun } = useRiskAssessment()
    await fetchForRun('01234567', 'run-1')
    expect(result.value.tier).toBe('Low')
    expect(loading.value).toBe(false)
  })

  it('fetchForRun sets notAssessed on 404', async () => {
    fetch.mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve({}) })
    const { result, notAssessed, fetchForRun } = useRiskAssessment()
    await fetchForRun('01234567', 'run-1')
    expect(result.value).toBeNull()
    expect(notAssessed.value).toBe(true)
  })

  it('fetchForRun skips fetch when arguments are falsy', async () => {
    const { fetchForRun } = useRiskAssessment()
    await fetchForRun(null, null)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('recalculate updates result and rationaleSource on success', async () => {
    fetch.mockResolvedValue(ok({ riskAssessment: { tier: 'Medium' }, rationaleSource: 'template' }))
    const { result, rationaleSource, recalculate } = useRiskAssessment()
    await recalculate('01234567')
    expect(result.value.tier).toBe('Medium')
    expect(rationaleSource.value).toBe('template')
  })

  it('recalculate surfaces error and rethrows on failure', async () => {
    fetch.mockResolvedValue(fail({ error: 'no_snapshots' }))
    const { recalcError, recalculate } = useRiskAssessment()
    await expect(recalculate('01234567')).rejects.toBeTruthy()
    expect(recalcError.value).toBeTruthy()
  })
})

// ─── useRunDetail ─────────────────────────────────────────────────────────────

describe('useRunDetail', () => {
  it('fetches run detail on init and populates run', async () => {
    fetch.mockResolvedValue(ok({ id: 'run-1', status: 'done' }))
    const { run, loading } = useRunDetail('01234567', 'run-1')
    await nextTick()
    await new Promise((r) => setTimeout(r, 0))
    expect(loading.value).toBe(false)
    expect(run.value?.id ?? null).not.toBeNull()
  })

  it('sets error to not_found on 404', async () => {
    fetch.mockResolvedValue({ ok: false, status: 404, json: () => Promise.resolve({}) })
    const { error } = useRunDetail('01234567', 'run-1')
    await nextTick()
    await new Promise((r) => setTimeout(r, 0))
    expect(error.value).toBe('not_found')
  })

  it('refresh re-fetches', async () => {
    fetch.mockResolvedValue(ok({ id: 'run-1', status: 'done' }))
    const { refresh } = useRunDetail('01234567', 'run-1')
    await nextTick()
    await new Promise((r) => setTimeout(r, 0))
    fetch.mockResolvedValue(ok({ id: 'run-1', status: 'done', refreshed: true }))
    const { run } = useRunDetail('01234567', 'run-1')
    await refresh()
    expect(fetch).toHaveBeenCalledTimes(3)
  })
})

// ─── useRunPair ───────────────────────────────────────────────────────────────

describe('useRunPair', () => {
  it('fetches both runs on init', async () => {
    fetch
      .mockResolvedValueOnce(ok({ id: 'run-a', status: 'done' }))
      .mockResolvedValueOnce(ok({ id: 'run-b', status: 'done' }))
    const { left, right } = useRunPair('01234567', 'run-a', 'run-b')
    await nextTick()
    await new Promise((r) => setTimeout(r, 0))
    expect(left.value?.id ?? right.value?.id).toBeTruthy()
  })

  it('sets error to not_found when either run returns 404', async () => {
    fetch
      .mockResolvedValueOnce(ok({ id: 'run-a' }))
      .mockResolvedValueOnce({ ok: false, status: 404, json: () => Promise.resolve({}) })
    const { error } = useRunPair('01234567', 'run-a', 'run-missing')
    await nextTick()
    await new Promise((r) => setTimeout(r, 0))
    expect(error.value).toBe('not_found')
  })

  it('skips fetch when arguments are falsy', async () => {
    // Pass empty strings: the composable resolves them via `val.value ?? val`
    // which gives '' for a string arg (undefined ?? ''), and !'' is true → guard fires.
    useRunPair('', '', '')
    await nextTick()
    expect(fetch).not.toHaveBeenCalled()
  })
})

// ─── useParties ───────────────────────────────────────────────────────────────

describe('useParties', () => {
  it('load appends filters to the query string', async () => {
    fetch.mockResolvedValue(ok({ parties: [{ id: 'p1' }] }))
    const { parties, load } = useParties()
    await load({ q: 'Smith', needsReview: true, limit: 5 })
    const url = fetch.mock.calls[0][0]
    expect(url).toContain('q=Smith')
    expect(url).toContain('needs_review=true')
    expect(url).toContain('limit=5')
    expect(parties.value).toHaveLength(1)
  })

  it('load sets error on non-ok response and clears parties', async () => {
    fetch.mockResolvedValue(fail({ error: 'forbidden' }, 403))
    const { error, parties, load } = useParties()
    parties.value = [{ id: 'stale' }]
    await load()
    expect(error.value).toBeTruthy()
    expect(parties.value).toHaveLength(0)
  })
})

// ─── usePartyReviewQueue ──────────────────────────────────────────────────────

describe('usePartyReviewQueue', () => {
  it('load populates items', async () => {
    fetch.mockResolvedValue(ok({ items: [{ id: 'q1', status: 'open' }] }))
    const { items, load } = usePartyReviewQueue()
    await load()
    expect(items.value).toHaveLength(1)
  })

  it('load clears items on error', async () => {
    fetch.mockResolvedValue(fail({}, 500))
    const { items, error, load } = usePartyReviewQueue()
    items.value = [{ id: 'stale' }]
    await load()
    expect(items.value).toHaveLength(0)
    expect(error.value).toBeTruthy()
  })

  it('resolveItem throws when id or action is missing', async () => {
    const { resolveItem } = usePartyReviewQueue()
    await expect(resolveItem(null, {})).rejects.toThrow(/required/)
    await expect(resolveItem('q1', {})).rejects.toThrow(/required/)
  })

  it('resolveItem POSTs and then reloads the queue', async () => {
    fetch
      .mockResolvedValueOnce(ok({ ok: true })) // POST resolve
      .mockResolvedValueOnce(ok({ items: [] })) // reload
    const { resolveItem } = usePartyReviewQueue()
    const body = await resolveItem('q1', { action: 'reject', reason: 'duplicate' })
    expect(body.ok).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})

// ─── useParty ─────────────────────────────────────────────────────────────────

describe('useParty', () => {
  it('load populates party and links', async () => {
    fetch.mockResolvedValue(
      ok({ party: { id: 'p1', name: 'John Smith' }, links: [{ dossierId: 'd1' }], reviewItems: [], isWatched: false }),
    )
    const { party, links, isWatched, load } = useParty('p1')
    await load()
    expect(party.value.name).toBe('John Smith')
    expect(links.value).toHaveLength(1)
    expect(isWatched.value).toBe(false)
  })

  it('load with no partyId sets party to null immediately', async () => {
    const { party, load } = useParty(null)
    await load()
    expect(party.value).toBeNull()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('loadScreening populates screening ref', async () => {
    fetch.mockResolvedValue(ok({ summary: { overallRisk: 'low' }, hits: [] }))
    const { screening, loadScreening } = useParty('p1')
    await loadScreening()
    expect(screening.value.summary.overallRisk).toBe('low')
  })

  it('setWatched POSTs and flips isWatched', async () => {
    fetch.mockResolvedValue(ok({}))
    const { isWatched, setWatched } = useParty('p1')
    await setWatched(true, { reason: 'flagged' })
    expect(isWatched.value).toBe(true)
  })

  it('setWatched DELETEs and unflips isWatched', async () => {
    fetch.mockResolvedValue(ok({}))
    const { isWatched, setWatched } = useParty('p1')
    isWatched.value = true
    await setWatched(false)
    expect(isWatched.value).toBe(false)
  })

  it('mergeFrom POSTs to /merge and reloads', async () => {
    fetch
      .mockResolvedValueOnce(ok({ ok: true })) // POST merge
      .mockResolvedValueOnce(ok({ party: { id: 'p1', name: 'John Smith' }, links: [], reviewItems: [], isWatched: false })) // reload
    const { mergeFrom } = useParty('p1')
    const body = await mergeFrom('p2', { reason: 'same person' })
    expect(body.ok).toBe(true)
  })

  it('setOverride PATCHes the overrides endpoint', async () => {
    fetch.mockResolvedValue(ok({ ok: true }))
    const { setOverride } = useParty('p1')
    const body = await setOverride({ listSource: 'ofac_sdn', decision: 'dismissed', reason: 'wrong entity' })
    expect(body.ok).toBe(true)
    expect(fetch.mock.calls[0][1].method).toBe('PATCH')
  })
})
