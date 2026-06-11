// db/repo/screening.js — screening config, hits, evaluations, overrides, sanctions search.
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
const { firstToken } = require('../../services/sanctions/normalize');
const { setPartyScreeningOverride } = require('./parties');

async function getScreeningConfig() {
  const [row] = await db.select().from(screeningConfig).where(eq(screeningConfig.id, 1)).limit(1);
  if (!row) return { matchThreshold: 0.85, bingResultsPerSubject: 20 };
  return {
    matchThreshold: Number(row.matchThreshold),
    bingResultsPerSubject: row.bingResultsPerSubject,
    updatedAt: row.updatedAt,
  };
}

async function setScreeningConfig({ matchThreshold, bingResultsPerSubject }) {
  const patch = { updatedAt: sql`now()` };
  if (matchThreshold !== undefined) {
    // Defensive clamp — the PATCH route already validates, but any other
    // caller (smoke scripts, future admin tools) gets the same protection.
    // See CODE_REVIEW §3.11.
    const n = Number(matchThreshold);
    if (!Number.isFinite(n) || n < 0.5 || n > 0.99) {
      const err = new Error(`matchThreshold ${matchThreshold} out of [0.5, 0.99]`);
      err.code = 'invalid_threshold';
      throw err;
    }
    patch.matchThreshold = String(n);
  }
  if (bingResultsPerSubject !== undefined) patch.bingResultsPerSubject = bingResultsPerSubject;
  const [row] = await db
    .update(screeningConfig)
    .set(patch)
    .where(eq(screeningConfig.id, 1))
    .returning();
  return row || null;
}

async function appendScreeningHit({
  id,
  runId,
  partyId, // Phase 2 — nullable; populated when state.parties is present.
  subjectId,
  subjectName,
  subjectKind,
  subjectSource,
  listSource,
  listEntryId,
  matchScore,
  matchedFields,
  rawEntry,
}) {
  const values = {
    runId,
    partyId: partyId ?? null,
    subjectId,
    subjectName,
    subjectKind,
    subjectSource,
    listSource,
    listEntryId: listEntryId ?? null,
    matchScore: matchScore == null ? null : String(matchScore),
    matchedFields: matchedFields ?? null,
    rawEntry: rawEntry ?? {},
  };
  if (id) values.id = id;
  // Idempotent on the hit id so a cross-process resume / job retry that replays
  // the same screening state from the checkpoint can't duplicate the hit.
  const [row] = await db
    .insert(screeningHits)
    .values(values)
    .onConflictDoNothing({ target: screeningHits.id })
    .returning();
  return row;
}

