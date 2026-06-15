// Web test setup — global stubs for the jsdom environment. Phase 0.
//
// The app talks to the server through window.fetch (lib/api.js wraps it) and
// streams runs over EventSource. Neither exists in jsdom, so we provide
// deterministic stubs here. Individual tests override fetch with vi.fn() as
// needed; the EventSource stub is a no-op constructor that captures handlers so
// store/composable tests can drive SSE events synchronously.
import { vi, beforeEach } from 'vitest'

// Set a fetch stub at MODULE LOAD (before any test file's imports run), because
// lib/api.js binds `const rawFetch = window.fetch.bind(window)` at import time
// and jsdom ships no fetch. Tests override globalThis.fetch per-case.
if (!globalThis.fetch) globalThis.fetch = vi.fn(() => Promise.reject(new Error('fetch not mocked')))

// Default fetch: rejects loudly so a test that forgets to mock it fails fast
// rather than hanging on a real network call.
beforeEach(() => {
  if (!globalThis.fetch || !vi.isMockFunction(globalThis.fetch)) {
    globalThis.fetch = vi.fn(() => Promise.reject(new Error('fetch not mocked in this test')))
  } else {
    globalThis.fetch.mockReset()
  }
})

// Minimal EventSource stand-in — captures listeners and exposes emit() so tests
// can push scripted SSE events without a server.
class MockEventSource {
  constructor(url) {
    this.url = url
    this.listeners = {}
    this.readyState = 1
    MockEventSource.instances.push(this)
  }
  addEventListener(type, fn) {
    ;(this.listeners[type] ||= []).push(fn)
  }
  removeEventListener(type, fn) {
    this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn)
  }
  emit(type, data) {
    for (const fn of this.listeners[type] || []) fn({ data: JSON.stringify(data) })
  }
  close() {
    this.readyState = 2
  }
}
MockEventSource.instances = []
globalThis.EventSource = MockEventSource
