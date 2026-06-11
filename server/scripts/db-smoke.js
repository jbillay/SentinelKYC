const { randomUUID: uuid } = require('crypto');
const { pool } = require('../db/client');
const repo = require('../db/repo');

const COMPANY_NUMBER = `SMOKE-${Date.now()}`;
const NODES = [
  { nodeId: 'gather_input',       kind: 'audit',    summary: 'Captured user input: name="ACME"' },
  { nodeId: 'search_ch',          kind: 'audit',    summary: 'CH search returned 3 candidates' },
  { nodeId: 'entity_resolution',  kind: 'decision', summary: 'Picked ACME LIMITED (12345678) at score 0.92, 0.31 ahead of #2' },
  { nodeId: 'await_confirmation', kind: 'decision', summary: 'Auto-confirmed (top score above threshold)' },
  { nodeId: 'synthesize_card',    kind: 'decision', summary: 'KYC card built: 3 officers, 2 PSCs, 1 shareholder' },
];

function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

async function main() {
  console.log(`[db:smoke] using company_number=${COMPANY_NUMBER}`);

  console.log('[db:smoke] upsertDossier');
  const dossier = await repo.upsertDossier({
    companyNumber: COMPANY_NUMBER,
    companyName: 'ACME LIMITED (smoke)',
  });
  ok('dossier created', !!dossier?.id, `id=${dossier.id}`);

  console.log('[db:smoke] createRun');
  const threadId = uuid();
  const run = await repo.createRun({
    dossierId: dossier.id,
    threadId,
    trigger: 'initial',
  });
  ok('run created with status=running', run?.status === 'running', `id=${run.id}`);

  console.log('[db:smoke] appendFragment x5');
  const startedAt = Date.now();
  for (let i = 0; i < NODES.length; i++) {
    const f = NODES[i];
    await repo.appendFragment({
      runId: run.id,
      nodeId: f.nodeId,
      sequence: i,
      kind: f.kind,
      status: 'ok',
      startedAt: startedAt + i * 1000,
      durationMs: 250 + i * 50,
      summary: f.summary,
      inputs: { i },
      outputs: { ok: true, i },
    });
  }

  console.log('[db:smoke] closeRun');
  await repo.closeRun(run.id, {
    status: 'done',
    finalKycCard: { identity: { name: 'ACME LIMITED' } },
    finalShareholderGraph: { nodes: [], edges: [] },
    finalDocuments: [],
  });

  console.log('[db:smoke] getRun');
  const fetched = await repo.getRun(run.id);
  ok('run fetched', !!fetched, `status=${fetched.status}`);
  ok('5 fragments persisted', fetched.fragments?.length === 5, `got=${fetched.fragments?.length}`);
  ok('fragment order preserved', fetched.fragments[0].nodeId === 'gather_input' && fetched.fragments[4].nodeId === 'synthesize_card');
  ok('decision-kind tagged', fetched.fragments.find((f) => f.nodeId === 'entity_resolution')?.kind === 'decision');
  ok('audit-kind tagged', fetched.fragments.find((f) => f.nodeId === 'gather_input')?.kind === 'audit');

  console.log('[db:smoke] listDossiers (q=SMOKE)');
  const list = await repo.listDossiers({ q: 'SMOKE' });
  ok('listed at least 1', list.length >= 1, `count=${list.length}`);
  const ours = list.find((d) => d.companyNumber === COMPANY_NUMBER);
  ok('latestRun attached', !!ours?.latestRun, `latest status=${ours?.latestRun?.status}`);
  ok('runCount=1', ours?.runCount === 1, `got=${ours?.runCount}`);

  console.log('[db:smoke] updateDossierMeta');
  const updated = await repo.updateDossierMeta(COMPANY_NUMBER, {
    tags: ['monitor'],
    notes: 'smoke test note',
  });
  ok('tags updated', JSON.stringify(updated?.tags) === JSON.stringify(['monitor']));
  ok('notes updated', updated?.notes === 'smoke test note');

  console.log('[db:smoke] cleanup');
  await repo.deleteDossier(COMPANY_NUMBER);
  const afterDelete = await repo.getDossier(COMPANY_NUMBER);
  ok('dossier deleted (cascades runs+fragments)', afterDelete === null);

  console.log('[db:smoke] done');
}

main()
  .catch((err) => {
    console.error('[db:smoke] FAILED:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
