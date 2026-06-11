// Phase 5 / Q4 — decision endpoint smoke.
//
// Drives the service-layer applyDecision + decisionPayloadSchema directly
// (the HTTP layer in index.js is a thin wrapper around these two). Asserts:
//
//   * each of the four actions round-trips: dossiers.case_status flips +
//     a decision_fragments row with kind='human_action' is inserted with
//     the right inputs/outputs shape.
//   * a follow-up action after approve/reject is rejected as
//     invalid_transition (proxy for 409).
//   * decisionPayloadSchema rejects malformed bodies (proxy for 400).
//
// Seeds its own dossier + run per action so the cases don't bleed.

const { randomUUID: uuid } = require('crypto');
const { sql } = require('drizzle-orm');
const { db, pool } = require('../db/client');
const repo = require('../db/repo');
const { applyDecision } = require('../services/decision');
const { decisionPayloadSchema } = require('../lib/decisionSchema');

function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

// Seed a dossier + run pre-set to a QA-routed status so applyDecision is
// allowed to run.
async function seedCase(prefix, fromStatus) {
  const companyNumber = `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const dossier = await repo.upsertDossier({
    companyNumber,
    companyName: `${prefix} Ltd`,
  });
  const run = await repo.createRun({
    dossierId: dossier.id,
    threadId: uuid(),
    trigger: 'initial',
  });
  await repo.updateDossierCaseStatus(companyNumber, {
    caseStatus: fromStatus,
    runId: run.id,
  });
  return { companyNumber, dossierId: dossier.id, runId: run.id };
}

async function fragmentFor(runId, action) {
  const r = await db.execute(sql`
    select id, node_id, kind, status, summary, inputs, outputs
    from decision_fragments
    where run_id = ${runId} and kind = 'human_action' and inputs->>'action' = ${action}
    order by sequence desc
    limit 1
  `);
  return r.rows?.[0] || null;
}

async function main() {
  console.log('[decision:smoke] running');

  // -------------------------------------------------------------------------
  // 1. approve — from streamlined_review
  // -------------------------------------------------------------------------
  {
    const c = await seedCase('DECAPPR', 'streamlined_review');
    const result = await applyDecision({
      companyNumber: c.companyNumber,
      runId: c.runId,
      userId: 'tester',
      payload: { action: 'approve', userId: 'tester' },
    });
    ok('approve: result.caseStatus = approved', result.caseStatus === 'approved',
      `got=${result.caseStatus}`);
    ok('approve: result has fragmentId', !!result.fragmentId);

    const s = await repo.getCaseStatus(c.companyNumber);
    ok('approve: dossier.case_status = approved', s?.caseStatus === 'approved',
      `got=${s?.caseStatus}`);
    ok('approve: case_status_run_id wired', s?.caseStatusRunId === c.runId);

    const frag = await fragmentFor(c.runId, 'approve');
    ok('approve: fragment kind=human_action', frag?.kind === 'human_action');
    ok("approve: fragment node_id=human_decision", frag?.node_id === 'human_decision');
    ok('approve: fragment inputs.userId=tester', frag?.inputs?.userId === 'tester');
    ok('approve: fragment outputs.timestamp present', !!frag?.outputs?.timestamp);
    ok('approve: fragment summary mentions approved', /approved/.test(frag?.summary || ''));

    await repo.deleteDossier(c.companyNumber);
  }

  // -------------------------------------------------------------------------
  // 2. reject — from standard_review with reasonCode + freeText
  // -------------------------------------------------------------------------
  {
    const c = await seedCase('DECREJ', 'standard_review');
    const payload = {
      action: 'reject',
      userId: 'tester',
      reasonCode: 'sanctions_hit',
      freeText: 'Confirmed match against OFAC SDN — entity is sanctioned.',
    };
    const result = await applyDecision({
      companyNumber: c.companyNumber,
      runId: c.runId,
      userId: 'tester',
      payload,
    });
    ok('reject: result.caseStatus = rejected', result.caseStatus === 'rejected');

    const s = await repo.getCaseStatus(c.companyNumber);
    ok('reject: dossier.case_status = rejected', s?.caseStatus === 'rejected');

    const frag = await fragmentFor(c.runId, 'reject');
    ok('reject: fragment outputs.reasonCode preserved',
      frag?.outputs?.reasonCode === 'sanctions_hit',
      JSON.stringify(frag?.outputs));
    ok('reject: fragment outputs.freeText preserved',
      typeof frag?.outputs?.freeText === 'string' && frag.outputs.freeText.length >= 10);
    ok('reject: fragment outputs has no userId (carried on inputs)',
      !('userId' in (frag?.outputs || {})),
      JSON.stringify(Object.keys(frag?.outputs || {})));
    ok('reject: summary mentions reasonCode',
      /sanctions_hit/.test(frag?.summary || ''));

    await repo.deleteDossier(c.companyNumber);
  }

  // -------------------------------------------------------------------------
  // 3. escalate — from standard_review with notes
  // -------------------------------------------------------------------------
  {
    const c = await seedCase('DECESC', 'standard_review');
    const payload = {
      action: 'escalate',
      userId: 'tester',
      notes: 'Needs senior reviewer — complex ownership chain spans 3 jurisdictions.',
      suggestedAction: 'Ask the compliance lead for guidance.',
    };
    const result = await applyDecision({
      companyNumber: c.companyNumber,
      runId: c.runId,
      userId: 'tester',
      payload,
    });
    ok('escalate: result.caseStatus = escalated', result.caseStatus === 'escalated');

    const frag = await fragmentFor(c.runId, 'escalate');
    ok('escalate: outputs.notes preserved',
      frag?.outputs?.notes === payload.notes,
      JSON.stringify(frag?.outputs?.notes));
    ok('escalate: outputs.suggestedAction preserved',
      frag?.outputs?.suggestedAction === payload.suggestedAction);

    await repo.deleteDossier(c.companyNumber);
  }

  // -------------------------------------------------------------------------
  // 4. request_info — from streamlined_review with items array
  // -------------------------------------------------------------------------
  {
    const c = await seedCase('DECINFO', 'streamlined_review');
    const payload = {
      action: 'request_info',
      userId: 'tester',
      items: [
        { description: 'Latest signed accounts', category: 'documents' },
        { description: 'Source of funds statement', category: 'compliance' },
      ],
    };
    const result = await applyDecision({
      companyNumber: c.companyNumber,
      runId: c.runId,
      userId: 'tester',
      payload,
    });
    ok('request_info: result.caseStatus = info_requested',
      result.caseStatus === 'info_requested');

    const frag = await fragmentFor(c.runId, 'request_info');
    ok('request_info: outputs.items preserved length',
      Array.isArray(frag?.outputs?.items) && frag.outputs.items.length === 2);
    ok('request_info: outputs.items[0].description preserved',
      frag?.outputs?.items?.[0]?.description === payload.items[0].description);

    await repo.deleteDossier(c.companyNumber);
  }

  // -------------------------------------------------------------------------
  // 5. Invalid transitions (proxy for 409)
  // -------------------------------------------------------------------------
  console.log('[decision:smoke] invalid transitions');

  // (a) approve from pending — ALLOWED since the await_decision interrupt:
  // case_status stays 'pending' through QA, so 'pending' is a valid entry
  // point for every action (see ALLOWED_FROM_* in services/decision/index.js).
  {
    const c = await seedCase('DECINVPND', 'pending');
    // seedCase set status to pending; reseed it because updateDossierCaseStatus only accepts a value
    await repo.updateDossierCaseStatus(c.companyNumber, { caseStatus: 'pending', runId: c.runId });
    let thrown = null;
    let result = null;
    try {
      result = await applyDecision({
        companyNumber: c.companyNumber,
        runId: c.runId,
        userId: 'tester',
        payload: { action: 'approve', userId: 'tester' },
      });
    } catch (err) {
      thrown = err;
    }
    ok('approve from pending succeeds (await_decision entry point)',
      thrown == null && result?.ok === true && result?.caseStatus === 'approved',
      `thrown=${thrown?.code} caseStatus=${result?.caseStatus}`);
    ok('previousCaseStatus reported as pending', result?.previousCaseStatus === 'pending');
    await repo.deleteDossier(c.companyNumber);
  }

  // (b) approve from info_requested — info_requested is in ALLOWED_FROM_ANY
  // but NOT in ALLOWED_FROM_APPROVE.
  {
    const c = await seedCase('DECINVIR', 'info_requested');
    let thrown = null;
    try {
      await applyDecision({
        companyNumber: c.companyNumber,
        runId: c.runId,
        userId: 'tester',
        payload: { action: 'approve', userId: 'tester' },
      });
    } catch (err) {
      thrown = err;
    }
    ok('approve from info_requested throws invalid_transition',
      thrown?.code === 'invalid_transition',
      `code=${thrown?.code} from=${thrown?.from}`);
    await repo.deleteDossier(c.companyNumber);
  }

  // (c) any action from already-approved — terminal state
  {
    const c = await seedCase('DECINVAP', 'streamlined_review');
    // First approve to get into terminal state
    await applyDecision({
      companyNumber: c.companyNumber,
      runId: c.runId,
      userId: 'tester',
      payload: { action: 'approve', userId: 'tester' },
    });
    // Now try to reject — should fail
    let thrown = null;
    try {
      await applyDecision({
        companyNumber: c.companyNumber,
        runId: c.runId,
        userId: 'tester',
        payload: {
          action: 'reject',
          userId: 'tester',
          reasonCode: 'other',
          freeText: 'Trying after approve should fail.',
        },
      });
    } catch (err) {
      thrown = err;
    }
    ok('reject from approved throws invalid_transition',
      thrown?.code === 'invalid_transition' && thrown?.from === 'approved',
      `code=${thrown?.code} from=${thrown?.from}`);
    await repo.deleteDossier(c.companyNumber);
  }

  // (d) escalate from escalated IS allowed (escalated is in ALLOWED_FROM_ANY)
  {
    const c = await seedCase('DECREESC', 'escalated');
    const result = await applyDecision({
      companyNumber: c.companyNumber,
      runId: c.runId,
      userId: 'tester',
      payload: { action: 'escalate', userId: 'tester', notes: 'Re-escalating with more context here.' },
    });
    ok('escalate from escalated succeeds (allowed)',
      result.caseStatus === 'escalated');
    await repo.deleteDossier(c.companyNumber);
  }

  // -------------------------------------------------------------------------
  // 6. Malformed payloads — decisionPayloadSchema (proxy for 400)
  // -------------------------------------------------------------------------
  console.log('[decision:smoke] payload validation');

  const reject = (label, payload) => {
    const r = decisionPayloadSchema.safeParse(payload);
    ok(label, r.success === false, r.success ? 'unexpectedly passed' : '');
  };

  reject('rejects unknown action', { action: 'foo', userId: 'tester' });
  reject('rejects approve without userId', { action: 'approve' });
  reject('rejects reject with freeText too short', {
    action: 'reject',
    userId: 'tester',
    reasonCode: 'other',
    freeText: 'nope',
  });
  reject('rejects reject with unknown reasonCode', {
    action: 'reject',
    userId: 'tester',
    reasonCode: 'made_up_code',
    freeText: 'A sufficiently long reason text here.',
  });
  reject('rejects escalate with short notes', {
    action: 'escalate',
    userId: 'tester',
    notes: 'too short',
  });
  reject('rejects request_info with empty items', {
    action: 'request_info',
    userId: 'tester',
    items: [],
  });
  reject('rejects request_info item with short description', {
    action: 'request_info',
    userId: 'tester',
    items: [{ description: 'no', category: 'foo' }],
  });

  // happy paths pass validation
  const acc = decisionPayloadSchema.safeParse({ action: 'approve', userId: 'tester' });
  ok('approve payload passes validation', acc.success);

  console.log('[decision:smoke] done');
}

main()
  .catch((err) => {
    console.error('[decision:smoke] FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
