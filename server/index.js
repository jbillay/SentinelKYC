// Express app composition root. Wires global middleware (CORS, JSON, error
// handler), invokes each route module's register(app), boots the LLM probe
// loop + sanctions/runs reapers, and listens on HOST:PORT.
//
// The SSE runtime + run registry live in ./sse/runtime; per-domain routes
// in ./routes/*. See CODE_REVIEW §4.1.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

// Screening evaluators make 11+ LLM calls in one run, each attaching an 'abort'
// listener to LangGraph's shared run-level AbortSignal via ChatOllama → undici
// fetch. Not a real leak (signal is GC'd at run end), but Node's default cap
// of 10 fires a MaxListenersExceededWarning. Bump the EventTarget default.
const events = require('events');
events.setMaxListeners(50);

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const pinoHttp = require('pino-http');

const { setProcessKind } = require('./services/log');
const log = setProcessKind('web');
const promptsService = require('./services/prompts');
const { seedRiskMatrix } = require('./services/risk/seed');
const repo = require('./db/repo');
const { reapCheckpoints } = require('./scripts/checkpoint-reap');
const { registry } = require('./sse/runtime');
const { isQueueMode, getBoss } = require('./services/queue');
const { runEventsBus } = require('./services/runEventsBus');
const { reconcileOwedResumes } = require('./services/resumeReconciler');

const { buildSessionMiddleware } = require('./services/auth/session');
const {
  authMiddleware,
  requireAuth,
  csrfProtection,
  readUserId,
} = require('./services/auth');

const authRoutes = require('./routes/auth');
const runsRoutes = require('./routes/runs');
const dossiersRoutes = require('./routes/dossiers');
const screeningRoutes = require('./routes/screening');
const riskRoutes = require('./routes/risk');
const qaRoutes = require('./routes/qa');
const decisionRoutes = require('./routes/decision');
const promptsRoutes = require('./routes/prompts');
const documentsRoutes = require('./routes/documents');
const healthRoutes = require('./routes/health');
const metaRoutes = require('./routes/meta');
const partiesRoutes = require('./routes/parties');
const agentsRoutes = require('./routes/agents');
const adminRoutes = require('./routes/admin');
const docsRoutes = require('./routes/docs');
const { seedAgentConfigs } = require('./agents/config');

const app = express();

// Security headers (Phase 4). CSP is off: this process serves JSON plus the
// self-contained /api/docs page (which loads Swagger UI from a CDN); the SPA
// itself is served by Vite, not Express. COEP off so the docs page can load
// those CDN assets.
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));

// CORS pinned to the Vite dev origin (and same-origin / non-browser callers
// via the no-Origin allowance). See CODE_REVIEW §4.2.
const ALLOWED_CORS_ORIGINS = (process.env.CORS_ORIGIN || 'http://localhost:5173,http://127.0.0.1:5173')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);
app.use(
  cors({
    origin(origin, cb) {
      if (!origin || ALLOWED_CORS_ORIGINS.includes(origin)) return cb(null, true);
      return cb(new Error(`CORS: origin ${origin} not allowed`));
    },
    // credentials:true so the browser sends the session cookie cross-origin
    // (Vite dev :5173 → API :3000). Origins are still pinned above.
    credentials: true,
  }),
);
app.use(express.json());

// R7 — structured HTTP request logging. SSE streams are long-poll and would
// spam a line per connection lifetime; health is probed every few seconds by
// the UI banner. Skip both.
app.use(
  pinoHttp({
    logger: log,
    autoLogging: {
      ignore: (req) => req.url.startsWith('/api/stream') || req.url.startsWith('/api/health'),
    },
  }),
);

// --- R1 auth pipeline -----------------------------------------------------
// Order matters: session → identity → CSRF → auth gate → role guards → routes.
app.use(buildSessionMiddleware());
app.use(authMiddleware); // sets req.auth from the session (or dev bypass)
app.use(csrfProtection); // double-submit token on mutating /api requests

