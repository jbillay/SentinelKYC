// Phase S4 — SSE runtime + event-sink unit tests.
//
// Tests the InMemorySink and RunRegistry in isolation — no DB, no HTTP.
// We import the classes directly and exercise:
//   - InMemorySink.write: buffers events, forwards to live sseRes, caps at MAX
//   - InMemorySink.drain: no-op (synchronous sink)
//   - RunRegistry.ensure / has / get / delete: thread lifecycle
//   - RunRegistry.pushEvent: delegates to the installed sink
//   - RunRegistry.setSink: swaps sink at runtime
//   - RunRegistry.activeSnapshot: phase/interrupt state projection
//   - RunRegistry.scheduleGc: sets a timer (we just check the timer is set and
//     then cancel it so the test process can exit cleanly)

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'node:module';

// ─── mock DB (runtime.js imports repo for persistence) ───────────────────────

vi.mock('../db/repo', () => ({
  upsertDossier: vi.fn(async () => ({ id: 'dossier-1', companyNumber: '01234567' })),
  createRun: vi.fn(async () => ({ id: 'run-1' })),
  appendFragmentsBatch: vi.fn(async () => {}),
  appendFragment: vi.fn(async () => {}),
  setRunWorker: vi.fn(async () => {}),
  closeRun: vi.fn(async () => {}),
  findPartyById: vi.fn(async () => null),
}));

// ─── mock screening report builder ───────────────────────────────────────────

vi.mock('../services/screening/report', () => ({
  buildScreeningReport: vi.fn(() => ({ summary: { subjectCount: 0, overallRisk: 'low' }, perSubject: [] })),
}));

// ─── mock log so we don't get console noise ───────────────────────────────────