async function appendScreeningEvaluation({
  hitId,
  decision,
  category,
  severity,
  llmReasoning,
  llmScore,
  fragmentId,
  humanOverride,
  overrideReason,
}) {
  const values = {
    hitId,
    decision,
    category: category ?? null,
    severity: severity ?? null,
    llmReasoning: llmReasoning ?? '',
    llmScore: llmScore == null ? null : String(llmScore),
    fragmentId: fragmentId ?? null,
    humanOverride: humanOverride ?? null,
    overrideReason: overrideReason ?? null,
    overrideAt: humanOverride ? sql`now()` : null,
  };
  const [row] = await db
    .insert(screeningEvaluations)
    .values(values)
    .onConflictDoUpdate({
      target: screeningEvaluations.hitId,
      set: {
        decision,
        category: values.category,
        severity: values.severity,
        llmReasoning: values.llmReasoning,
        llmScore: values.llmScore,
        fragmentId: values.fragmentId,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return row;
}

async function setHumanOverride(hitId, { decision, reason }) {
  const [row] = await db
    .update(screeningEvaluations)
    .set({
      humanOverride: decision ?? null,
      overrideReason: decision ? (reason ?? null) : null,
      overrideAt: decision ? sql`now()` : null,
      updatedAt: sql`now()`,
    })
    .where(eq(screeningEvaluations.hitId, hitId))
    .returning();
  return row || null;
}

async function getRunScreening(runId) {
  const hits = await db
    .select()
    .from(screeningHits)
    .where(eq(screeningHits.runId, runId))
    .orderBy(asc(screeningHits.createdAt));
  if (!hits.length) return { hits: [], evaluations: [] };
  const ids = hits.map((h) => h.id);
  const evals = await db
    .select()
    .from(screeningEvaluations)
    .where(inArray(screeningEvaluations.hitId, ids));
  return { hits, evaluations: evals };
}

async function listSanctionsLists() {
  return db
    .select({
      source: sanctionsLists.source,
      version: sanctionsLists.version,
      fetchedAt: sanctionsLists.fetchedAt,
      recordCount: sanctionsLists.recordCount,
    })
    .from(sanctionsLists)
    .orderBy(desc(sanctionsLists.fetchedAt));
}

// First-token prefix lookup. Caller passes an already-normalized name
// (uppercase, ASCII-folded, abbrev-expanded). Returns up to `limit` rows.

async function searchSanctionsByNormalizedName(normalized, { source, limit = 5000 } = {}) {
  const tok = firstToken(normalized);
  if (!tok) return [];
  const conds = [sql`${sanctionsEntries.normalizedName} LIKE ${tok + '%'}`];
  if (source) conds.push(eq(sanctionsEntries.listSource, source));
  return db
    .select()
    .from(sanctionsEntries)
    .where(and(...conds))
    .limit(limit);
}

async function getOverridesForDossier(dossierId) {
  if (!dossierId) return [];
  return db
    .select()
    .from(dossierScreeningOverrides)
    .where(eq(dossierScreeningOverrides.dossierId, dossierId));
}

async function applyOverridesForward(dossierId, hits) {
  // Phase 3 — semantics flip:
  //   * Hits with partyId  → write to party_screening_overrides (global,
  //                          carries to every dossier the party appears on).
  //   * Hits without partyId (pre-Phase-2 data) → fall back to the original
  //                                                dossier_screening_overrides
  //                                                so existing carry-forward
  //                                                behaviour is preserved.
  //
  // Returns { dossierLevel, partyLevel } counts so the route can surface
  // the change to the UI.
  if (!hits || !hits.length) return { dossierLevel: 0, partyLevel: 0 };
  let dossierLevel = 0;
  let partyLevel = 0;
  for (const h of hits) {
    if (!h.evaluation || !h.evaluation.humanOverride) continue;

    if (h.partyId) {
      await setPartyScreeningOverride({
        partyId: h.partyId,
        listSource: h.listSource,
        listEntryId: h.listEntryId ?? null,
        evidenceUrl: h.evidenceUrl ?? null,
        decision: h.evaluation.humanOverride,
        reason: h.evaluation.overrideReason ?? null,
        appliedBy: h.appliedBy ?? 'system:carry-forward',
      });
      partyLevel += 1;
      continue;
    }

    await db
      .insert(dossierScreeningOverrides)
      .values({
        dossierId,
        subjectId: h.subjectId,
        listSource: h.listSource,
        listEntryId: h.listEntryId ?? null,
        evidenceUrl: h.evidenceUrl ?? null,
        decision: h.evaluation.humanOverride,
        reason: h.evaluation.overrideReason ?? null,
      })
      .onConflictDoUpdate({
        target: [
          dossierScreeningOverrides.dossierId,
          dossierScreeningOverrides.subjectId,
          dossierScreeningOverrides.listSource,
          dossierScreeningOverrides.listEntryId,
          dossierScreeningOverrides.evidenceUrl,
        ],
        set: {
          decision: h.evaluation.humanOverride,
          reason: h.evaluation.overrideReason ?? null,
          updatedAt: sql`now()`,
        },
      });
    dossierLevel += 1;
  }
  return { dossierLevel, partyLevel };
}

// ---------------------------------------------------------------------------
// Risk matrix
// ---------------------------------------------------------------------------

module.exports = {
  getScreeningConfig,
  setScreeningConfig,
  appendScreeningHit,
  appendScreeningEvaluation,
  setHumanOverride,
  getRunScreening,
  listSanctionsLists,
  searchSanctionsByNormalizedName,
  getOverridesForDossier,
  applyOverridesForward,
};