// Auth gate: everything under /api requires a verified session EXCEPT the
// auth endpoints themselves and the public health probe. SSE (GET /api/stream)
// passes because EventSource sends the session cookie automatically.
const PUBLIC_API = [/^\/api\/auth\/(login|logout|csrf|me)$/, /^\/api\/health$/];
app.use((req, res, next) => {
  if (req.method === 'OPTIONS') return next();
  if (!req.path.startsWith('/api/')) return next();
  if (PUBLIC_API.some((re) => re.test(req.path))) return next();
  return requireAuth(req, res, next);
});

// Role guards live INSIDE each route module, next to the handler they protect
// (the old central list here is how the screening/parties guards got missed —
// CODE_REVIEW §3.2). Hierarchy: admin > reviewer > analyst. Current tiers:
//   reviewer — final decision, screening hit overrides + carry-forward,
//              party overrides / merge / review-queue resolve / watchlist.
//   admin    — prompt edits, risk matrix edits, screening config.
authRoutes.register(app);
runsRoutes.register(app);
dossiersRoutes.register(app);
screeningRoutes.register(app);
riskRoutes.register(app);
qaRoutes.register(app);
decisionRoutes.register(app, { readUserId });
promptsRoutes.register(app);
documentsRoutes.register(app);
healthRoutes.register(app);
metaRoutes.register(app);
partiesRoutes.register(app, { readUserId });
agentsRoutes.register(app);
adminRoutes.register(app);
docsRoutes.register(app);

// Global error handler. Routes that catch and re-throw via next(err) land here,
// as do unhandled rejections inside express middleware. Map typed errors to
// stable codes and hide raw err.message from clients (it often leaks DB
// column names / constraint failures). Full err is logged server-side.
// See CODE_REVIEW §4.2.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  log.error({ method: req.method, url: req.originalUrl, err }, 'unhandled route error');
  if (res.headersSent) return;
  if (err.code === 'invalid_transition') {
    return res.status(409).json({ error: 'invalid_transition', from: err.from, action: err.action });
  }
  if (err.code === 'invalid_threshold') {
    return res.status(400).json({ error: 'invalid_threshold' });
  }
  if (err.code === 'invalid_payload') {
    return res.status(400).json({ error: 'invalid_payload' });
  }
  if (err.code === 'not_found') {
    return res.status(404).json({ error: err.message || 'not_found' });
  }
  res.status(500).json({ error: 'internal_error' });
});

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '127.0.0.1';

