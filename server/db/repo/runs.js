// db/repo/runs.js — run rows: lifecycle, snapshots, reapers, lookups.
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

async function createRun({ dossierId, threadId, trigger = 'initial' }) {
  const [row] = await db
    .insert(runs)
    .values({ dossierId, threadId, trigger, status: 'running' })
    .returning();
  return row;
}

async function closeRun(runId, {
  status,
  error,
  finalKycCard,
  finalShareholderGraph,
  finalDocuments,
  finalScreeningReport,
  finalRiskAssessment,
  finalProfile,
  finalOfficers,
  finalPsc,
}) {
  const patch = { endedAt: sql`now()` };
  // R4b: any terminus settles the owed resume — belt-and-braces clear so a
  // resume that crashed mid-flight and was later re-driven can't leave the
  // marker behind.
  patch.resumeOwedAt = null;
  if (status) patch.status = status;
  if (error !== undefined) patch.error = error;
  if (finalKycCard !== undefined) patch.finalKycCard = finalKycCard;
  if (finalShareholderGraph !== undefined) patch.finalShareholderGraph = finalShareholderGraph;
  if (finalDocuments !== undefined) patch.finalDocuments = finalDocuments;
  if (finalScreeningReport !== undefined) patch.finalScreeningReport = finalScreeningReport;
  if (finalRiskAssessment !== undefined) patch.finalRiskAssessment = finalRiskAssessment;
  if (finalProfile !== undefined) patch.finalProfile = finalProfile;
  if (finalOfficers !== undefined) patch.finalOfficers = finalOfficers;
  if (finalPsc !== undefined) patch.finalPsc = finalPsc;

  const [row] = await db.update(runs).set(patch).where(eq(runs.id, runId)).returning();
  return row || null;
}

// --- R4b — apply-then-resume atomicity marker ------------------------------
// markResumeOwed accepts an optional drizzle tx so it can join the
// applyDecision transaction ("decision applied ⇒ resume owed" is atomic).

async function markResumeOwed(runId, tx = db) {
  await tx.update(runs).set({ resumeOwedAt: sql`now()` }).where(eq(runs.id, runId));
}

async function clearResumeOwed(runId) {
  await db.update(runs).set({ resumeOwedAt: null }).where(eq(runs.id, runId));
}

// Runs the reconciler owes a resume: marker set AND still running. Joined to
// dossiers for the companyNumber the dispatch ctx wants.

async function getRunsOwedResume() {
  const rows = await db
    .select({
      runId: runs.id,
      dossierId: runs.dossierId,
      threadId: runs.threadId,
      trigger: runs.trigger,
      companyNumber: dossiers.companyNumber,
    })
    .from(runs)
    .innerJoin(dossiers, eq(runs.dossierId, dossiers.id))
    .where(and(eq(runs.status, 'running'), sql`${runs.resumeOwedAt} is not null`));
  return rows;
}

// Latest human_action fragment for a run — the canonical decision record the
// reconciler rebuilds the resume payload from.

async function getRescreenSourceRun(dossierId) {
  if (!dossierId) return null;
  const [row] = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.dossierId, dossierId),
        eq(runs.status, 'done'),
        sql`${runs.finalProfile} is not null`,
        sql`${runs.finalKycCard} is not null`,
      ),
    )
    .orderBy(desc(runs.startedAt))
    .limit(1);
  return row || null;
}

async function getRunsForDossier(dossierId) {
  return db
    .select()
    .from(runs)
    .where(eq(runs.dossierId, dossierId))
    .orderBy(desc(runs.startedAt));
}

async function getRun(runId) {
  const [run] = await db.select().from(runs).where(eq(runs.id, runId)).limit(1);
  if (!run) return null;

  const fragments = await db
    .select()
    .from(decisionFragments)
    .where(eq(decisionFragments.runId, runId))
    .orderBy(asc(decisionFragments.sequence), asc(decisionFragments.startedAt));

  return { ...run, fragments };
}

async function getRunByThreadId(threadId) {
  const [run] = await db.select().from(runs).where(eq(runs.threadId, threadId)).limit(1);
  return run || null;
}

// The (at most one, enforced by runs_one_running_per_dossier) run currently
// executing for a dossier. Routes use this to 409 a duplicate start instead of
// letting the unique index turn the second run into an unpersisted ghost.
// See CODE_REVIEW §4.1.

