// db/repo/risk.js — risk matrix registry + previous-assessment lookup.
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

async function getActiveRiskMatrix() {
  const [row] = await db
    .select({
      versionId: riskMatrixVersions.id,
      version: riskMatrixVersions.version,
      body: riskMatrixVersions.body,
      notes: riskMatrixVersions.notes,
      updatedAt: riskMatrixActive.updatedAt,
    })
    .from(riskMatrixActive)
    .innerJoin(riskMatrixVersions, eq(riskMatrixVersions.id, riskMatrixActive.versionId))
    .where(eq(riskMatrixActive.id, 1))
    .limit(1);
  return row || null;
}

async function listRiskMatrixVersions() {
  return db
    .select({
      id: riskMatrixVersions.id,
      version: riskMatrixVersions.version,
      notes: riskMatrixVersions.notes,
      createdAt: riskMatrixVersions.createdAt,
    })
    .from(riskMatrixVersions)
    .orderBy(desc(riskMatrixVersions.version));
}

async function getRiskMatrixVersion(id) {
  const [row] = await db
    .select()
    .from(riskMatrixVersions)
    .where(eq(riskMatrixVersions.id, id))
    .limit(1);
  return row || null;
}

async function createRiskMatrixVersion({ body, notes }) {
  const result = await db.execute(
    sql`select coalesce(max(version), 0) + 1 as next from risk_matrix_versions`
  );
  const nextVersion = Number(result.rows?.[0]?.next ?? 1);
  const [row] = await db
    .insert(riskMatrixVersions)
    .values({ version: nextVersion, body, notes: notes ?? null })
    .returning();
  return row;
}

async function setActiveRiskMatrix(versionId) {
  const target = await getRiskMatrixVersion(versionId);
  if (!target) return null;
  await db
    .insert(riskMatrixActive)
    .values({ id: 1, versionId })
    .onConflictDoUpdate({
      target: riskMatrixActive.id,
      set: { versionId, updatedAt: sql`now()` },
    });
  return target;
}

// ---------------------------------------------------------------------------
// QA + final decision (Phase 5 / Q1)
// ---------------------------------------------------------------------------

// Latest-run-wins case status. Idempotent: re-applying the same payload simply
// updates case_status_updated_at to now().

// Latest run for this dossier (excluding excludeRunId) that has a persisted
// risk assessment. Returns the assessment object or null.
async function getPreviousRiskAssessment(companyNumber, excludeRunId) {
  const [dossier] = await db
    .select({ id: dossiers.id })
    .from(dossiers)
    .where(eq(dossiers.companyNumber, companyNumber))
    .limit(1);
  if (!dossier) return null;
  const conds = [
    eq(runs.dossierId, dossier.id),
    sql`${runs.finalRiskAssessment} is not null`,
  ];
  if (excludeRunId) conds.push(sql`${runs.id} <> ${excludeRunId}`);
  const [row] = await db
    .select({ assessment: runs.finalRiskAssessment })
    .from(runs)
    .where(and(...conds))
    .orderBy(desc(runs.startedAt))
    .limit(1);
  return row?.assessment ?? null;
}

module.exports = {
  getActiveRiskMatrix,
  listRiskMatrixVersions,
  getRiskMatrixVersion,
  createRiskMatrixVersion,
  setActiveRiskMatrix,
  getPreviousRiskAssessment,
};