async function start() {
  try {
    await promptsService.seedPrompts();
    log.info('[prompts] registry seeded');
  } catch (err) {
    log.error(`[prompts] seed failed: ${err.message}`);
  }

  try {
    await seedAgentConfigs();
    log.info('[agents] config registry seeded');
  } catch (err) {
    log.error(`[agents] config seed failed: ${err.message}`);
  }

  try {
    await seedRiskMatrix();
    log.info('[risk] matrix registry seeded');
  } catch (err) {
    log.error(`[risk] matrix seed failed: ${err.message}`);
  }

  try {
    const reaped = await repo.reapStaleRuns({ olderThanMinutes: 120 });
    if (reaped > 0) log.warn(`[runs] reaped ${reaped} stale run(s) left over from prior shutdown`);
  } catch (err) {
    log.error(`[runs] reaper failed: ${err.message}`);
  }

  // R4b: drain decision-applied-but-resume-lost runs (resume_owed_at set).
  // Mode-aware: inline replays in-process from the SQLite checkpoint; queue
  // enqueues durable resume jobs for the worker. RESUME_RECONCILE=off skips.
  try {
    await reconcileOwedResumes();
  } catch (err) {
    log.error(`[resumeReconciler] boot drain failed: ${err.message}`);
  }

  // R2: durable run execution. In inline mode (default) nothing changes — runs
  // execute in this process. In queue mode the web process only enqueues jobs
  // (server/worker.js drives them) and relays their SSE events from run_events.
  if (isQueueMode()) {
    try {
      await getBoss(); // start pg-boss so enqueue is ready + connection verified
      await runEventsBus.start(); // LISTEN run_events → fan out to SSE clients
      await repo.reapRunEvents({ olderThanHours: 24 });
      log.info('[runs] RUN_EXECUTION=queue — enqueue to pg-boss, SSE via run_events bus. Start the worker: npm run worker');
    } catch (err) {
      log.error(`[fatal] queue mode startup failed: ${err.message}`);
      process.exit(1);
    }
  } else {
    log.info('[runs] RUN_EXECUTION=inline — runs execute in-process (default)');
  }

  // Reap LangGraph checkpoints for long-terminal runs — graph-checkpoints.db
  // grows without bound otherwise (CODE_REVIEW §5.1). Best-effort; VACUUM only
  // when a meaningful number of rows went away.
  reapCheckpoints({ vacuum: true, quiet: true })
    .then(({ threadsReaped, rowsDeleted }) => {
      if (threadsReaped > 0) {
        log.info(`[checkpoints] reaped ${threadsReaped} thread(s) (${rowsDeleted} rows)`);
      }
    })
    .catch((err) => log.warn(`[checkpoints] startup reap failed: ${err.message}`));

  // Downloaded filing PDFs under var/evidence are audit artifacts — no boot
  // reaper. Clearable caches live under var/cache (npm run var:clean).

  log.info('Probing LLM providers…');
  const initial = await healthRoutes.refreshLlmHealth();

  // LLM_BOOT_CHECK=strict (default): an unreachable LLM provider is fatal —
  // the right dev-machine behavior (a run would fail mid-pipeline anyway).
  // =warn: log and keep listening — for environments that exercise the HTTP
  // surface without LLMs (the CI auth smoke); the health banner still shows
  // the providers as down.
  const unreachable = ['ocr', 'reasoning'].filter((t) => !initial[t]?.ok);
  if (unreachable.length) {
    const strict = String(process.env.LLM_BOOT_CHECK || 'strict').toLowerCase() !== 'warn';
    const sev = strict ? 'error' : 'warn';
    log[sev](`${strict ? '[fatal] ' : ''}LLM provider unreachable for: ${unreachable.join(', ')}`);
    for (const t of unreachable) {
      const b = initial[t] || {};
      log[sev](`${t}: provider=${b.provider} model=${b.model} — ${b.detail || 'unreachable'}`);
    }
    if (strict) {
      log.error('ollama → start it with `ollama serve`; nvidia → check NVIDIA_API_KEY / connectivity.');
      process.exit(1);
    }
    log.warn('LLM_BOOT_CHECK=warn — starting anyway; runs will fail until a provider is reachable.');
  }

  let anyMissing = false;
  for (const t of ['ocr', 'reasoning']) {
    const b = initial[t] || {};
    for (const m of b.missing || []) {
      if (!anyMissing) {
        log.warn('LLM providers reachable but models missing:');
        anyMissing = true;
      }
      log.warn(`- [${t}] ${m}    ${b.provider === 'ollama' ? `(run: ollama pull ${m})` : '(check model id)'}`);
    }
  }
  if (anyMissing) {
    log.warn('The server will start, but runs will fail until they are available.');
  } else {
    log.info(
      `LLM OK · ocr=${initial.ocr.provider}:${initial.ocr.model} · reasoning=${initial.reasoning.provider}:${initial.reasoning.model}`,
    );
  }

  healthRoutes.startProbeLoop();
  registry.startHardReap();

  app.listen(PORT, HOST, () => {
    log.info(`server listening on http://${HOST}:${PORT}`);
  });
}

start().catch((err) => {
  log.error({ err }, '[fatal] startup failed');
  process.exit(1);
});
