// db/repo/fragments.js — decision_fragments append + audit feed.
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

async function getLatestHumanActionFragment(runId) {
  const [row] = await db
    .select()
    .from(decisionFragments)
    .where(and(eq(decisionFragments.runId, runId), eq(decisionFragments.kind, 'human_action')))
    .orderBy(desc(decisionFragments.sequence))
    .limit(1);
  return row || null;
}

async function appendFragment({
  id,
  runId,
  parentFragmentId,
  nodeId,
  sequence,
  kind,
  status = 'ok',
  startedAt,
  durationMs,
  summary,
  inputs,
  outputs,
  error,
}) {
  const values = {
    runId,
    parentFragmentId: parentFragmentId ?? null,
    nodeId,
    sequence,
    kind,
    status,
    startedAt: startedAt ? new Date(startedAt) : undefined,
    durationMs,
    summary,
    inputs,
    outputs,
    error,
  };
  if (id) values.id = id;
  const [row] = await db
    .insert(decisionFragments)
    .values(values)
    .onConflictDoNothing({ target: decisionFragments.id })
    .returning();
  return row;
}

// Multi-row insert variant for the SSE emitDelta path. A single LangGraph
// chunk can carry several new fragments (parent + per-hit children); each
// going through a separate `INSERT … RETURNING` round-trip stalls the stream
// behind Postgres latency. Batching them flushes in one round trip. See
// CODE_REVIEW §4.4.

async function appendFragmentsBatch(rows) {
  if (!Array.isArray(rows) || rows.length === 0) return [];
  const values = rows.map((r) => {
    const v = {
      runId: r.runId,
      parentFragmentId: r.parentFragmentId ?? null,
      nodeId: r.nodeId,
      sequence: r.sequence,
      kind: r.kind,
      status: r.status ?? 'ok',
      startedAt: r.startedAt ? new Date(r.startedAt) : undefined,
      durationMs: r.durationMs,
      summary: r.summary,
      inputs: r.inputs,
      outputs: r.outputs,
      error: r.error,
    };
    if (r.id) v.id = r.id;
    return v;
  });
  return db
    .insert(decisionFragments)
    .values(values)
    .onConflictDoNothing({ target: decisionFragments.id })
    .returning();
}

async function listFragments({ kind, limit = 200 } = {}) {
  const conds = [];
  if (kind) {
    const list = Array.isArray(kind) ? kind : [kind];
    if (list.length === 1) conds.push(eq(decisionFragments.kind, list[0]));
    else if (list.length > 1) conds.push(inArray(decisionFragments.kind, list));
  }
  const where = conds.length ? and(...conds) : undefined;
  const rows = await db
    .select({
      id: decisionFragments.id,
      runId: decisionFragments.runId,
      nodeId: decisionFragments.nodeId,
      kind: decisionFragments.kind,
      status: decisionFragments.status,
      summary: decisionFragments.summary,
      inputs: decisionFragments.inputs,
      outputs: decisionFragments.outputs,
      error: decisionFragments.error,
      startedAt: decisionFragments.startedAt,
      durationMs: decisionFragments.durationMs,
      sequence: decisionFragments.sequence,
      parentFragmentId: decisionFragments.parentFragmentId,
      dossierId: dossiers.id,
      companyNumber: dossiers.companyNumber,
      companyName: dossiers.companyName,
      runStatus: runs.status,
      runStartedAt: runs.startedAt,
    })
    .from(decisionFragments)
    .innerJoin(runs, eq(decisionFragments.runId, runs.id))
    .innerJoin(dossiers, eq(runs.dossierId, dossiers.id))
    .where(where)
    .orderBy(desc(decisionFragments.startedAt))
    .limit(Math.min(Math.max(Number(limit) || 200, 1), 1000));
  return rows;
}

module.exports = {
  getLatestHumanActionFragment,
  appendFragment,
  appendFragmentsBatch,
  listFragments,
};