async function getRunningRunForDossier(dossierId) {
  if (!dossierId) return null;
  const [run] = await db
    .select({ id: runs.id, threadId: runs.threadId, trigger: runs.trigger, startedAt: runs.startedAt })
    .from(runs)
    .where(and(eq(runs.dossierId, dossierId), eq(runs.status, 'running')))
    .limit(1);
  return run || null;
}

async function updateRunScreeningReport(runId, report) {
  const [row] = await db
    .update(runs)
    .set({ finalScreeningReport: report })
    .where(eq(runs.id, runId))
    .returning();
  return row || null;
}

// Replace runs.final_risk_assessment without touching endedAt / status / error.
// Used by the recalculate-risk endpoint for a matrix-edit-only rebase.

async function updateRunRiskAssessment(runId, assessment) {
  const [row] = await db
    .update(runs)
    .set({ finalRiskAssessment: assessment })
    .where(eq(runs.id, runId))
    .returning();
  return row || null;
}

async function reopenRun(runId) {
  // Null the snapshot + QA columns so a re-run cannot inherit stale outputs
  // from the previous failed attempt. The graph will re-populate everything
  // it actually produces; anything that doesn't run again should be visibly
  // absent, not silently carried forward. See CODE_REVIEW §4.3.
  const [row] = await db
    .update(runs)
    .set({
      status: 'running',
      endedAt: null,
      error: null,
      finalKycCard: null,
      finalShareholderGraph: null,
      finalDocuments: null,
      finalScreeningReport: null,
      finalProfile: null,
      finalOfficers: null,
      finalPsc: null,
      finalRiskAssessment: null,
      qaResult: null,
      qaNarrative: null,
    })
    .where(eq(runs.id, runId))
    .returning();
  return row || null;
}

async function getPreviousRun(dossierId, beforeRunId) {
  const [target] = await db.select().from(runs).where(eq(runs.id, beforeRunId)).limit(1);
  if (!target) return null;
  const [prev] = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.dossierId, dossierId),
        sql`${runs.startedAt} < ${target.startedAt}`
      )
    )
    .orderBy(desc(runs.startedAt))
    .limit(1);
  return prev || null;
}

// Startup reaper: mark any run still `running` long after the server last
// died as `failed`. See CODE_REVIEW §4.3.
async function reapStaleRuns({ olderThanMinutes = 120 } = {}) {
  const result = await db.execute(sql`
    update runs
       set status = 'failed',
           ended_at = coalesce(ended_at, now()),
           error = coalesce(error, 'reaped: server restart with run still running')
     where status = 'running'
       and started_at < now() - (${olderThanMinutes}::text || ' minutes')::interval
     returning id
  `);
  return result.rows?.length ?? 0;
}

// --- R2: run_events (durable cross-process SSE channel) -------------------

// Append one SSE event to a thread's durable stream. Idempotent on
// (thread_id, seq): a retried worker delivery can't duplicate the stream.
// Returns the new row id, or null if (thread_id, seq) already existed.

async function setRunWorker(runId, workerId) {
  if (!runId) return null;
  const [row] = await db
    .update(runs)
    .set({ workerId })
    .where(eq(runs.id, runId))
    .returning();
  return row || null;
}

// Age-based reaper for run_events — keep the table from outgrowing the runs it
// describes. Runs on boot alongside reapStaleRuns. Best-effort.

// Boot reconciliation (worker): runs still marked `running` that may have a
// live checkpoint to resume.
async function listRunningRuns() {
  return db
    .select({
      runId: runs.id,
      threadId: runs.threadId,
      trigger: runs.trigger,
      workerId: runs.workerId,
      startedAt: runs.startedAt,
      companyNumber: dossiers.companyNumber,
    })
    .from(runs)
    .innerJoin(dossiers, eq(runs.dossierId, dossiers.id))
    .where(eq(runs.status, 'running'))
    .orderBy(asc(runs.startedAt));
}

// Phase 5 / Q5 — flat list of decision_fragments, joined to dossier + run for
// the AuditLogPage. Filters by `kind` (defaults to all) and a soft `limit`.
// Returns rows enriched with companyNumber / companyName / runStatus.

module.exports = {
  createRun,
  closeRun,
  markResumeOwed,
  clearResumeOwed,
  getRunsOwedResume,
  getRescreenSourceRun,
  getRunsForDossier,
  getRun,
  getRunByThreadId,
  getRunningRunForDossier,
  updateRunScreeningReport,
  updateRunRiskAssessment,
  reopenRun,
  getPreviousRun,
  reapStaleRuns,
  setRunWorker,
  listRunningRuns,
};
