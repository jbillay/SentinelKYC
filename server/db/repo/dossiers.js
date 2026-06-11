// db/repo/dossiers.js — dossier aggregate (list/read/meta/KPIs/case status).
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
const { escapeLike } = require('./util');

async function upsertDossier({ companyNumber, companyName }) {
  if (!companyNumber) throw new Error('upsertDossier: companyNumber required');
  const [row] = await db
    .insert(dossiers)
    .values({ companyNumber, companyName })
    .onConflictDoUpdate({
      target: dossiers.companyNumber,
      set: {
        companyName: sql`coalesce(excluded.company_name, ${dossiers.companyName})`,
        updatedAt: sql`now()`,
      },
    })
    .returning();
  return row;
}

async function updateDossierMeta(companyNumber, { tags, notes, companyName }) {
  const patch = { updatedAt: sql`now()` };
  if (tags !== undefined) patch.tags = tags;
  if (notes !== undefined) patch.notes = notes;
  if (companyName !== undefined) patch.companyName = companyName;

  const [row] = await db
    .update(dossiers)
    .set(patch)
    .where(eq(dossiers.companyNumber, companyNumber))
    .returning();
  return row || null;
}

async function listDossiers({ q, status, tag, caseStatus } = {}) {
  const filters = [];
  if (q && q.trim()) {
    const like = `%${escapeLike(q.trim())}%`;
    filters.push(sql`(${dossiers.companyName} ILIKE ${like} OR ${dossiers.companyNumber} ILIKE ${like})`);
  }
  if (tag) {
    filters.push(sql`${dossiers.tags} @> ${JSON.stringify([tag])}::jsonb`);
  }
  if (caseStatus !== undefined && caseStatus !== null && caseStatus !== '') {
    const list = Array.isArray(caseStatus) ? caseStatus : [caseStatus];
    if (list.length === 1) {
      filters.push(eq(dossiers.caseStatus, list[0]));
    } else if (list.length > 1) {
      filters.push(inArray(dossiers.caseStatus, list));
    }
  }

  const where = filters.length ? and(...filters) : undefined;

  const baseRows = await db
    .select()
    .from(dossiers)
    .where(where)
    .orderBy(desc(dossiers.updatedAt));

  if (baseRows.length === 0) return [];

  const dossierIds = baseRows.map((d) => d.id);

  // Lean projection of the latest run per dossier — explicitly omit the
  // heavy final_* jsonb columns (kycCard, screening report, full risk
  // receipt, QA result, profile/officers/psc snapshots can each be tens
  // of KB). The list view only renders status + trigger + timing + risk
  // tier, so we project just the four risk keys the page needs via
  // jsonb_build_object; the full row would be ~5MB per /api/dossiers hit
  // at 100 dossiers × 5 runs apiece. See CODE_REVIEW §4.4.
  const latestRunRows = await db.execute(sql`
    select distinct on (dossier_id)
      id, dossier_id, thread_id, status, trigger,
      started_at, ended_at, error,
      case
        when final_risk_assessment is null then null
        else jsonb_build_object(
          'outcome',       final_risk_assessment->'outcome',
          'tier',          final_risk_assessment->'tier',
          'score',         final_risk_assessment->'score',
          'matrixVersion', final_risk_assessment->'matrixVersion'
        )
      end as final_risk_assessment,
      case
        when jsonb_typeof(final_kyc_card->'officers') = 'array'
          then jsonb_array_length(final_kyc_card->'officers') else 0
      end as officers_count,
      case
        when jsonb_typeof(final_kyc_card->'psc') = 'array'
          then jsonb_array_length(final_kyc_card->'psc') else 0
      end as psc_count,
      case
        when jsonb_typeof(final_kyc_card->'shareholders') = 'array'
          then jsonb_array_length(final_kyc_card->'shareholders') else 0
      end as shareholders_count
    from runs
    where dossier_id in (${sql.join(dossierIds.map((id) => sql`${id}::uuid`), sql`, `)})
    order by dossier_id, started_at desc
  `);

  const countRows = await db.execute(sql`
    select dossier_id, count(*)::int as cnt
    from runs
    where dossier_id in (${sql.join(dossierIds.map((id) => sql`${id}::uuid`), sql`, `)})
    group by dossier_id
  `);

  const latestByDossier = new Map();
  for (const r of latestRunRows.rows || []) {
    latestByDossier.set(r.dossier_id, {
      id: r.id,
      dossierId: r.dossier_id,
      threadId: r.thread_id,
      status: r.status,
      trigger: r.trigger,
      startedAt: r.started_at,
      endedAt: r.ended_at,
      error: r.error,
      finalRiskAssessment: r.final_risk_assessment,
      officersCount: r.officers_count || 0,
      pscCount: r.psc_count || 0,
      shareholdersCount: r.shareholders_count || 0,
    });
  }
  const countByDossier = new Map();
  for (const r of countRows.rows || []) countByDossier.set(r.dossier_id, r.cnt);

  let result = baseRows.map((d) => ({
    ...d,
    latestRun: latestByDossier.get(d.id) || null,
    runCount: countByDossier.get(d.id) || 0,
  }));
  if (status) {
    result = result.filter((d) => d.latestRun?.status === status);
  }
  return result;
}

