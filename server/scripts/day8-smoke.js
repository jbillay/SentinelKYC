/**
 * Day 8 manual smoke:
 *   1. POST /api/run with {name: "BARCLAYS"} (or supplied)
 *   2. Listen to SSE; collect fragment events
 *   3. On interrupt, POST /api/resume with the test companyNumber
 *   4. Listen for ~30s OR until 'done' / a few post-resume fragments arrive
 *   5. Query pg via repo and report counts
 *
 * Stops short of full OCR/synthesize (which can take many minutes); we just need to
 * verify the fragment plumbing reaches pg.
 *
 * Auth (R1): the API now requires a session. Run the server with
 * `AUTH_DEV_BYPASS=true` so this script's `x-user-id` header is accepted (and
 * CSRF is skipped for the bypass actor).
 */

const NAME = process.argv[2] || 'BARCLAYS';
const COMPANY_NUMBER = process.argv[3] || '06500244';
const POST_RESUME_WINDOW_MS = 30_000;
const BASE = 'http://localhost:3000';
// Dev-bypass identity (server must run with AUTH_DEV_BYPASS=true).
const DEV_USER = process.env.SMOKE_USER_ID || 'smoke-runner';

const repo = require('../db/repo');
const { pool } = require('../db/client');

function log(...args) {
  process.stdout.write(args.join(' ') + '\n');
}

async function postJson(path, body) {
  const res = await fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-user-id': DEV_USER },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}`);
  return res.json();
}

async function readSSEUntil(threadId, predicate, timeoutMs) {
  const url = `${BASE}/api/stream/${threadId}`;
  const res = await fetch(url, { headers: { Accept: 'text/event-stream', 'x-user-id': DEV_USER } });
  if (!res.ok || !res.body) throw new Error(`stream ${threadId}: ${res.status}`);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  const events = [];
  const start = Date.now();

  while (true) {
    if (Date.now() - start > timeoutMs) {
      log(`  (stream timeout after ${timeoutMs}ms)`);
      break;
    }
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const chunks = buf.split(/\n\n/);
    buf = chunks.pop() || '';
    for (const chunk of chunks) {
      const dataLine = chunk.split('\n').find((l) => l.startsWith('data:'));
      if (!dataLine) continue;
      const json = dataLine.slice(5).trim();
      if (!json) continue;
      try {
        const evt = JSON.parse(json);
        events.push(evt);
        if (evt.type === 'fragment') {
          log(`  fragment[${evt.fragment.sequence}] ${evt.fragment.kind.padEnd(8)} ${evt.fragment.nodeId} :: ${evt.fragment.summary}`);
        } else if (evt.type === 'interrupt') {
          log(`  interrupt: ${evt.payload?.candidates?.length || 0} candidates`);
        } else if (evt.type === 'done') {
          log(`  done: ${evt.state?.runId ? 'runId=' + evt.state.runId.slice(0, 8) : 'no runId'}`);
        } else if (evt.type === 'error') {
          log(`  error: ${evt.message || evt.node}`);
        }
        if (predicate(evt)) {
          reader.cancel().catch(() => {});
          return events;
        }
      } catch {
        // ignore
      }
    }
  }
  reader.cancel().catch(() => {});
  return events;
}

async function main() {
  log(`[smoke] starting run for "${NAME}"`);
  const { threadId } = await postJson('/api/run', { name: NAME });
  log(`[smoke] threadId=${threadId.slice(0, 8)}`);

  log('[smoke] streaming until interrupt or done…');
  const phase1 = await readSSEUntil(
    threadId,
    (evt) => evt.type === 'interrupt' || evt.type === 'done' || evt.type === 'error',
    20_000
  );

  const interrupted = phase1.some((e) => e.type === 'interrupt');
  let phase2 = [];

  if (interrupted) {
    log(`[smoke] resuming with companyNumber=${COMPANY_NUMBER}`);
    await postJson(`/api/resume/${threadId}`, { companyNumber: COMPANY_NUMBER });

    log('[smoke] streaming after resume (will stop after first synthesize_card fragment, batch_done progress, or timeout)…');
    phase2 = await readSSEUntil(
      threadId,
      (evt) => {
        if (evt.type === 'done') return true;
        if (evt.type === 'fragment' && evt.fragment.nodeId === 'fetch_apis') {
          // fetch_apis fragment means the run row exists in pg → we can stop and check
          return false; // keep going a bit longer to see select_documents too
        }
        if (evt.type === 'fragment' && evt.fragment.nodeId === 'select_documents') {
          return true; // good enough — full OCR would take many minutes
        }
        if (evt.type === 'progress' && evt.stage === 'batch_start') return true;
        return false;
      },
      POST_RESUME_WINDOW_MS
    );
  }

  log('');
  log('[smoke] querying pg…');

  const dossier = await repo.getDossier(COMPANY_NUMBER);
  if (!dossier) {
    log(`✗ no dossier in pg for company ${COMPANY_NUMBER}`);
    process.exitCode = 1;
    await pool.end();
    return;
  }
  log(`✓ dossier persisted: ${dossier.companyName} (${dossier.companyNumber})  runs=${dossier.runs.length}`);

  const lastRun = dossier.runs[0];
  if (!lastRun) {
    log('✗ no runs');
    process.exitCode = 1;
    await pool.end();
    return;
  }
  const fullRun = await repo.getRun(lastRun.id);
  log(`✓ latest run: status=${fullRun.status}  trigger=${fullRun.trigger}  fragments=${fullRun.fragments.length}`);

  const decisionFrags = fullRun.fragments.filter((f) => f.kind === 'decision');
  const auditFrags = fullRun.fragments.filter((f) => f.kind === 'audit');
  log(`  decision fragments: ${decisionFrags.length}  audit fragments: ${auditFrags.length}`);

  // Sequence integrity
  const seqs = fullRun.fragments.map((f) => f.sequence);
  const seqOrdered = seqs.every((s, i) => i === 0 || s >= seqs[i - 1]);
  if (seqOrdered) log('✓ fragment sequence is non-decreasing');
  else log(`✗ sequences out of order: ${seqs.join(',')}`);

  // Sample
  log('');
  log('[smoke] sample of fragment summaries:');
  for (const f of fullRun.fragments) {
    log(`  [${String(f.sequence).padStart(2)}] ${f.kind.padEnd(8)} ${f.nodeId.padEnd(20)} ${f.durationMs ? `${f.durationMs}ms`.padEnd(8) : '       '} ${f.summary}`);
  }

  await pool.end();
}

main().catch(async (err) => {
  console.error('[smoke] failed:', err);
  process.exitCode = 1;
  try { await pool.end(); } catch {}
});
