// db/repo/runEvents.js — R2 durable SSE channel + queue-mode thread state.
// Split from the monolithic db/repo.js (CODE_REVIEW §6.5). db/repo.js is the
// re-exporting facade — call sites keep requiring '../db/repo'.
/* eslint-disable no-unused-vars */
const { eq, desc, asc, and, sql, ilike, inArray, notInArray } = require('drizzle-orm');
const { db } = require('../client');
const {
  dossiers,
  runs,
  runEvents,
  decisionFragments,
  screeningHits,
  screeningEvaluations,
  dossierScreeningOverrides,
  screeningConfig,
  sanctionsLists,
  sanctionsEntries,
  riskMatrixVersions,
  riskMatrixActive,
  parties,
  partyMatchLog,
  partyLinks,
  partyLinkStatusHistory,
  partyReviewQueue,
  partyScreeningOverrides,
  partyWatchlist,
  users,
} = require('../schema');
/* eslint-enable no-unused-vars */

async function appendRunEvent({ threadId, seq, payload }) {
  if (!threadId) throw new Error('appendRunEvent: threadId required');
  if (!Number.isInteger(seq)) throw new Error('appendRunEvent: integer seq required');
  const [row] = await db
    .insert(runEvents)
    .values({ threadId, seq, payload })
    .onConflictDoNothing({ target: [runEvents.threadId, runEvents.seq] })
    .returning({ id: runEvents.id });
  return row?.id ?? null;
}

// Replay the tail of a thread's stream: every event with seq strictly greater
// than `afterSeq`, in order. Default -1 returns the whole stream from seq 0.

async function getRunEvents(threadId, afterSeq = -1) {
  return db
    .select({ seq: runEvents.seq, payload: runEvents.payload })
    .from(runEvents)
    .where(and(eq(runEvents.threadId, threadId), sql`${runEvents.seq} > ${afterSeq}`))
    .orderBy(asc(runEvents.seq));
}

// Highest seq persisted for a thread, or -1 if none. Used by the NotifySink to
// continue the seq counter across a worker restart / job retry.

async function getMaxRunEventSeq(threadId) {
  const [row] = await db
    .select({ max: sql`max(${runEvents.seq})` })
    .from(runEvents)
    .where(eq(runEvents.threadId, threadId));
  const max = row?.max;
  return max == null ? -1 : Number(max);
}

// Stamp the worker process that is driving a run (observability + liveness).

async function reapRunEvents({ olderThanHours = 24 } = {}) {
  const result = await db.execute(sql`
    delete from run_events
     where created_at < now() - (${olderThanHours}::text || ' hours')::interval
     returning id
  `);
  return result.rows?.length ?? 0;
}

// DB-backed active-runs snapshot for RUN_EXECUTION=queue, where the web process
// holds no in-memory thread state (runs execute in the worker). Mirrors the
// shape of registry.activeSnapshot(): one entry per still-running run, enriched
// with the latest interrupt event so a page reload can re-mount the
// disambiguation / final-decision panel without waiting for a fresh SSE event.

async function listActiveRunsFromDb() {
  const rows = await db
    .select({
      threadId: runs.threadId,
      runId: runs.id,
      trigger: runs.trigger,
      startedAt: runs.startedAt,
      companyNumber: dossiers.companyNumber,
      companyName: dossiers.companyName,
    })
    .from(runs)
    .innerJoin(dossiers, eq(runs.dossierId, dossiers.id))
    .where(eq(runs.status, 'running'))
    .orderBy(asc(runs.startedAt));

  if (rows.length === 0) return [];

  // Batched probes (CODE_REVIEW §5.3): one DISTINCT ON query per event class
  // across ALL running threads instead of two queries per run. Both are
  // served by run_events_thread_type_seq_idx (migration 0024).
  const threadIds = rows.map((r) => r.threadId);
  const interruptRows = await db.execute(sql`
    select distinct on (thread_id) thread_id, seq, payload
    from run_events
    where thread_id = any(${threadIds}) and payload->>'type' = 'interrupt'
    order by thread_id, seq desc
  `);
  const terminalRows = await db.execute(sql`
    select distinct on (thread_id) thread_id, seq
    from run_events
    where thread_id = any(${threadIds}) and payload->>'type' in ('done','cancelled')
    order by thread_id, seq desc
  `);
  const interruptByThread = new Map((interruptRows.rows || []).map((r) => [r.thread_id, r]));
  const terminalByThread = new Map((terminalRows.rows || []).map((r) => [r.thread_id, r]));

  const out = [];
  for (const r of rows) {
    const evt = interruptByThread.get(r.threadId) || null;
    // Any terminal event after the interrupt means the pause was resolved.
    const terminal = terminalByThread.get(r.threadId) || null;

    const interruptPayload = evt?.payload || null;
    const interruptKind =
      !terminal || (evt && terminal.seq < evt.seq) ? interruptPayload?.kind || null : null;
    let phase = 'running';
    if (interruptKind === 'final_decision') phase = 'awaiting_decision';
    else if (interruptKind === 'entity_selection') phase = 'needs_user_pick';

    const value = interruptPayload?.payload || {};
    out.push({
      threadId: r.threadId,
      phase,
      startedAt: r.startedAt instanceof Date ? r.startedAt.getTime() : r.startedAt,
      companyNumber: r.companyNumber || null,
      companyName: r.companyName || null,
      lastInput: r.companyNumber ? { companyNumber: r.companyNumber } : null,
      candidates: phase === 'needs_user_pick' ? value.candidates || [] : [],
      resolution: phase === 'needs_user_pick' ? value.resolution || null : null,
      trigger: r.trigger,
      runId: phase === 'awaiting_decision' ? value.runId || r.runId : null,
      qaResult: phase === 'awaiting_decision' ? value.qaResult || null : null,
      qaNarrative: phase === 'awaiting_decision' ? value.qaNarrative || null : null,
      kycCard: phase === 'awaiting_decision' ? value.kycCard || null : null,
    });
  }
  return out;
}

// Derive a thread's stream state purely from run_events — the queue-mode
// equivalent of the in-memory registry flags (the web process holds no thread
// state when the worker drives the run). Used by the SSE validity check and the
// queue-mode resume guards.

async function getThreadStreamState(threadId) {
  const maxSeq = await getMaxRunEventSeq(threadId);
  if (maxSeq < 0) return { hasEvents: false, interrupted: false, interruptKind: null };

  const [intr] = await db
    .select({ seq: runEvents.seq, payload: runEvents.payload })
    .from(runEvents)
    .where(and(eq(runEvents.threadId, threadId), sql`${runEvents.payload} ->> 'type' = 'interrupt'`))
    .orderBy(desc(runEvents.seq))
    .limit(1);

  const [term] = await db
    .select({ seq: runEvents.seq })
    .from(runEvents)
    .where(
      and(
        eq(runEvents.threadId, threadId),
        sql`${runEvents.payload} ->> 'type' in ('done','cancelled')`,
      ),
    )
    .orderBy(desc(runEvents.seq))
    .limit(1);

  const interrupted = !!intr && (!term || term.seq < intr.seq);
  return {
    hasEvents: true,
    interrupted,
    interruptKind: interrupted ? intr.payload?.kind || null : null,
  };
}

module.exports = {
  appendRunEvent,
  getRunEvents,
  getMaxRunEventSeq,
  reapRunEvents,
  listActiveRunsFromDb,
  getThreadStreamState,
};