// Lean run projection for history lists — everything except the heavy
// final_* / qa jsonb blobs, plus the four risk keys the UI renders.
// Shares its shape with listDossiers' latestRun projection. CODE_REVIEW §5.2.

const LEAN_RUN_COLUMNS = {
  id: runs.id,
  dossierId: runs.dossierId,
  threadId: runs.threadId,
  status: runs.status,
  trigger: runs.trigger,
  startedAt: runs.startedAt,
  endedAt: runs.endedAt,
  error: runs.error,
  workerId: runs.workerId,
  finalRiskAssessment: sql`
    case
      when ${runs.finalRiskAssessment} is null then null
      else jsonb_build_object(
        'outcome',       ${runs.finalRiskAssessment}->'outcome',
        'tier',          ${runs.finalRiskAssessment}->'tier',
        'score',         ${runs.finalRiskAssessment}->'score',
        'matrixVersion', ${runs.finalRiskAssessment}->'matrixVersion'
      )
    end`.as('final_risk_assessment'),
};

// Dossier + its runs. Historical runs come back LEAN (no multi-MB jsonb
// snapshots — see CODE_REVIEW §5.2); only the two runs the dossier page
// actually reads blobs from are returned in full:
//   * the latest run            (KYC card header, screening, risk, QA panels)
//   * the latest 'done' run     (lastValidRun — card/graph fallback while a
//                                newer run is still in flight or failed)
// Per-run detail stays on GET /api/dossiers/:cn/runs/:runId (getRun).

async function getDossier(companyNumber) {
  const [dossier] = await db
    .select()
    .from(dossiers)
    .where(eq(dossiers.companyNumber, companyNumber))
    .limit(1);
  if (!dossier) return null;

  const leanRuns = await db
    .select(LEAN_RUN_COLUMNS)
    .from(runs)
    .where(eq(runs.dossierId, dossier.id))
    .orderBy(desc(runs.startedAt));

  const fullIds = new Set();
  if (leanRuns[0]) fullIds.add(leanRuns[0].id);
  const lastDone = leanRuns.find((r) => r.status === 'done');
  if (lastDone) fullIds.add(lastDone.id);

  let merged = leanRuns;
  if (fullIds.size) {
    const fullRows = await db
      .select()
      .from(runs)
      .where(inArray(runs.id, [...fullIds]));
    const fullById = new Map(fullRows.map((r) => [r.id, r]));
    merged = leanRuns.map((r) => fullById.get(r.id) || r);
  }

  return { ...dossier, runs: merged };
}

// Latest run usable as a rescreen seed: completed, with the API-state
// snapshot present. Dedicated query so the rescreen route doesn't depend on
// getDossier returning full blobs for historical runs.

async function deleteDossier(companyNumber) {
  await db.delete(dossiers).where(eq(dossiers.companyNumber, companyNumber));
}

// Replace runs.final_screening_report without touching endedAt / status / error.
// Used by the hits-override PATCH endpoint after re-deriving the report.

