// Phase 5 / Q1 — QA + final-decision data-foundation smoke.
// Verifies:
//   * migration 0009 applied (case_status enum, fragment_kind 'human_action',
//     dossiers case_status* columns, runs.qa_result column).
//   * updateDossierCaseStatus / getCaseStatus round-trip.
//   * setRunQaResult writes a jsonb blob without touching endedAt/status.
//   * appendHumanActionFragment inserts a row with kind='human_action'
//     and the right inputs/outputs shape.
//   * listDossiers({ caseStatus }) filters correctly for both a single
//     value and an array.
//   * getLatestRunWithSnapshots picks the right run.
//
// Seeds its own dossier + run. No Companies House traffic. No graph thread.

const { randomUUID: uuid } = require('crypto');
const { sql } = require('drizzle-orm');
const { db, pool } = require('../db/client');
const repo = require('../db/repo');

const COMPANY_NUMBER = `QASMOKE-${Date.now()}`;

function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  console.log(`[qa:data-smoke] using company_number=${COMPANY_NUMBER}`);

  // 1. Migration applied — enum + columns
  const enumRow = await db.execute(sql`
    select array_agg(enumlabel order by enumsortorder) as labels
    from pg_enum
    where enumtypid = 'public.case_status'::regtype
  `);
  const labels = enumRow.rows?.[0]?.labels || [];
  const expectedLabels = [
    'pending',
    'auto_approved',
    'streamlined_review',
    'standard_review',
    'info_requested',
    'approved',
    'rejected',
    'escalated',
  ];
  ok(
    'case_status enum has all 8 values',
    expectedLabels.every((l) => labels.includes(l)),
    `got=${JSON.stringify(labels)}`,
  );

  const kindRow = await db.execute(sql`
    select array_agg(enumlabel) as labels
    from pg_enum
    where enumtypid = 'public.fragment_kind'::regtype
  `);
  const kindLabels = kindRow.rows?.[0]?.labels || [];
  ok(
    "fragment_kind enum includes 'human_action'",
    kindLabels.includes('human_action'),
    `got=${JSON.stringify(kindLabels)}`,
  );

  const colRow = await db.execute(sql`
    select column_name
    from information_schema.columns
    where table_name = 'dossiers'
      and column_name in ('case_status', 'case_status_updated_at', 'case_status_run_id')
  `);
  const cols = (colRow.rows || []).map((r) => r.column_name);
  ok(
    'dossiers has case_status* triplet',
    cols.length === 3,
    `got=${JSON.stringify(cols)}`,
  );

  const qaColRow = await db.execute(sql`
    select count(*)::int as n
    from information_schema.columns
    where table_name = 'runs' and column_name = 'qa_result'
  `);
  ok(
    'runs.qa_result column exists',
    (qaColRow.rows?.[0]?.n ?? 0) === 1,
  );

  // 2. Seed a dossier + run
  const dossier = await repo.upsertDossier({
    companyNumber: COMPANY_NUMBER,
    companyName: 'QA Smoke Co Ltd',
  });
  ok('dossier created', !!dossier?.id, `id=${dossier.id}`);
  ok(
    'new dossier defaults to case_status=pending',
    dossier.caseStatus === 'pending',
    `got=${dossier.caseStatus}`,
  );

  const run = await repo.createRun({
    dossierId: dossier.id,
    threadId: uuid(),
    trigger: 'initial',
  });
  ok('run created', !!run?.id, `id=${run.id}`);

  // 3. updateDossierCaseStatus
  const updated = await repo.updateDossierCaseStatus(COMPANY_NUMBER, {
    caseStatus: 'standard_review',
    runId: run.id,
  });
  ok(
    'updateDossierCaseStatus set status',
    updated?.caseStatus === 'standard_review',
    `got=${updated?.caseStatus}`,
  );
  ok(
    'updateDossierCaseStatus stamped updated_at',
    !!updated?.caseStatusUpdatedAt,
  );
  ok(
    'updateDossierCaseStatus wired run_id',
    updated?.caseStatusRunId === run.id,
    `got=${updated?.caseStatusRunId}`,
  );

  // Idempotency — re-apply
  const reapplied = await repo.updateDossierCaseStatus(COMPANY_NUMBER, {
    caseStatus: 'standard_review',
    runId: run.id,
  });
  ok(
    'idempotent re-apply succeeds',
    reapplied?.caseStatus === 'standard_review',
  );

  // 4. getCaseStatus
  const status = await repo.getCaseStatus(COMPANY_NUMBER);
  ok(
    'getCaseStatus returns the triplet',
    status?.caseStatus === 'standard_review'
      && status?.caseStatusRunId === run.id
      && !!status?.caseStatusUpdatedAt,
    JSON.stringify(status),
  );

  // 5. setRunQaResult
  const qa = {
    passed: false,
    completeness: { passed: true, missing: [] },
    consistency: {
      passed: false,
      issues: [{ code: 'ubo_not_screened', message: 'missing UBO' }],
    },
    routing: {
      caseStatus: 'standard_review',
      qaSummary: 'QA failed: 0 completeness issue(s), 1 consistency issue(s) → standard review.',
    },
    highlightedIssues: [],
    qaSummary: 'QA failed: 0 completeness issue(s), 1 consistency issue(s) → standard review.',
    tier: 'Medium',
    evaluatedAt: new Date().toISOString(),
  };
  const beforeEndedAt = (await db.execute(sql`select ended_at from runs where id = ${run.id}`))
    .rows?.[0]?.ended_at;
  await repo.setRunQaResult(run.id, qa);
  const writtenRow = await db.execute(sql`select qa_result, ended_at, status, error from runs where id = ${run.id}`);
  const w = writtenRow.rows?.[0];
  ok('setRunQaResult wrote qa_result', !!w?.qa_result);
  ok(
    'setRunQaResult preserved ended_at',
    String(w?.ended_at) === String(beforeEndedAt),
  );
  ok(
    'setRunQaResult preserved status (still running)',
    w?.status === 'running',
    `got=${w?.status}`,
  );

  // 6. human_action fragment shape. The canonical writer is now
  // services/decision#applyDecision (txn) — repo.appendHumanActionFragment no
  // longer exists. This smoke checks the same row shape through the data
  // layer applyDecision uses: appendFragment with kind='human_action' and a
  // per-run max+1 sequence.
  async function insertHumanAction(runId, { userId, action, metadata, summary }) {
    const seqRow = await db.execute(
      sql`select coalesce(max(sequence), -1) + 1 as next from decision_fragments where run_id = ${runId}`,
    );
    const sequence = Number(seqRow.rows?.[0]?.next ?? 0);
    return repo.appendFragment({
      runId,
      nodeId: 'human_decision',
      sequence,
      kind: 'human_action',
      status: 'ok',
      summary,
      inputs: { userId, action, runId },
      outputs: { ...metadata, timestamp: new Date().toISOString() },
    });
  }

  const frag = await insertHumanAction(run.id, {
    userId: 'local-user',
    action: 'approve',
    metadata: {},
    summary: 'User local-user approved case',
  });
  ok('human_action fragment inserted', !!frag?.id, `id=${frag?.id}`);
  ok(
    "fragment kind='human_action'",
    frag?.kind === 'human_action',
    `got=${frag?.kind}`,
  );
  ok(
    "fragment nodeId='human_decision'",
    frag?.nodeId === 'human_decision',
  );
  ok(
    'fragment.inputs.userId set',
    frag?.inputs?.userId === 'local-user',
    JSON.stringify(frag?.inputs),
  );
  ok(
    'fragment.outputs.timestamp set',
    !!frag?.outputs?.timestamp,
  );

  // Insert one more — sequences should increment per-run
  const frag2 = await insertHumanAction(run.id, {
    userId: 'local-user',
    action: 'escalate',
    metadata: { notes: 'second action on same run' },
    summary: 'User local-user escalated case',
  });
  ok(
    'sequence increments for repeated inserts',
    frag2.sequence > frag.sequence,
    `seq1=${frag.sequence} seq2=${frag2.sequence}`,
  );

  // 7. listDossiers caseStatus filter — single string
  const single = await repo.listDossiers({ caseStatus: 'standard_review' });
  const inSingle = single.find((d) => d.companyNumber === COMPANY_NUMBER);
  ok(
    "listDossiers({ caseStatus: 'standard_review' }) includes our dossier",
    !!inSingle,
    `count=${single.length}`,
  );

  const nonMatching = await repo.listDossiers({ caseStatus: 'approved' });
  ok(
    "listDossiers({ caseStatus: 'approved' }) excludes our standard_review dossier",
    !nonMatching.some((d) => d.companyNumber === COMPANY_NUMBER),
  );

  // listDossiers caseStatus filter — array
  const multi = await repo.listDossiers({
    caseStatus: ['standard_review', 'streamlined_review'],
  });
  ok(
    "listDossiers({ caseStatus: ['standard_review', 'streamlined_review'] }) includes our dossier",
    multi.some((d) => d.companyNumber === COMPANY_NUMBER),
  );

  // 8. getLatestRunWithSnapshots — should be null before snapshots are persisted
  const beforeSnap = await repo.getLatestRunWithSnapshots(COMPANY_NUMBER);
  ok(
    'getLatestRunWithSnapshots returns null before snapshots',
    beforeSnap === null,
    `got=${beforeSnap?.id}`,
  );

  await repo.closeRun(run.id, {
    status: 'done',
    finalProfile: { company_name: 'QA Smoke Co Ltd' },
    finalKycCard: { identity: { name: 'QA Smoke Co Ltd' } },
    finalScreeningReport: { summary: { overallRisk: 'low' } },
    finalRiskAssessment: { score: 12, tier: 'Low' },
  });
  const afterSnap = await repo.getLatestRunWithSnapshots(COMPANY_NUMBER);
  ok(
    'getLatestRunWithSnapshots picks the run once all four snapshots are set',
    afterSnap?.id === run.id,
    `got=${afterSnap?.id}`,
  );

  // cleanup
  console.log('[qa:data-smoke] cleanup');
  await repo.deleteDossier(COMPANY_NUMBER);
  const afterDelete = await repo.getDossier(COMPANY_NUMBER);
  ok('dossier deleted (cascades runs+fragments)', afterDelete === null);

  console.log('[qa:data-smoke] done');
}

main()
  .catch((err) => {
    console.error('[qa:data-smoke] FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
