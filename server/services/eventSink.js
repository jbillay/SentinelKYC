const { log } = require('./log');
// R2 — EventSink abstraction.
//
// The SSE runtime emits events through `registry.pushEvent`. Where those events
// go depends on the execution mode:
//
//  - InMemorySink (RUN_EXECUTION=inline, the default): exactly today's
//    behaviour — append to the per-thread in-memory buffer (capped) and write
//    straight to the live `res` if a browser is connected in THIS process. Zero
//    DB cost; the run and the SSE handler share a process.
//
//  - NotifySink (RUN_EXECUTION=queue, worker process): the run executes in the
//    worker, which has no browser connection. Each event is appended to the
//    durable `run_events` table (in per-thread `seq` order) and a single
//    `NOTIFY run_events '<threadId>'` is fired per flush. The web process's
//    runEventsBus LISTENs and replays the tail to connected browsers. This is
//    what carries events across the process boundary and makes replay survive a
//    web restart.
//
// The registry holds exactly one sink (set once at boot). Both sinks are given
// the registry's per-thread state object `t` so InMemorySink can reach the
// buffer + live res without the runtime knowing which sink is installed.

const MAX_BUFFERED_EVENTS = 2000;

// In-process sink: buffer + live res. Mirrors the original registry.pushEvent.
class InMemorySink {
  // eslint-disable-next-line class-methods-use-this
  async initThread() {
    // no-op: in-memory threads need no seq seeding.
  }

  // eslint-disable-next-line class-methods-use-this
  write(_threadId, t, event) {
    t.events.push(event);
    if (t.events.length > MAX_BUFFERED_EVENTS) {
      t.events.splice(0, t.events.length - MAX_BUFFERED_EVENTS);
    }
    if (t.sseRes) {
      try {
        t.sseRes.write(`data: ${JSON.stringify(event)}\n\n`);
      } catch (err) {
        log.warn(`[sse write] ${err.message}`);
        t.sseRes = null;
      }
    }
  }

  // eslint-disable-next-line class-methods-use-this
  async drain() {
    // no-op: writes are synchronous.
  }
}

// Cross-process sink: durable append to run_events + NOTIFY. Per-thread `seq`
// is assigned synchronously on write so call-order is preserved; a per-thread
// async flusher serialises the inserts (so committed rows are gap-free in seq
// order) and fires one NOTIFY per flush. drain() awaits the in-flight flush so
// the worker can guarantee the terminal event is persisted before completing
// the job.
class NotifySink {
  constructor({ repo, pool, channel = 'run_events' }) {
    if (!repo || !pool) throw new Error('NotifySink: repo and pool are required');
    this.repo = repo;
    this.pool = pool;
    this.channel = channel;
    this.threads = new Map(); // threadId -> { seq, pending, flushing }
  }

  // Per-append retry ladder. In queue mode run_events IS the SSE stream:
  // dropping a terminal event (done/cancelled/interrupt) wedges the run's UI
  // state permanently — getThreadStreamState would forever report it as
  // running. So failed appends are retried, kept at the head of `pending`,
  // and ultimately surfaced through drain() instead of being logged away.
  // See CODE_REVIEW §4.3.
  static get APPEND_RETRY_DELAYS_MS() {
    return [250, 1000, 3000];
  }

  _state(threadId) {
    let s = this.threads.get(threadId);
    if (!s) {
      s = { seq: 0, pending: [], flushing: null, seeded: false, lastFlushError: null };
      this.threads.set(threadId, s);
    }
    return s;
  }

  // Seed the seq counter from the durable tail so a resumed/retried job
  // continues the stream instead of colliding on (thread_id, seq).
  async initThread(threadId) {
    const s = this._state(threadId);
    if (s.seeded) return;
    const maxSeq = await this.repo.getMaxRunEventSeq(threadId);
    s.seq = maxSeq + 1;
    s.seeded = true;
  }

  write(threadId, _t, event) {
    const s = this._state(threadId);
    const seq = s.seq++;
    s.pending.push({ seq, event });
    this._kick(threadId, s);
  }

  async _appendWithRetry(threadId, seq, event) {
    let lastErr = null;
    const attempts = [0, ...NotifySink.APPEND_RETRY_DELAYS_MS];
    for (const delay of attempts) {
      if (delay > 0) await new Promise((r) => setTimeout(r, delay));
      try {
        await this.repo.appendRunEvent({ threadId, seq, payload: event });
        return;
      } catch (err) {
        lastErr = err;
      }
    }
    throw lastErr;
  }

  _kick(threadId, s) {
    if (s.flushing) return;
    s.flushing = (async () => {
      try {
        while (s.pending.length) {
          const batch = s.pending.splice(0, s.pending.length);
          let wrote = 0;
          for (let i = 0; i < batch.length; i++) {
            const { seq, event } = batch[i];
            try {
              await this._appendWithRetry(threadId, seq, event);
              wrote += 1;
              s.lastFlushError = null;
            } catch (err) {
              // Out of retries: put this event and everything after it back at
              // the head of pending (seq order preserved) and stop flushing.
              // drain() retries / surfaces the failure.
              log.error(`[NotifySink] appendRunEvent failed after retries (seq=${seq}): ${err.message}`);
              s.lastFlushError = err;
              s.pending.unshift(...batch.slice(i));
              return;
            }
          }
          if (wrote > 0) {
            try {
              await this.pool.query('SELECT pg_notify($1, $2)', [this.channel, threadId]);
            } catch (err) {
              // NOTIFY loss is recoverable — the bus replays from the cursor on
              // the next notification or reconnect.
              log.error(`[NotifySink] pg_notify failed: ${err.message}`);
            }
          }
        }
      } finally {
        s.flushing = null;
      }
    })();
  }

  // Await full delivery of a thread's events. Throws if events remain
  // unpersisted after the retry budget — callers (worker job handler) must
  // fail loudly rather than completing a job whose terminal event is lost.
  async drain(threadId, { maxCycles = 3 } = {}) {
    const s = this.threads.get(threadId);
    if (!s) return;
    let cycles = 0;
    // Loop: more events can be queued while we await the current flush.
    while (s.flushing || s.pending.length) {
      if (!s.flushing) {
        if (s.lastFlushError) {
          cycles += 1;
          if (cycles > maxCycles) {
            const err = new Error(
              `NotifySink: ${s.pending.length} event(s) for thread ${threadId} could not be persisted: ${s.lastFlushError.message}`,
            );
            err.code = 'RUN_EVENTS_PERSIST_FAILED';
            throw err;
          }
          await new Promise((r) => setTimeout(r, 1000 * cycles));
        }
        this._kick(threadId, s);
      }
      // eslint-disable-next-line no-await-in-loop
      await s.flushing;
    }
  }

  // Drop a thread's bookkeeping once its run has reached a terminus and drained.
  forget(threadId) {
    this.threads.delete(threadId);
  }
}

module.exports = { InMemorySink, NotifySink, MAX_BUFFERED_EVENTS };