vi.mock('../services/log', () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

// ─── mock @langchain/langgraph (runtime imports Command) ─────────────────────

vi.mock('@langchain/langgraph', () => ({ Command: class Command { constructor(p) { this.payload = p; } } }));

const require = createRequire(import.meta.url);
const { InMemorySink, MAX_BUFFERED_EVENTS } = require('../services/eventSink.js');
const { RunRegistry } = require('../sse/runtime.js');

// ─── InMemorySink ──────────────────────────────────────────────────────────────

describe('InMemorySink', () => {
  let sink;

  beforeEach(() => {
    sink = new InMemorySink();
  });

  it('appends events to the thread buffer', () => {
    const t = { events: [], sseRes: null };
    const evt = { type: 'trace', node: 'test', msg: 'hello', ts: 1 };
    sink.write('thread-1', t, evt);
    expect(t.events).toHaveLength(1);
    expect(t.events[0]).toBe(evt);
  });

  it('caps the buffer at MAX_BUFFERED_EVENTS', () => {
    const t = { events: [], sseRes: null };
    const total = MAX_BUFFERED_EVENTS + 50;
    for (let i = 0; i < total; i++) {
      sink.write('thread-1', t, { type: 'trace', i });
    }
    expect(t.events.length).toBe(MAX_BUFFERED_EVENTS);
    // Oldest events were dropped — last event is the most recent
    expect(t.events.at(-1).i).toBe(total - 1);
  });

  it('writes to sseRes when connected', () => {
    const written = [];
    const t = {
      events: [],
      sseRes: { write: (chunk) => written.push(chunk) },
    };
    sink.write('thread-2', t, { type: 'trace', msg: 'hi' });
    expect(written.length).toBe(1);
    expect(written[0]).toContain('"type":"trace"');
  });

  it('clears sseRes when write throws', () => {
    const t = {
      events: [],
      sseRes: { write: () => { throw new Error('EPIPE'); } },
    };
    sink.write('thread-3', t, { type: 'done' });
    expect(t.sseRes).toBeNull();
    expect(t.events).toHaveLength(1); // still buffered
  });

  it('drain() resolves immediately (synchronous sink)', async () => {
    await expect(sink.drain('thread-4')).resolves.toBeUndefined();
  });

  it('initThread() resolves immediately (no-op)', async () => {
    await expect(sink.initThread('thread-5')).resolves.toBeUndefined();
  });
});

// ─── RunRegistry ──────────────────────────────────────────────────────────────

describe('RunRegistry', () => {
  let registry;

  beforeEach(() => {
    registry = new RunRegistry();
  });

  afterEach(() => {
    // Cancel any GC timers to let the test process exit cleanly.
    for (const [, t] of registry.entries()) {
      if (t.gcTimer) clearTimeout(t.gcTimer);
    }
  });

  it('ensure() creates a new thread on first call', () => {
    expect(registry.has('t1')).toBe(false);
    const t = registry.ensure('t1');
    expect(t).toBeTruthy();
    expect(registry.has('t1')).toBe(true);
  });

  it('ensure() returns the same object on subsequent calls', () => {
    const a = registry.ensure('t2');
    const b = registry.ensure('t2');
    expect(a).toBe(b);
  });

  it('get() returns null for unknown thread', () => {
    expect(registry.get('no-such-thread')).toBeNull();
  });

  it('delete() removes the thread', () => {
    registry.ensure('t3');
    registry.delete('t3');
    expect(registry.has('t3')).toBe(false);
    expect(registry.get('t3')).toBeNull();
  });

  it('pushEvent() appends event to thread buffer via InMemorySink', () => {
    const t = registry.ensure('t4');
    registry.pushEvent('t4', { type: 'trace', msg: 'pushed' });
    expect(t.events).toHaveLength(1);
    expect(t.events[0].type).toBe('trace');
  });

  it('setSink() swaps the sink', () => {
    const written = [];
    const fakeSink = {
      write: (_tid, _t, ev) => written.push(ev),
      drain: async () => {},
      initThread: async () => {},
    };
    registry.setSink(fakeSink);
    registry.pushEvent('t5', { type: 'done' });
    expect(written).toHaveLength(1);
    expect(written[0].type).toBe('done');
  });

  it('activeSnapshot() returns empty array when no active threads', () => {
    expect(registry.activeSnapshot()).toEqual([]);
  });

  it('activeSnapshot() includes running threads with phase=running', () => {
    const t = registry.ensure('t6');
    t.companyNumber = '01234567';
    t.companyName = 'ACME LTD';
    t.trigger = 'initial';
    const snap = registry.activeSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].threadId).toBe('t6');
    expect(snap[0].phase).toBe('running');
  });

  it('activeSnapshot() excludes cancelled threads', () => {
    const t = registry.ensure('t7');
    t.cancelled = true;
    expect(registry.activeSnapshot()).toHaveLength(0);
  });

  it('activeSnapshot() excludes runClosed threads', () => {
    const t = registry.ensure('t8');
    t.runClosed = true;
    expect(registry.activeSnapshot()).toHaveLength(0);
  });

  it('activeSnapshot() marks interrupted thread with needs_user_pick', () => {
    const t = registry.ensure('t9');
    t.interrupted = true;
    t.interruptKind = 'entity_selection';
    t.latestState = { candidates: [{ title: 'ACME', companyNumber: '01234567' }] };
    const snap = registry.activeSnapshot();
    expect(snap[0].phase).toBe('needs_user_pick');
    expect(snap[0].candidates).toHaveLength(1);
  });

  it('activeSnapshot() marks awaiting_decision with runId/qaResult', () => {
    const t = registry.ensure('t10');
    t.interrupted = true;
    t.interruptKind = 'final_decision';
    t.runId = 'run-final';
    t.latestState = {
      qaResult: { routing: { caseStatus: 'streamlined_review' } },
      kycCard: { identity: { name: 'ACME' } },
    };
    const snap = registry.activeSnapshot();
    expect(snap[0].phase).toBe('awaiting_decision');
    expect(snap[0].runId).toBe('run-final');
    expect(snap[0].qaResult).toBeTruthy();
  });

  it('scheduleGc() sets gcTimer on the thread', () => {
    const t = registry.ensure('t11');
    registry.scheduleGc('t11', 60_000);
    expect(t.gcTimer).toBeTruthy();
    clearTimeout(t.gcTimer);
    t.gcTimer = null;
  });

  it('scheduleGc() clears previous timer when called twice', () => {
    const t = registry.ensure('t12');
    registry.scheduleGc('t12', 60_000);
    const first = t.gcTimer;
    registry.scheduleGc('t12', 60_000);
    // The first timer was cleared; a new one was set
    expect(t.gcTimer).not.toBe(first);
    clearTimeout(t.gcTimer);
    t.gcTimer = null;
  });

  it('entries() iterates all threads', () => {
    registry.ensure('ta');
    registry.ensure('tb');
    const ids = [...registry.entries()].map(([id]) => id);
    expect(ids).toContain('ta');
    expect(ids).toContain('tb');
  });
});
