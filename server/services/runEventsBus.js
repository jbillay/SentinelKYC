// R2 — web-side run-event bus (the read half of the cross-process transport).
//
// In queue mode the worker appends every SSE event to `run_events` and fires
// `NOTIFY run_events '<threadId>'`. This module is the web process's side: a
// single long-lived LISTEN connection that fans NOTIFYs out to the connected
// browser streams, replaying each subscriber's tail from `run_events`.
//
// Why a dedicated connection: LISTEN ties up its connection for the lifetime of
// the subscription, so it must not come from the shared request pool. One
// listener per web process multiplexes every thread by name.
//
// Ordering / no-miss guarantee: a subscriber is registered BEFORE its initial
// tail replay, and every delivery goes through the same serialised `_pump`
// (cursor = last seq written). So a NOTIFY that races the initial replay just
// marks the pump dirty and re-runs — no event is skipped or duplicated, whether
// it arrived via replay or live. The same `_pump` therefore handles both
// reconnect-replay and live streaming with one code path.

const { Client } = require('pg');
const repo = require('../db/repo');
const { log } = require('./log');

const CHANNEL = 'run_events';
const RECONNECT_DELAY_MS = 1000;

class RunEventsBus {
  constructor() {
    this.subs = new Map(); // threadId -> Set<sub>
    this.client = null;
    this.started = false;
    this.connected = false;
    this._reconnectTimer = null;
  }

  async start() {
    if (this.started) return;
    this.started = true;
    await this._connect();
  }

  async _connect() {
    if (!process.env.DATABASE_URL) {
      log.error('[runEventsBus] DATABASE_URL missing — cannot LISTEN');
      return;
    }
    const client = new Client({ connectionString: process.env.DATABASE_URL });
    client.on('error', (err) => {
      log.error(`[runEventsBus] listen client error: ${err.message}`);
      this._scheduleReconnect();
    });
    client.on('end', () => {
      this.connected = false;
      this._scheduleReconnect();
    });
    client.on('notification', (msg) => {
      if (msg.channel !== CHANNEL || !msg.payload) return;
      const set = this.subs.get(msg.payload);
      if (!set) return;
      for (const sub of set) this._pump(sub);
    });

    try {
      await client.connect();
      await client.query(`LISTEN ${CHANNEL}`);
      this.client = client;
      this.connected = true;
      log.info('[runEventsBus] LISTEN run_events established');
      // Catch up any events that landed while we were disconnected.
      for (const set of this.subs.values()) {
        for (const sub of set) this._pump(sub);
      }
    } catch (err) {
      log.error(`[runEventsBus] connect failed: ${err.message}`);
      this._scheduleReconnect();
    }
  }

  _scheduleReconnect() {
    this.connected = false;
    if (this.client) {
      try { this.client.removeAllListeners(); this.client.end(); } catch { /* noop */ }
      this.client = null;
    }
    if (this._reconnectTimer || !this.started) return;
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect();
    }, RECONNECT_DELAY_MS);
    if (typeof this._reconnectTimer.unref === 'function') this._reconnectTimer.unref();
  }

  // Attach an SSE response to a thread's event stream. Replays the durable tail
  // immediately, then streams new events as NOTIFYs arrive. Returns an
  // unsubscribe function the caller must invoke on connection close.
  subscribe(threadId, res) {
    const sub = { threadId, res, cursor: -1, flushing: false, dirty: false, closed: false };
    let set = this.subs.get(threadId);
    if (!set) {
      set = new Set();
      this.subs.set(threadId, set);
    }
    set.add(sub);
    // Initial replay (and any subsequent live events) flow through _pump.
    this._pump(sub);

    return () => {
      sub.closed = true;
      const s = this.subs.get(threadId);
      if (s) {
        s.delete(sub);
        if (s.size === 0) this.subs.delete(threadId);
      }
    };
  }

  // Serialised per-subscriber drain: write every run_events row with seq beyond
  // the subscriber's cursor, advancing the cursor as it goes. Re-runs if a new
  // NOTIFY arrived mid-flush (dirty), so concurrent notifications can't be lost.
  async _pump(sub) {
    if (sub.closed) return;
    if (sub.flushing) {
      sub.dirty = true;
      return;
    }
    sub.flushing = true;
    try {
      do {
        sub.dirty = false;
        // eslint-disable-next-line no-await-in-loop
        const rows = await repo.getRunEvents(sub.threadId, sub.cursor);
        for (const row of rows) {
          if (sub.closed) return;
          try {
            sub.res.write(`data: ${JSON.stringify(row.payload)}\n\n`);
          } catch (err) {
            log.warn(`[runEventsBus] res write failed: ${err.message}`);
            sub.closed = true;
            return;
          }
          sub.cursor = row.seq;
        }
      } while (sub.dirty && !sub.closed);
    } catch (err) {
      log.error(`[runEventsBus] pump failed: ${err.message}`);
      // A transient DB error must not strand the subscriber until the next
      // NOTIFY — if the run already finished there may never be one, and the
      // terminal event would never be delivered. Retry shortly. §4.7.
      if (!sub.closed) {
        const t = setTimeout(() => this._pump(sub), 1000);
        if (typeof t.unref === 'function') t.unref();
      }
    } finally {
      sub.flushing = false;
    }
  }

  async stop() {
    this.started = false;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    if (this.client) {
      try { await this.client.end(); } catch { /* noop */ }
      this.client = null;
    }
    this.connected = false;
  }
}

const runEventsBus = new RunEventsBus();

module.exports = { runEventsBus, RunEventsBus };
