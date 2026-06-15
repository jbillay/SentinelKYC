// Phase 5b — Composables that depend on Pinia stores or vue-router.
//
// Covered: useDossier, useRun, useScreening (subjectGroups + setOverride),
//          useRefresh.
//
// Pattern: mock vue-router to supply a no-op push; activate a fresh Pinia so
// the stores start clean. For composables that call useRouter() or useXxxStore()
// we mount a minimal component stub and call the composable inside setup().
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { ref } from 'vue'

// ── Router mock (must be before the imports that pull vue-router) ───────────
const mockPush = vi.fn()
vi.mock('vue-router', () => ({
  useRouter: () => ({ push: mockPush }),
}))

import { useDossier } from '@/composables/useDossier.js'
import { useRun } from '@/composables/useRun.js'
import { useScreening } from '@/composables/useScreening.js'
import { useRefresh } from '@/composables/useRefresh.js'
import { useDossierStore } from '@/stores/dossier.js'
import { useAgentStore } from '@/stores/agent.js'

function ok(body) {
  return { ok: true, status: 200, json: () => Promise.resolve(body) }
}
function fail(body, status = 400) {
  return { ok: false, status, json: () => Promise.resolve(body) }
}

/** Mount a tiny wrapper that runs the composable and captures the result. */
function withSetup(fn) {
  let result
  mount(
    {
      setup() {
        result = fn()
        return () => null
      },
      template: '<div/>',
    },
    { global: { plugins: [createPinia()] } },
  )
  return result
}

beforeEach(() => {
  setActivePinia(createPinia())
  globalThis.fetch = vi.fn()
  mockPush.mockClear()
})

// ─── useDossier ───────────────────────────────────────────────────────────────

describe('useDossier', () => {
  it('reads dossier from the store', async () => {
    // Pre-seed the store so the watch trigger resolves immediately.
    fetch.mockResolvedValue(
      ok({
        id: 'd1',
        companyNumber: '01234567',
        companyName: 'ACME',
        tags: [],
        notes: null,
        runs: [],
        caseStatus: 'pending',
      }),
    )
    const result = withSetup(() => useDossier('01234567'))
    // loading is true initially then resolves after the fetch
    expect(result).toBeTruthy()
    expect(typeof result.dossier).toBe('object')
  })

  it('toggleTag adds a tag that was absent', () => {
    const result = withSetup(() => useDossier('01234567'))
    const store = useDossierStore()
    // Seed a minimal entry so the store doesn't null-pointer.
    store.byCompanyNumber['01234567'] = {
      dossier: { tags: [], notes: null },
      loading: false,
      error: null,
      saving: false,
      inflight: null,
    }
    fetch.mockResolvedValue(ok({ tags: ['escalate'] }))
    result.toggleTag('escalate') // must be in ALLOWED_TAGS = ['escalate', 'cleared', 'monitor']
    expect(store.byCompanyNumber['01234567'].dossier.tags).toContain('escalate')
  })

  it('toggleTag removes a tag that was present', () => {
    const result = withSetup(() => useDossier('01234567'))
    const store = useDossierStore()
    store.byCompanyNumber['01234567'] = {
      dossier: { tags: ['escalate'], notes: null },
      loading: false,
      error: null,
      saving: false,
      inflight: null,
    }
    fetch.mockResolvedValue(ok({ tags: [] }))
    result.toggleTag('escalate')
    expect(store.byCompanyNumber['01234567'].dossier.tags).not.toContain('escalate')
  })

  it('setNotes updates the store immediately (optimistic)', () => {
    const result = withSetup(() => useDossier('01234567'))
    const store = useDossierStore()
    store.byCompanyNumber['01234567'] = {
      dossier: { tags: [], notes: '' },
      loading: false,
      error: null,
      saving: false,
      inflight: null,
    }
    fetch.mockResolvedValue(ok({}))
    result.setNotes('some notes')
    expect(store.byCompanyNumber['01234567'].dossier.notes).toBe('some notes')
  })
})

// ─── useRun ───────────────────────────────────────────────────────────────────
// useRun has a watch({ immediate: true }) that calls store.attach(id), which
// creates a slice and sets phase='running'. We suppress attach() so tests can
// control store.runs themselves.

describe('useRun', () => {
  it('returns null slice for an unknown threadId', () => {
    const threadId = ref('unknown-thread')
    const result = withSetup(() => {
      const store = useAgentStore()
      vi.spyOn(store, 'attach').mockImplementation(() => {})
      return useRun(threadId)
    })
    expect(result.slice.value).toBeNull()
  })

  it('computes phase as idle when no slice exists', () => {
    const threadId = ref('t1')
    const result = withSetup(() => {
      const store = useAgentStore()
      vi.spyOn(store, 'attach').mockImplementation(() => {})
      return useRun(threadId)
    })
    expect(result.phase.value).toBe('idle')
  })

  it('computes isRunning for running phases', () => {
    const threadId = ref('t2')
    let capturedStore
    const result = withSetup(() => {
      capturedStore = useAgentStore()
      vi.spyOn(capturedStore, 'attach').mockImplementation(() => {})
      return useRun(threadId)
    })
    capturedStore.runs['t2'] = { phase: 'running', _source: {} }
    expect(result.isRunning.value).toBe(true)
  })

  it('computes isRunning false for terminal phases', () => {
    const threadId = ref('t3')
    let capturedStore
    const result = withSetup(() => {
      capturedStore = useAgentStore()
      vi.spyOn(capturedStore, 'attach').mockImplementation(() => {})
      return useRun(threadId)
    })
    capturedStore.runs['t3'] = { phase: 'done', _source: null }
    expect(result.isRunning.value).toBe(false)
  })

  it('subjectName returns "New search" when no slice is present', () => {
    const threadId = ref('none')
    const result = withSetup(() => {
      const store = useAgentStore()
      vi.spyOn(store, 'attach').mockImplementation(() => {})
      return useRun(threadId)
    })
    expect(result.subjectName.value).toBe('New search')
  })
})

