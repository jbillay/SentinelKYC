// P1 R4b — decision resume recovery smoke.
//
// Simulates the crash window between applyDecision's commit and the graph
// resume: applies a decision directly (resumeOwed: true) WITHOUT dispatching
// the resume, asserts the owed marker is set while the run stays 'running',
// then runs the boot reconciler and asserts the run was settled (closed —
// this synthetic thread has no LangGraph checkpoint, so the reconciler takes
// the close path) with the marker cleared and no duplicate human_action row.
//
// Needs Postgres only (no LLM, no checkpoint).

const { randomUUID } = require('crypto');
const repo = require('../db/repo');
const { db, pool } = require('../db/client');
const { sql } = require('drizzle-orm');
const { applyDecision } = require('../services/decision');
const { reconcileOwedResumes } = require('../services/resumeReconciler');

function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

async function humanActionCount(runId) {
  const r = await db.execute(sql`
    select count(*)::int as n from decision_fragments
    where run_id = ${runId} and kind = 'human_action'
  `);
  return Number(r.rows?.[0]?.n ?? -1);
}

async function main() {
  console.log('[decision:recovery-smoke] running');
  const companyNumber = `RECOV-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;

  // --- seed: dossier + running run paused (conceptually) at await_decision
  const dossier = await repo.upsertDossier({ companyNumber, companyName: 'Recovery Smoke Ltd' });
  const run = await repo.createRun({ dossierId: dossier.id, threadId: randomUUID(), trigger: 'initial' });
  await repo.updateDossierCaseStatus(companyNumber, { caseStatus: 'standard_review', runId: run.id });

  // --- 1. apply the decision with resumeOwed, but DO NOT resume (crash sim)
  const result = await applyDecision({
    companyNumber,
    runId: run.id,
    userId: 'tester',
    payload: { action: 'approve', userId: 'tester' },
    resumeOwed: true,
  });
  ok('decision applied', result.ok === true && result.caseStatus === 'approved');

  let fresh = await repo.getRun(run.id);
  ok('run still running after apply (resume never dispatched)', fresh.status === 'running', `status=${fresh.status}`);
  ok('resume_owed_at set atomically with the decision', fresh.resumeOwedAt != null, `resumeOwedAt=${fresh.resumeOwedAt}`);
  const fragsBefore = await humanActionCount(run.id);
  ok('exactly one human_action fragment', fragsBefore === 1, `got=${fragsBefore}`);

  // --- 2. boot reconciler drains the owed resume
  const stats = await reconcileOwedResumes();
  ok('reconciler drained ≥1 run', stats.drained >= 1, JSON.stringify(stats));

  fresh = await repo.getRun(run.id);
  ok('run settled (no checkpoint → closed done)', fresh.status === 'done', `status=${fresh.status}`);
  ok('resume_owed_at cleared', fresh.resumeOwedAt == null, `resumeOwedAt=${fresh.resumeOwedAt}`);
  const fragsAfter = await humanActionCount(run.id);
  ok('no duplicate human_action fragment', fragsAfter === 1, `got=${fragsAfter}`);
  const status = await repo.getCaseStatus(companyNumber);
  ok('case_status untouched by reconciler', status?.caseStatus === 'approved', `got=${status?.caseStatus}`);

  // --- 3. reconciler is idempotent — second drain finds nothing
  const stats2 = await reconcileOwedResumes();
  ok('second drain is a no-op', stats2.drained === 0, JSON.stringify(stats2));

  // --- 4. RESUME_RECONCILE=off short-circuits
  process.env.RESUME_RECONCILE = 'off';
  const stats3 = await reconcileOwedResumes();
  ok('RESUME_RECONCILE=off disables the drain', stats3.drained === 0 && stats3.replayed === 0);
  delete process.env.RESUME_RECONCILE;

  // --- cleanup
  await repo.deleteDossier(companyNumber);
  console.log('[decision:recovery-smoke] done');
}

main()
  .catch((err) => {
    console.error('[decision:recovery-smoke] FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
