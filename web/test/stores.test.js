// Phase 2 — Pinia stores (decision drafts, health probe, dossier cache, auth).
import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'
import { useDecisionStore } from '@/stores/decision.js'
import { useHealthStore } from '@/stores/health.js'
import { useDossierStore } from '@/stores/dossier.js'
import { useAuthStore } from '@/stores/auth.js'

function jsonRes(body, { ok = true, status = 200 } = {}) {
  return { ok, status, json: () => Promise.resolve(body) }
}

beforeEach(() => setActivePinia(createPinia()))

describe('decision store', () => {
  it('lazily creates drafts per runId and patches them', () => {
    const s = useDecisionStore()
    s.setReject('r1', { reasonCode: 'sanctions_hit', freeText: 'long enough text' })
    expect(s.getDraft('r1', 'reject')).toMatchObject({ reasonCode: 'sanctions_hit' })
    s.setEscalate('r1', { notes: 'escalating' })
    expect(s.getDraft('r1', 'escalate').notes).toBe('escalating')
  })

  it('adds and removes request-info items but keeps at least one', () => {
    const s = useDecisionStore()
    s.addRequestInfoItem('r1')
    expect(s.getDraft('r1', 'request_info').items).toHaveLength(2)
    s.setRequestInfoItem('r1', 1, { description: 'passport', category: 'id' })
    expect(s.getDraft('r1', 'request_info').items[1].category).toBe('id')
    s.removeRequestInfoItem('r1', 1)
    expect(s.getDraft('r1', 'request_info').items).toHaveLength(1)
    s.removeRequestInfoItem('r1', 0) // refuses to drop the last one
    expect(s.getDraft('r1', 'request_info').items).toHaveLength(1)
  })

  it('tracks the open action and clears everything for a run', () => {
    const s = useDecisionStore()
    s.setOpenAction('r1', 'reject')
    expect(s.getOpenAction('r1')).toBe('reject')
    s.setReject('r1', { freeText: 'x' })
    s.clearAll('r1')
    expect(s.getOpenAction('r1')).toBeNull()
    expect(s.drafts.r1).toBeUndefined()
  })

  it('ignores operations with no runId', () => {
    const s = useDecisionStore()
    expect(s.getDraft(null, 'reject')).toBeNull()
    expect(s.getOpenAction(null)).toBeNull()
    s.setReject(null, { freeText: 'x' }) // no-op, no throw
  })
})

describe('health store', () => {
  afterEach(() => vi.useRealTimers())

  it('reports ok when the probe succeeds with all models present', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({ ok: true, ollama: { ok: true, missing: [] } }))
    const s = useHealthStore()
    await s.check()
    expect(s.status).toBe('ok')
    expect(s.statusLabel).toBe('Ollama online')
  })

  it('reports degraded when models are missing', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({ ok: true, ollama: { ok: false, missing: ['glm-ocr'], reason: 'missing' } }))
    const s = useHealthStore()
    await s.check()
    expect(s.status).toBe('degraded')
    expect(s.lastError).toBe('missing')
  })

  it('reports down when the request throws', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const s = useHealthStore()
    await s.check()
    expect(s.status).toBe('down')
    expect(s.statusLabel).toBe('Ollama offline')
  })

  it('starts a single poll timer and stops it', async () => {
    vi.useFakeTimers()
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({ ok: true, ollama: { ok: true } }))
    const s = useHealthStore()
    s.start()
    s.start() // idempotent — no second timer
    await vi.advanceTimersByTimeAsync(15_000)
    s.stop()
    expect(globalThis.fetch.mock.calls.length).toBeGreaterThanOrEqual(2)
  })

  it('is unknown before the first probe', () => {
    expect(useHealthStore().status).toBe('unknown')
  })
})