// ─── useScreening (computed layer only — no vue-router calls needed) ──────────

describe('useScreening — subjectGroups computed', () => {
  it('effectiveDecision prefers humanOverride over decision', async () => {
    // We test via subjectGroups: seed hits/evals and check the computed shape.
    const cn = ref('01234567')
    const rid = ref('run-1')

    const screeningData = {
      report: {
        perSubject: [
          {
            subjectId: 's1',
            name: 'John Smith',
            kind: 'individual',
            source: 'officers',
            worstStatus: 'confirmed',
            hits: [],
          },
        ],
      },
      hits: [
        {
          id: 'h1',
          subjectId: 's1',
          subjectName: 'John Smith',
          subjectKind: 'individual',
          subjectSource: 'officers',
        },
      ],
      evaluations: [
        {
          hitId: 'h1',
          decision: 'needs_review',
          humanOverride: 'dismissed',
          overrideReason: 'wrong entity',
        },
      ],
    }
    fetch.mockResolvedValue(ok(screeningData))

    const result = withSetup(() => useScreening(cn, rid))
    await new Promise((r) => setTimeout(r, 10))

    const groups = result.subjectGroups.value
    expect(groups).toHaveLength(1)
    expect(groups[0].hits[0].effective).toBe('dismissed')
  })

  it('sorts subjects so confirmed > needs_review > dismissed', async () => {
    const cn = ref('01234567')
    const rid = ref('run-2')

    const screeningData = {
      report: {
        perSubject: [
          { subjectId: 'sb', name: 'B', kind: 'individual', source: 'officers', worstStatus: 'dismissed', hits: [] },
          { subjectId: 'sa', name: 'A', kind: 'individual', source: 'officers', worstStatus: 'confirmed', hits: [] },
        ],
      },
      hits: [
        { id: 'h-a', subjectId: 'sa', subjectName: 'A', subjectKind: 'individual', subjectSource: 'officers' },
        { id: 'h-b', subjectId: 'sb', subjectName: 'B', subjectKind: 'individual', subjectSource: 'officers' },
      ],
      evaluations: [],
    }
    fetch.mockResolvedValue(ok(screeningData))

    const result = withSetup(() => useScreening(cn, rid))
    await new Promise((r) => setTimeout(r, 10))

    const groups = result.subjectGroups.value
    expect(groups[0].subjectId).toBe('sa') // confirmed first
    expect(groups[1].subjectId).toBe('sb') // dismissed second
  })

  it('setOverride rolls back on PATCH failure', async () => {
    const cn = ref('01234567')
    const rid = ref('run-3')

    fetch
      .mockResolvedValueOnce(
        ok({
          report: null,
          hits: [{ id: 'h1', subjectId: 's1' }],
          evaluations: [{ hitId: 'h1', decision: 'needs_review', humanOverride: null }],
        }),
      )
      .mockResolvedValueOnce(fail({ error: 'server error' }, 500))

    const result = withSetup(() => useScreening(cn, rid))
    await new Promise((r) => setTimeout(r, 10))

    const before = result.evaluations.value[0]?.humanOverride
    await expect(result.setOverride('h1', 'confirmed')).rejects.toBeTruthy()
    // humanOverride must be rolled back to the prior value
    expect(result.evaluations.value[0]?.humanOverride).toBe(before ?? null)
  })
})

// ─── useRefresh ───────────────────────────────────────────────────────────────

describe('useRefresh', () => {
  it('refresh navigates to the new run on success', async () => {
    fetch.mockResolvedValue(ok({ threadId: 'new-thread' }))
    const result = withSetup(() => useRefresh())
    await result.refresh('01234567', { companyName: 'ACME' })
    expect(mockPush).toHaveBeenCalledWith({ name: 'run', params: { threadId: 'new-thread' } })
  })

  it('refresh throws on non-ok response', async () => {
    fetch.mockResolvedValue(fail({}, 409))
    const result = withSetup(() => useRefresh())
    await expect(result.refresh('01234567')).rejects.toThrow(/409/)
  })

  it('resumeFailed navigates to the resumed thread', async () => {
    fetch.mockResolvedValue(ok({ threadId: 'resumed-thread' }))
    const result = withSetup(() => useRefresh())
    await result.resumeFailed('01234567', 'run-1', { companyName: 'ACME' })
    expect(mockPush).toHaveBeenCalledWith({ name: 'run', params: { threadId: 'resumed-thread' } })
  })

  it('resumeFailed throws on non-ok response', async () => {
    fetch.mockResolvedValue(fail({}, 400))
    const result = withSetup(() => useRefresh())
    await expect(result.resumeFailed('01234567', 'run-1')).rejects.toThrow(/400/)
  })
})