async function computeKpis() {
  // 6 weekly buckets ending at start of current week (Monday).
  // Postgres `date_trunc('week', ...)` is ISO-week (Monday-based) which is what we want.
  // The five aggregates are independent — run them concurrently instead of
  // serially stacking five round-trips per dashboard load (CODE_REVIEW §5.4).
  const [dossiersThisMonthRow, dossiersTrendRows, avgRow, avgTrendRows, flaggedRow, ocrRow] =
    await Promise.all([
      db.execute(sql`
        select count(*)::int as value
        from dossiers
        where created_at >= date_trunc('month', now())
      `),
      db.execute(sql`
        with weeks as (
          select generate_series(
            date_trunc('week', now()) - interval '5 weeks',
            date_trunc('week', now()),
            interval '1 week'
          ) as week_start
        )
        select w.week_start,
               coalesce(count(d.id), 0)::int as cnt
        from weeks w
        left join dossiers d
          on date_trunc('week', d.created_at) = w.week_start
        group by w.week_start
        order by w.week_start asc
      `),
      db.execute(sql`
        select coalesce(
          avg(extract(epoch from (ended_at - started_at)) / 3600.0),
          0
        )::float as value
        from runs
        where status = 'done'
          and ended_at is not null
      `),
      db.execute(sql`
        with weeks as (
          select generate_series(
            date_trunc('week', now()) - interval '5 weeks',
            date_trunc('week', now()),
            interval '1 week'
          ) as week_start
        )
        select w.week_start,
               coalesce(
                 avg(extract(epoch from (r.ended_at - r.started_at)) / 3600.0),
                 0
               )::float as v
        from weeks w
        left join runs r
          on date_trunc('week', r.started_at) = w.week_start
          and r.status = 'done'
          and r.ended_at is not null
        group by w.week_start
        order by w.week_start asc
      `),
      // Flagged: dossiers tagged 'escalate' OR latest run failed.
      db.execute(sql`
        select count(distinct d.id)::int as value
        from dossiers d
        left join lateral (
          select status
          from runs
          where dossier_id = d.id
          order by started_at desc
          limit 1
        ) latest on true
        where d.tags @> '["escalate"]'::jsonb
           or latest.status = 'failed'
      `),
      // OCR pages: sum decision_fragments.outputs->>'ocrPagesProcessed'.
      db.execute(sql`
        select coalesce(
          sum(((outputs ->> 'ocrPagesProcessed'))::int),
          0
        )::int as value
        from decision_fragments
        where node_id = 'process_documents'
          and outputs ? 'ocrPagesProcessed'
      `),
    ]);

  const dossiersThisMonth = dossiersThisMonthRow.rows?.[0]?.value ?? 0;
  const dossiersTrend = (dossiersTrendRows.rows || []).map((r) => r.cnt);
  const avgCompletionHours = Number((avgRow.rows?.[0]?.value ?? 0).toFixed(2));
  const avgCompletionTrend = (avgTrendRows.rows || []).map((r) => Number(r.v.toFixed(2)));
  const flaggedForReview = flaggedRow.rows?.[0]?.value ?? 0;
  const ocrPagesProcessed = ocrRow.rows?.[0]?.value ?? 0;

  // Trends for flagged + ocr — flat-zero arrays for POC; refine later if needed.
  const flatTrend = [0, 0, 0, 0, 0, 0];

  return {
    dossiersThisMonth: { value: dossiersThisMonth, trend: dossiersTrend },
    avgCompletionHours: { value: avgCompletionHours, trend: avgCompletionTrend },
    flaggedForReview: { value: flaggedForReview, trend: flatTrend },
    ocrPagesProcessed: { value: ocrPagesProcessed, trend: flatTrend },
  };
}

// ---------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------

async function updateDossierCaseStatus(companyNumber, { caseStatus, runId } = {}) {
  if (!companyNumber) throw new Error('updateDossierCaseStatus: companyNumber required');
  if (!caseStatus) throw new Error('updateDossierCaseStatus: caseStatus required');
  const [row] = await db
    .update(dossiers)
    .set({
      caseStatus,
      caseStatusUpdatedAt: sql`now()`,
      caseStatusRunId: runId ?? null,
      updatedAt: sql`now()`,
    })
    .where(eq(dossiers.companyNumber, companyNumber))
    .returning();
  return row || null;
}

async function getCaseStatus(companyNumber) {
  const [row] = await db
    .select({
      caseStatus: dossiers.caseStatus,
      caseStatusUpdatedAt: dossiers.caseStatusUpdatedAt,
      caseStatusRunId: dossiers.caseStatusRunId,
    })
    .from(dossiers)
    .where(eq(dossiers.companyNumber, companyNumber))
    .limit(1);
  return row || null;
}

module.exports = {
  upsertDossier,
  updateDossierMeta,
  listDossiers,
  getDossier,
  deleteDossier,
  computeKpis,
  updateDossierCaseStatus,
  getCaseStatus,
};
