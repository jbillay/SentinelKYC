// Phase 5 / Q3 — QA graph integration smoke.
//
// Drives compiledScreeningOnlyGraph end-to-end against a fixture initial state
// engineered so screening produces zero hits (deterministic, no LLM calls
// inside screening, no GDELT traffic). assess_risk's LLM rationale falls back
// to the template if Ollama is unavailable. Mirrors enough of the SSE pump
// in server/index.js to persist what the graph produces.
//
// Asserts:
//   * runs.qa_result jsonb populated.
//   * dossiers.case_status flipped from 'pending' to a QA-routed value.
//   * a decision_fragments row with node_id='qa_check' exists.

const { randomUUID: uuid } = require('crypto');
const { sql } = require('drizzle-orm');
const { db, pool } = require('../db/client');
const repo = require('../db/repo');
const { compiledScreeningOnlyGraph } = require('../graph/build');
const { seedRiskMatrix } = require('../services/risk/seed');

const COMPANY_NUMBER = `QAINT-${Date.now()}`;

function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

// Mirror the lifting in server/index.js#emitDelta — but minimal: we only need
// fragments + qaResult + case_status to land in the DB. Screening hits are
// guaranteed empty by the fixture, so no need to mirror that part.
function makeChunkPersister(runId, companyNumber) {
  let lastFragmentLen = 0;
  let qaPersisted = false;
  let lastCaseStatus = null;

  return async function persist(chunk) {
    const fragments = chunk.fragments || [];
    for (let i = lastFragmentLen; i < fragments.length; i++) {
      const f = fragments[i];
      try {
        await repo.appendFragment({
          id: f.id,
          runId,
          parentFragmentId: f.parentFragmentId ?? null,
          nodeId: f.nodeId,
          sequence: i,
          kind: f.kind,
          status: f.status,
          startedAt: f.startedAt,
          durationMs: f.durationMs,
          summary: f.summary,
          inputs: f.inputs,
          outputs: f.outputs,
          error: f.error,
        });
      } catch (err) {
        console.error(`[persist] appendFragment ${f.nodeId} failed:`, err.message);
      }
    }
    lastFragmentLen = fragments.length;

    if (chunk.qaResult && !qaPersisted) {
      await repo.setRunQaResult(runId, chunk.qaResult);
      const next = await repo.updateDossierCaseStatus(companyNumber, {
        caseStatus: chunk.qaResult.routing.caseStatus,
        runId,
      });
      lastCaseStatus = next?.caseStatus ?? null;
      qaPersisted = true;
    }
  };
}

