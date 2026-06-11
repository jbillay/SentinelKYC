// R1 — API client wrapper.
//
// The app makes ~all data calls via raw `fetch('/api/...')` (Vite proxies
// /api → :3000, so requests are same-origin and the session cookie rides along
// automatically). Cookie auth adds one requirement: state-changing requests
// need a CSRF token. Rather than touch every call site, we wrap window.fetch
// once so every /api mutation transparently:
//   - sends credentials (same-origin cookie),
//   - attaches the x-csrf-token header,
//   - refreshes the token + retries once on a 403 (the token rotates when the
//     session is regenerated at login),
//   - routes a 401 to the sign-in handler.
//
// EventSource (SSE) is unaffected — it sends the cookie itself.

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS'])
const rawFetch = window.fetch.bind(window)

let csrfToken = null
let on401 = null

function urlOf(input) {
  return typeof input === 'string' ? input : (input && input.url) || ''
}

async function fetchCsrf() {
  try {
    const res = await rawFetch('/api/auth/csrf', { credentials: 'same-origin' })
    if (!res.ok) return null
    const j = await res.json()
    csrfToken = j.csrfToken || null
  } catch {
    csrfToken = null
  }
  return csrfToken
}

async function ensureCsrf() {
  if (csrfToken) return csrfToken
  return fetchCsrf()
}

// Called by the auth store after login/logout — the session (and thus the CSRF
// token) is regenerated, so the cached token must be dropped.
export function resetCsrf() {
  csrfToken = null
}

export function setOn401(fn) {
  on401 = fn
}

export function installApiClient() {
  window.fetch = async (input, init = {}) => {
    const url = urlOf(input)
    if (!url.startsWith('/api')) return rawFetch(input, init)

    const method = (init.method || 'GET').toUpperCase()
    const opts = { ...init, credentials: init.credentials || 'same-origin' }

    if (!SAFE.has(method)) {
      const t = await ensureCsrf()
      opts.headers = { ...init.headers, ...(t ? { 'x-csrf-token': t } : {}) }
    }

    let res = await rawFetch(input, opts)

    // Stale CSRF (e.g. first mutation after login regenerated the session) —
    // refresh once and retry. ONLY for invalid_csrf_token: a role-guard 403
    // ({error:'forbidden'}) must not double-fire the mutation. The body is
    // read from a clone so the caller can still consume the original.
    if (res.status === 403 && !SAFE.has(method)) {
      let isCsrf = false
      try {
        const j = await res.clone().json()
        isCsrf = j?.error === 'invalid_csrf_token'
      } catch {
        /* non-JSON 403 — not ours */
      }
      if (isCsrf) {
        resetCsrf()
        const t = await ensureCsrf()
        if (t) {
          opts.headers = { ...init.headers, 'x-csrf-token': t }
          res = await rawFetch(input, opts)
        }
      }
    }

    if (res.status === 401 && !url.includes('/api/auth/') && typeof on401 === 'function') {
      on401()
    }

    return res
  }
}
