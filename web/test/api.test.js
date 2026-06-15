// Phase 2 — the window.fetch wrapper (CSRF attach, 403 invalid-csrf retry,
// 401 routing, passthrough). api.js binds rawFetch at import, so each test
// resets modules and re-imports after pointing window.fetch at a fresh mock.
import { describe, it, expect, vi, beforeEach } from 'vitest'

function makeRes(body, { ok = true, status = 200 } = {}) {
  const res = { ok, status, clone: () => makeRes(body, { ok, status }), json: () => Promise.resolve(body) }
  return res
}

let raw // the underlying mock api.js binds as rawFetch
let api // the re-imported module

async function load() {
  vi.resetModules()
  raw = vi.fn()
  window.fetch = raw
  api = await import('@/lib/api.js')
  api.installApiClient() // replaces window.fetch with the wrapper
}

// Route csrf requests automatically; the test configures the rest.
function routeCsrf(token = 'TOKEN1') {
  raw.mockImplementation((input) => {
    const url = typeof input === 'string' ? input : input?.url || ''
    if (url === '/api/auth/csrf') return Promise.resolve(makeRes({ csrfToken: token }))
    return Promise.resolve(makeRes({ ok: true }))
  })
}

beforeEach(load)

describe('api wrapper — passthrough', () => {
  it('passes non-/api requests straight through', async () => {
    raw.mockResolvedValue(makeRes({ ok: true }))
    await window.fetch('https://example.test/x')
    expect(raw).toHaveBeenCalledWith('https://example.test/x', {})
  })

  it('adds same-origin credentials and no CSRF header on a GET', async () => {
    raw.mockResolvedValue(makeRes({ ok: true }))
    await window.fetch('/api/dossiers')
    const [, opts] = raw.mock.calls.at(-1)
    expect(opts.credentials).toBe('same-origin')
    expect(opts.headers?.['x-csrf-token']).toBeUndefined()
  })
})

describe('api wrapper — CSRF', () => {
  it('fetches a token once and attaches it to a mutation', async () => {
    routeCsrf('TOKEN1')
    await window.fetch('/api/dossiers/123/decision', { method: 'POST' })
    const csrfCalls = raw.mock.calls.filter(([u]) => u === '/api/auth/csrf')
    expect(csrfCalls).toHaveLength(1)
    const target = raw.mock.calls.find(([u]) => u.includes('/decision'))
    expect(target[1].headers['x-csrf-token']).toBe('TOKEN1')
  })

  it('refreshes the token and retries once on invalid_csrf_token', async () => {
    let targetHits = 0
    raw.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input?.url || ''
      if (url === '/api/auth/csrf') return Promise.resolve(makeRes({ csrfToken: `T${targetHits}` }))
      targetHits += 1
      if (targetHits === 1) return Promise.resolve(makeRes({ error: 'invalid_csrf_token' }, { ok: false, status: 403 }))
      return Promise.resolve(makeRes({ ok: true }))
    })
    const res = await window.fetch('/api/x', { method: 'POST' })
    expect(res.ok).toBe(true)
    expect(targetHits).toBe(2) // retried once
  })

  it('does NOT retry a role-guard 403 (forbidden)', async () => {
    let targetHits = 0
    raw.mockImplementation((input) => {
      const url = typeof input === 'string' ? input : input?.url || ''
      if (url === '/api/auth/csrf') return Promise.resolve(makeRes({ csrfToken: 'T' }))
      targetHits += 1
      return Promise.resolve(makeRes({ error: 'forbidden' }, { ok: false, status: 403 }))
    })
    const res = await window.fetch('/api/admin', { method: 'POST' })
    expect(res.status).toBe(403)
    expect(targetHits).toBe(1) // not retried
  })
})

describe('api wrapper — 401 routing', () => {
  it('invokes the on401 handler for a non-auth 401', async () => {
    const on401 = vi.fn()
    api.setOn401(on401)
    raw.mockResolvedValue(makeRes({ error: 'unauthorized' }, { ok: false, status: 401 }))
    await window.fetch('/api/dossiers')
    expect(on401).toHaveBeenCalledOnce()
  })

  it('does not invoke on401 for an /api/auth/ 401', async () => {
    const on401 = vi.fn()
    api.setOn401(on401)
    raw.mockResolvedValue(makeRes({ error: 'invalid_credentials' }, { ok: false, status: 401 }))
    await window.fetch('/api/auth/login', { method: 'POST' })
    expect(on401).not.toHaveBeenCalled()
  })
})