describe('dossier store', () => {
  it('fetches once and serves from cache, deduping concurrent calls', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({ companyNumber: '123', tags: [] }))
    const s = useDossierStore()
    const [a, b] = await Promise.all([s.fetchOne('123'), s.fetchOne('123')])
    expect(a).toEqual(b)
    expect(globalThis.fetch).toHaveBeenCalledTimes(1) // deduped + cached
    await s.fetchOne('123') // served from cache
    expect(globalThis.fetch).toHaveBeenCalledTimes(1)
  })

  it('records a 404 as not_found', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({}, { ok: false, status: 404 }))
    const s = useDossierStore()
    expect(await s.fetchOne('404')).toBeNull()
    expect(s.byCompanyNumber['404'].error).toBe('not_found')
  })

  it('captures a non-404 error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({}, { ok: false, status: 500 }))
    const s = useDossierStore()
    await s.fetchOne('500')
    expect(s.byCompanyNumber['500'].error).toMatch(/500/)
  })

  it('patches and merges, preserving the prior runs array', async () => {
    const s = useDossierStore()
    s.ensureEntry('123').dossier = { companyNumber: '123', runs: [{ id: 'r1' }], tags: [] }
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({ companyNumber: '123', tags: ['monitor'] }))
    const updated = await s.patch('123', { tags: ['monitor'] })
    expect(updated.tags).toEqual(['monitor'])
    expect(updated.runs).toEqual([{ id: 'r1' }]) // preserved
  })

  it('applies optimistic local tag/notes edits and invalidates', () => {
    const s = useDossierStore()
    s.ensureEntry('123').dossier = { companyNumber: '123', tags: [] }
    s.setLocalTags('123', ['cleared'])
    s.setLocalNotes('123', 'a note')
    expect(s.byCompanyNumber['123'].dossier).toMatchObject({ tags: ['cleared'], notes: 'a note' })
    s.invalidate('123')
    expect(s.byCompanyNumber['123'].dossier).toBeNull()
  })
})

describe('auth store', () => {
  it('fetchMe populates the user on 200 and clears on failure', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({ user: { username: 'ana', role: 'analyst' } }))
    const s = useAuthStore()
    await s.fetchMe()
    expect(s.isAuthenticated).toBe(true)
    expect(s.username).toBe('ana')
    expect(s.ready).toBe(true)
  })

  it('hasRole is hierarchy-aware', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({ user: { username: 'rev', role: 'reviewer' } }))
    const s = useAuthStore()
    await s.fetchMe()
    expect(s.hasRole('analyst')).toBe(true)
    expect(s.hasRole('reviewer')).toBe(true)
    expect(s.hasRole('admin')).toBe(false)
  })

  it('login throws a friendly message on invalid credentials', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({ error: 'invalid_credentials' }, { ok: false, status: 401 }))
    const s = useAuthStore()
    await expect(s.login('x', 'y')).rejects.toThrow(/Invalid username or password/)
  })

  it('login stores the user on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({ user: { username: 'ana', role: 'analyst' } }))
    const s = useAuthStore()
    await s.login('ana', 'pw')
    expect(s.user.username).toBe('ana')
  })

  it('logout clears the user even if the request fails', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('network'))
    const s = useAuthStore()
    s.user = { username: 'ana' }
    await s.logout()
    expect(s.user).toBeNull()
  })

  it('changePassword surfaces a wrong-password error', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({ error: 'wrong_current_password' }, { ok: false, status: 400 }))
    const s = useAuthStore()
    await expect(s.changePassword({ currentPassword: 'a', newPassword: 'b' })).rejects.toThrow(/Current password is incorrect/)
  })

  it('changePassword resolves true on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({ ok: true }))
    const s = useAuthStore()
    await expect(s.changePassword({ currentPassword: 'a', newPassword: 'bbbbbbbb' })).resolves.toBe(true)
  })

  it('login maps too_many_attempts to a friendly message', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({ error: 'too_many_attempts' }, { ok: false, status: 429 }))
    const s = useAuthStore()
    await expect(s.login('x', 'y')).rejects.toThrow(/Too many attempts/)
  })

  it('updateProfile sets the user on success', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({ user: { username: 'ana2', role: 'analyst', displayName: 'Ana Two' } }))
    const s = useAuthStore()
    await s.updateProfile({ displayName: 'Ana Two' })
    expect(s.displayName).toBe('Ana Two')
  })

  it('updateProfile maps a conflict to a field-specific message', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({ error: 'conflict', field: 'username' }, { ok: false, status: 409 }))
    const s = useAuthStore()
    await expect(s.updateProfile({ username: 'taken' })).rejects.toThrow(/username is already taken/)
  })

  it('fetchMe clears the user on a non-ok response', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(jsonRes({}, { ok: false, status: 401 }))
    const s = useAuthStore()
    await s.fetchMe()
    expect(s.isAuthenticated).toBe(false)
    expect(s.ready).toBe(true)
  })
})