async function main() {
  console.log(`[qa:integration-smoke] using company_number=${COMPANY_NUMBER}`);

  // Risk matrix needs to be seeded for assess_risk + qa_check to run.
  await seedRiskMatrix();

  const threadId = uuid();
  const dossier = await repo.upsertDossier({
    companyNumber: COMPANY_NUMBER,
    companyName: 'QASmoke Holdings Limited',
  });
  const run = await repo.createRun({
    dossierId: dossier.id,
    threadId,
    trigger: 'rescreen',
  });
  ok('seed: dossier created', !!dossier?.id);
  ok('seed: run created', !!run?.id);
  ok('seed: dossier case_status defaults to pending', dossier.caseStatus === 'pending');

  // Fixture: company-only, no individuals → screen_adverse_media skips,
  // sanctions matching on a fake first-token finds zero candidates,
  // evaluate_sanctions_hits skips. assess_risk + qa_check run for real.
  const initialState = {
    companyNumber: COMPANY_NUMBER,
    profile: {
      company_name: 'QASmoke Holdings Limited',
      company_number: COMPANY_NUMBER,
      company_status: 'active',
      company_type: 'ltd',
      registered_office_address: {
        postal_code: 'EC2A 4DP',
        country: 'United Kingdom',
      },
      sic_codes: ['62012'],
    },
    officers: { items: [] },
    psc: { items: [] },
    kycCard: {
      identity: {
        name: 'QASmoke Holdings Limited',
        companyNumber: COMPANY_NUMBER,
        status: 'active',
        type: 'ltd',
        countryOfIncorporation: 'United Kingdom',
      },
      addresses: { registered: 'EC2A 4DP' },
      officers: [],
      psc: [],
      shareholders: [],
      documents: [],
      redFlags: [],
      sourceTrace: {},
    },
    documents: [],
  };

  const config = {
    configurable: {
      thread_id: threadId,
      threadId,
      runId: run.id,
      dossierId: dossier.id,
      forceFresh: true,
    },
  };

  const persist = makeChunkPersister(run.id, COMPANY_NUMBER);

  console.log('[qa:integration-smoke] driving screeningOnlyGraph');
  const stream = await compiledScreeningOnlyGraph.stream(initialState, {
    ...config,
    streamMode: 'values',
  });

  // A review-routed case now pauses at the await_decision interrupt, so the
  // very last emission is the `__interrupt__` marker — track the last VALUES
  // chunk separately (that's where qaResult lives).
  let lastChunk = null;
  let interrupted = false;
  for await (const chunk of stream) {
    if (chunk && chunk.__interrupt__) {
      interrupted = true;
      continue;
    }
    lastChunk = chunk;
    await persist(chunk);
  }

  ok('stream completed', !!lastChunk);
  ok('graph emitted qaResult on final values chunk', !!lastChunk?.qaResult,
    `keys=${lastChunk ? Object.keys(lastChunk).join(',') : 'none'}`);
  // R4a — the identity helper resolved this run's ids and wrote them through
  // into state; assert they match the run row (guards ensureRunIdentity).
  ok('state.runId equals run row id (R4a write-through)',
    lastChunk?.runId === run.id,
    `state=${lastChunk?.runId} run=${run.id}`);
  ok('state.dossierId equals dossier row id (R4a write-through)',
    lastChunk?.dossierId === dossier.id,
    `state=${lastChunk?.dossierId} dossier=${dossier.id}`);

  // Re-read from DB
  const fresh = await repo.getRun(run.id);
  ok('runs.qa_result persisted', !!fresh?.qaResult,
    `qa_result=${fresh?.qaResult ? 'present' : 'null'}`);
  ok(
    'qa_result.routing.caseStatus is a valid value',
    ['auto_approved', 'streamlined_review', 'standard_review'].includes(
      fresh?.qaResult?.routing?.caseStatus,
    ),
    `got=${fresh?.qaResult?.routing?.caseStatus}`,
  );

  const status = await repo.getCaseStatus(COMPANY_NUMBER);
  ok(
    'dossiers.case_status updated from pending',
    status?.caseStatus && status.caseStatus !== 'pending',
    `got=${status?.caseStatus}`,
  );
  ok(
    'dossiers.case_status equals qa routing decision',
    status?.caseStatus === fresh?.qaResult?.routing?.caseStatus,
    `dossier=${status?.caseStatus} qa=${fresh?.qaResult?.routing?.caseStatus}`,
  );
  ok(
    'dossiers.case_status_run_id wired to this run',
    status?.caseStatusRunId === run.id,
    `got=${status?.caseStatusRunId}`,
  );

  // Verify qa_check fragment row
  const fragRow = await db.execute(sql`
    select node_id, kind, status, summary
    from decision_fragments
    where run_id = ${run.id} and node_id = 'qa_check'
    limit 1
  `);
  const frag = fragRow.rows?.[0];
  ok('decision_fragments has node_id=qa_check', !!frag,
    frag ? `kind=${frag.kind} status=${frag.status}` : 'no row');
  ok("qa_check fragment kind='decision'", frag?.kind === 'decision');

  // GET /api/dossiers/:cn/runs/:runId/qa would return this — verify the
  // jsonb body has the expected shape (mirrors what the endpoint reads).
  const qa = fresh.qaResult;
  ok('qaResult.passed is boolean', typeof qa?.passed === 'boolean');
  ok('qaResult.completeness present', !!qa?.completeness && Array.isArray(qa.completeness.missing));
  ok('qaResult.consistency present', !!qa?.consistency && Array.isArray(qa.consistency.issues));
  ok('qaResult.highlightedIssues is array', Array.isArray(qa?.highlightedIssues));
  ok('qaResult.tier is a known tier',
    ['Low', 'Medium', 'High'].includes(qa?.tier),
    `got=${qa?.tier}`);
  ok('qaResult.evaluatedAt is parseable', !!Date.parse(qa?.evaluatedAt ?? ''));

  // ---------------------------------------------------------------------------
  // POST .../qa/recompute — replay against the active matrix without spawning
  // a new graph thread. Pre-fills snapshots so getLatestRunWithSnapshots picks
  // up this run.
  // ---------------------------------------------------------------------------
  console.log('[qa:integration-smoke] simulating /qa/recompute');
  await repo.closeRun(run.id, {
    status: 'done',
    finalProfile: initialState.profile,
    finalKycCard: initialState.kycCard,
    finalOfficers: initialState.officers,
    finalPsc: initialState.psc,
    finalDocuments: lastChunk?.documents ?? [],
    finalScreeningReport: lastChunk?.screeningReport ?? null,
    finalRiskAssessment: lastChunk?.riskAssessment ?? null,
  });

  const matrixService = require('../services/risk/matrix');
  const qaService = require('../services/qa');
  const matrix = await matrixService.loadActiveMatrix();
  const synthetic = {
    profile: initialState.profile,
    officers: initialState.officers,
    psc: initialState.psc,
    kycCard: initialState.kycCard,
    documents: lastChunk?.documents ?? [],
    screeningReport: lastChunk?.screeningReport ?? null,
    riskAssessment: lastChunk?.riskAssessment ?? null,
  };
  const recomputed = qaService.evaluateQa({ state: synthetic, matrix });
  ok(
    'recompute deterministic — same routing as the graph run',
    recomputed.routing.caseStatus === fresh.qaResult.routing.caseStatus,
    `graph=${fresh.qaResult.routing.caseStatus} recompute=${recomputed.routing.caseStatus}`,
  );
  await repo.setRunQaResult(run.id, recomputed);

  // A standard_review case pauses at await_decision — the SSE runtime only
  // freezes final_* snapshots at a clean terminus, which this direct-driven
  // smoke never reaches. Simulate that closeRun to exercise the
  // snapshot-bearing lookup the recompute endpoint depends on.
  ok('graph paused at await_decision for review-routed case', interrupted === true);
  await repo.closeRun(run.id, {
    status: 'done',
    finalProfile: initialState.profile,
    finalKycCard: initialState.kycCard,
    finalScreeningReport: lastChunk?.screeningReport ?? null,
    finalRiskAssessment: lastChunk?.riskAssessment ?? null,
  });
  const latest = await repo.getLatestRunWithSnapshots(COMPANY_NUMBER);
  ok(
    'getLatestRunWithSnapshots picks our (now-snapshot-bearing) run',
    latest?.id === run.id,
    `got=${latest?.id}`,
  );

  // cleanup
  console.log('[qa:integration-smoke] cleanup');
  await repo.deleteDossier(COMPANY_NUMBER);

  console.log('[qa:integration-smoke] done');
}

main()
  .catch((err) => {
    console.error('[qa:integration-smoke] FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
