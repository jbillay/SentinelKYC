// db/repo/qa.js — QA result persistence + snapshot gates.
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

// In-place jsonb write that doesn't touch endedAt/status/error.
async function setRunQaResult(runId, qaResult) {
  const [row] = await db
    .update(runs)
    .set({ qaResult })
    .where(eq(runs.id, runId))
    .returning();
  return row || null;
}

// In-place jsonb write for the qa_narrative column. Written by the qa_narrative
// graph node after qa_check; doesn't touch endedAt/status/error/qaResult.

async function setRunQaNarrative(runId, qaNarrative) {
  const [row] = await db
    .update(runs)
    .set({ qaNarrative })
    .where(eq(runs.id, runId))
    .returning();
  return row || null;
}

// Transactional pair-write used by the SSE writer (and the qa/recompute
// route) so qa_result + dossier.case_status either both commit or both don't.
// See CODE_REVIEW §3.10.
//
// - Always writes runs.qa_result.
// - Writes dossiers.case_status iff `mirrorCaseStatus !== false` AND the
//   QA routing produced one AND the dossier is in a non-terminal state.
//   Terminal states (approved | rejected) are never overwritten by a re-run.
// - With the await_decision interrupt (Phase 5 follow-up), the SSE writer
//   passes `mirrorCaseStatus: false` so the QA routing tier is recorded on
//   the run but the dossier waits for a human decision before flipping.
// - If `requireLatestRun` is true (qa/recompute path), the case_status update
//   is additionally gated on this run being the latest snapshot-bearing run
//   for the dossier; otherwise we'd let an older re-run clobber a newer one.

async function finalizeRunQa(runId, companyNumber, qaResult, opts = {}) {
  if (!runId) throw new Error('finalizeRunQa: runId required');
  if (!companyNumber) throw new Error('finalizeRunQa: companyNumber required');
  if (!qaResult) throw new Error('finalizeRunQa: qaResult required');

  const mirrorCaseStatus = opts.mirrorCaseStatus !== false;
  const caseStatus = mirrorCaseStatus ? (qaResult?.routing?.caseStatus || null) : null;
  const requireLatestRun = Boolean(opts.requireLatestRun);

  return db.transaction(async (tx) => {
    const [runRow] = await tx
      .update(runs)
      .set({ qaResult })
      .where(eq(runs.id, runId))
      .returning();

    let caseStatusUpdated = false;
    if (caseStatus) {
      // Latest-snapshot-wins gate (qa/recompute only). When recomputing QA on
      // an older run, we must not overwrite a newer run's case_status.
      let allowed = true;
      if (requireLatestRun) {
        const [latest] = await tx
          .select({ id: runs.id })
          .from(runs)
          .innerJoin(dossiers, eq(runs.dossierId, dossiers.id))
          .where(
            and(
              eq(dossiers.companyNumber, companyNumber),
              sql`${runs.finalProfile} is not null`,
              sql`${runs.finalKycCard} is not null`,
              sql`${runs.finalScreeningReport} is not null`,
              sql`${runs.finalRiskAssessment} is not null`,
            ),
          )
          .orderBy(desc(runs.startedAt))
          .limit(1);
        if (!latest || latest.id !== runId) allowed = false;
      }

      if (allowed) {
        // Terminal-state guard: don't un-finalize an approved/rejected case.
        const result = await tx
          .update(dossiers)
          .set({
            caseStatus,
            caseStatusUpdatedAt: sql`now()`,
            caseStatusRunId: runId,
            updatedAt: sql`now()`,
          })
          .where(
            and(
              eq(dossiers.companyNumber, companyNumber),
              notInArray(dossiers.caseStatus, ['approved', 'rejected']),
            ),
          )
          .returning({ id: dossiers.id });
        caseStatusUpdated = result.length > 0;
      }
    }

    return { run: runRow || null, caseStatusUpdated };
  });
}

// Latest run on this dossier whose final_profile, final_kyc_card,
// final_screening_report and final_risk_assessment are all non-null.
// Used by qa/recompute and the decision-allowed gate.

async function getLatestRunWithSnapshots(companyNumber) {
  const [dossier] = await db
    .select({ id: dossiers.id })
    .from(dossiers)
    .where(eq(dossiers.companyNumber, companyNumber))
    .limit(1);
  if (!dossier) return null;
  const [row] = await db
    .select()
    .from(runs)
    .where(
      and(
        eq(runs.dossierId, dossier.id),
        sql`${runs.finalProfile} is not null`,
        sql`${runs.finalKycCard} is not null`,
        sql`${runs.finalScreeningReport} is not null`,
        sql`${runs.finalRiskAssessment} is not null`,
      ),
    )
    .orderBy(desc(runs.startedAt))
    .limit(1);
  return row || null;
}

module.exports = {
  setRunQaResult,
  setRunQaNarrative,
  finalizeRunQa,
  getLatestRunWithSnapshots,
};
