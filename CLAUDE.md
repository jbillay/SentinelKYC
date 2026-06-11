# CLAUDE.md

Reference for AI coding agents working on this repo — the **agent quick-reference**. Keep this file concise — it's loaded into every Claude Code session. Docs live under `docs/` (index: `docs/README.md`). The **authoritative system-architecture view** lives in `docs/architecture/ARCHITECTURE.md` (also the consolidated improvement backlog); `docs/business/BUSINESS_PROCESS.md`, `docs/architecture/SCREENING_PLAN.md`, and `docs/architecture/IMPLEMENTATION.md` cover the case lifecycle, screening design, and phase tracker. The executed P0/P1 build plans and past code reviews are archived in `docs/archive/`. Read the relevant design doc before reshaping a subsystem.

## Project

UK company KYC proof-of-concept. The user searches Companies House by name (or company number), confirms the right entity, and the agent fetches the API surface + recent filings, runs OCR / structured extraction over them, produces a KYC dossier (identity, officers, PSC, shareholders, financials, red flags) plus a Cytoscape ownership graph, **resolves every party into a cross-dossier master record**, and **screens** every identified subject (company + officers + PSCs + shareholders) against locally cached sanctions lists (OFAC SDN, UK HMT) and live adverse-media (GDELT news). It then runs a deterministic weighted-factor **risk assessment**, a pure **QA gate** that routes the case, generates a regulator-style **narrative**, and either auto-approves (low risk) or pauses for a **human reviewer decision**. Runs are persisted as dossiers + runs + decision fragments + screening hits/evaluations + party links so a reviewer can audit every step, override any LLM decision, and diff successive runs.

**Scope**: POC. Single tenant, runs locally, no production observability. Auth is now real (app-owned users + server-side sessions + roles — see "Authentication (R1)"); the old "sign-in is a UX prop" guard is retired. Built to demonstrate value of agentic + OCR pipelines.

## Stack

- **Frontend**: Vue 3 (Composition API) + Vite + Vue Router + Pinia + Cytoscape.js (`cytoscape-dagre`)
- **Backend**: Node.js (CommonJS) + Express 5 + LangGraph.js (`@langchain/langgraph` 1.x, `@langchain/langgraph-checkpoint-sqlite`). Runs execute inline by default; with `RUN_EXECUTION=queue` they move onto a **pg-boss** (Postgres-backed) job queue + a separate **worker process** (R2 — see "Durable run execution").
- **LLMs via a pluggable provider abstraction** (`services/llm/*`): default **Ollama** (`glm-ocr` vision OCR, `llama3.1:8b` reasoning), with **NVIDIA NIM** as an optional per-task backend (`@langchain/openai`). Reasoning calls use `withStructuredOutput` for JSON. See "LLM provider" below.
- **PDF**: `pdf-parse` (text extract + `getScreenshot()` rasterizer; `pdfjs-dist` pinned via npm `overrides`). Pure JS, zero native deps.
- **Name matching**: `fastest-levenshtein`, `double-metaphone`, Postgres `pg_trgm` (trigram GIN) + `fuzzystrmatch` (phonetic).
- **Sanctions parse**: `fast-xml-parser` (OFAC), `papaparse` (HMT).
- **Persistence**:
  - Postgres (via `pg` + `drizzle-orm`) — dossiers, runs, decision fragments, prompt registry, sanctions lists/entries, screening hits/evaluations, dossier-level screening overrides, screening config singleton, risk matrix versions, QA results, **party master (8 tables)**, **users (auth)** + `session` (connect-pg-simple), **`run_events` (durable cross-process SSE channel, R2)**. Migrations in `server/db/migrations` (`0000`–`0024`) — **hand-written SQL; never run `drizzle-kit generate`** (removed from the repo — snapshots are stale by design, see `db/SETUP.md`). pg-boss manages its own `pgboss` schema (auto-created on `start()`, not a hand-written migration).
  - **Everything the server writes at runtime lives under `server/var/`** (override root with `DATA_DIR`; see `lib/dataDirs.js`):
    - `var/cache/dev-cache.db` — HTTP response cache (keyed by URL) + KV cache (OCR by file hash, country normalization, adverse-media by name+ISO-week). `better-sqlite3`. Clearable: `npm run var:clean`.
    - `var/checkpoints/graph-checkpoints.db` — LangGraph `SqliteSaver` thread checkpoints (one row per thread step, used to resume after `interrupt()`). NOT cleared by `var:clean` (would strand paused runs); reaped at boot for runs terminal > `CHECKPOINT_RETENTION_DAYS` (default 7) — also `npm run checkpoints:reap`.
    - `var/evidence/<companyNumber>/` — downloaded filing PDFs + rasterized PNGs. **Audit artifacts: never auto-deleted** (the old 30-day tmp reaper is retired).
- **External APIs**: Companies House Public API + Document API (HTTP Basic Auth, API key as username, blank password); GDELT 2.0 DOC API (adverse media, no key).

## Repo layout

```
server/
  index.js                 Composition root: middleware, route registration, boot reapers, LLM probe; starts pg-boss + run_events bus in queue mode
  worker.js                R2 worker entrypoint — pg-boss subscriber that drives runGraph (queue mode); NotifySink + boot reconciliation
  sse/runtime.js           RunRegistry (+ settable EventSink) + SSE fan-out + write-through persistence + run lifecycle/GC
  graph/
    state.js               Zod state schema (~25 channels, the contract) + concat-reducer arrays
    build.js               Two StateGraphs (full + screening-only) + SqliteSaver checkpointer
    fragments.js           withFragment() wrapper — timing, __fragment/__fragments → decision_fragments, error capture
    nodes/                 gatherInput, searchCh, entityResolution, awaitConfirmation, fetchApis,
                           selectDocuments, downloadDocuments, processDocuments, synthesizeCard,
                           resolveParties, assessRisk, qaCheck, qaNarrative, awaitDecision, autoFinalize,
                           screening/{compileScreeningList, screenSanctions, evaluateSanctionsHits,
                                      screenAdverseMedia, evaluateAdverseMedia, compileScreeningReport}
    extractors/            one per filing category (confirmationStatement, accounts, incorporation):
                           { schema, getPrompt(), ocrPolicy }
  routes/                  runs, dossiers, screening, risk, qa, decision, prompts, documents, health, meta, parties
                           (each exports register(app[, deps]); index.js wires them)
  services/
    ch.js                  Companies House client (cache, SSRF allowlist, secret redaction); downloadDocumentToFile + getDocumentBinary
    llm/                   index.js (cache+retry, prompt load; exports ocrPage/extractStructured/checkProviders),
                           config.js (per-task provider selection), providers/{ollama,nvidia}.js
    party/                 matcher, resolver, canonical (JS twin of SQL name_canonical()), merge, graph, auditLog
    risk/                  index, factors, knockouts, thresholds, normalize, receipt, matrix, rationale, seed
    qa/                    index, projectCase, completenessCheck, consistencyCheck, routingEngine, issueMap, narrative
    sanctions/             matcher, normalize, store, sources/{ofac,uk_hmt}, parsers/{ofac_xml,uk_hmt_csv}
    adverseMedia/          gdelt, cache, index
    screening/             report.js (shared report builder + deterministic overall-risk rule),
                           evaluateSanctionsHit.js / evaluateAdverseMediaHit.js (reusable per-hit
                           LLM judgement cores — shared by the graph nodes AND the R3 eval harness)
    auth/                  passwords.js (bcryptjs), session.js (express-session + connect-pg-simple),
                           index.js (authMiddleware, requireAuth, requireRole, csrfProtection, readUserId)
    queue.js               R2 — pg-boss singleton + single `run` queue + isQueueMode/enqueueRun (queue mode only)
    runDispatch.js         R2 — inline-vs-queue dispatch + executeRunJob (the one kind→runGraph mapping, shared by inline + worker)
    eventSink.js           R2 — InMemorySink (buffer+res) / NotifySink (run_events + NOTIFY); registry delegates pushEvent
    runEventsBus.js        R2 — web-side LISTEN run_events → replay tail + stream live to SSE clients (queue mode)
    decision/index.js      applyDecision (transactional case-status flip + human_action fragment)
    prompts.js             Versioned prompt registry — DEFAULTS, loadPrompt, listAll, createVersion, setActive, seedPrompts
    pdf.js                 extractText, rasterizePages, fileHash
    cache.js               http_cache + kv_cache tables on dev-cache.db
    meta.js
  lib/                     decisionSchema.js, partyMatchSchema.js (CJS server twins of web ESM schemas)
  db/
    client.js              pg Pool + drizzle wrapper (DATABASE_URL required) + pg_trgm GUC
    schema.js              All tables incl. party master + risk matrix + qa + relations
    repo.js                Facade re-exporting db/repo/* — call sites require '../db/repo' unchanged
    repo/                  Aggregate-root query modules: dossiers, runs, fragments, runEvents,
                           screening, risk, qa, parties, users, util (new helpers go here, not in the facade)
    migrate.js             drizzle migration runner (npm run db:migrate)
    migrations/            SQL migrations 0000–0024 (init → … → party master 0012–0019 → users 0020–0021 → run_events 0022 → resume_owed 0023 → run_events type index 0024)
    SETUP.md               One-time native Postgres setup for Windows
  eval/                    R3 eval harness — golden/ corpus, labels.schema.js, score.js (pure), run.js (CLI), README.md
  scripts/                 ~30 *-smoke.js manual tests + smoke-all.js aggregator + refresh-sanctions.js + seed-users.js + var-clean + checkpoint-reap
  lib/dataDirs.js          Runtime data root (var/{cache,checkpoints,evidence}); DATA_DIR override
  .env                     CH_API_KEY, OLLAMA_HOST, PORT, DATABASE_URL, LLM_* provider overrides, GDELT_* overrides
web/
  src/
    main.js                createApp + Pinia + router + tokens.css/components.css
    App.vue                <RouterView />
    router/index.js        Routes — see "Routes" below
    layouts/AppShell.vue   Sidebar + topbar shell + Ollama health banner
    pages/                 SignInPage, DossiersPage, SearchPage, RunPage, DossierViewPage, RunDetailPage,
                           RunDiffPage, GraphPage, WatchlistPage, PartiesPage, PartyDetailPage, AuditLogPage, SettingsPage
    components/            SearchForm, CandidateDisambiguation, KycCard, ShareholderGraph, PartyGraph, PartyIdentityCard,
                           AgentTrail, LiveEvidenceCard, ProcessTab, DataModelTab, ScreeningTab, ScreeningEvidenceCard,
                           ScreeningHitPanel, RiskAssessmentCard, QaNarrative, FinalDecisionPanel,
                           FinalDecisionPanelReadOnly, CountryFlag, NotFound, layout/{SideNav,TopBar,HealthIndicator}
    composables/           useDossier(s), useRun, useRunDetail, useRunPair, useRefresh, usePrompts, useScreening,
                           useRiskMatrix, useRiskAssessment, useDecision, useParties, useParty, usePartyReviewQueue
    stores/               agent (SSE + per-thread reactive slice), dossier, health, decision, auth
    lib/                  decisionSchema.js, partyMatchSchema.js, countries.js
    styles/               tokens.css, components.css
```

## Commands

```bash
# server (port 3000)
cd server && npm run dev          # nodemon

# worker (only when RUN_EXECUTION=queue — drives runs out of the web process)
cd server && npm run worker       # node worker.js  (or worker:dev for nodemon)
npm run queue:smoke               # R2 queue + run_events transport smoke (needs Postgres only)

# web (vite dev server, proxies /api → :3000)
cd web && npm run dev

# database (Postgres — see server/db/SETUP.md for the one-time install)
# Migrations are HAND-WRITTEN SQL — there is no db:generate; never run drizzle-kit.
cd server
npm run db:migrate                # apply migrations
npm run lists:refresh             # load OFAC SDN + UK HMT into Postgres — RUN ONCE after db:migrate
npm run users:seed                # seed analyst/reviewer/admin from SEED_*_PASSWORD env — RUN ONCE after db:migrate
npm run auth:smoke                # boots the app on a test port; exercises login/CSRF/role-guard matrix
npm run db:smoke                  # round-trip a synthetic dossier
npm test                          # smoke-all.js node-only tier (no DB/LLM); smoke:all adds DB tier; smoke:full adds LLM/app tier
npm run test:unit                 # Vitest unit tests over the pure engines (server/test/*.test.mjs); :coverage adds v8 coverage
npm run checkpoints:reap          # delete LangGraph checkpoints for long-terminal runs + VACUUM

# eval harness (R3) — golden-set quality scoring; see server/eval/README.md
npm run eval                      # score extraction/sanctions/adverse-media against the golden corpus (needs DB + LLM)
npm run eval:ab -- screening.evaluate_sanctions_hit=42   # A/B a non-active prompt version vs the active baseline
npm run eval:score-smoke          # pure scorer + corpus-validity smoke (node-only, no DB/LLM)
npm run eval:smoke                # integration smoke (needs DB + LLM; skips cleanly if unreachable)

# Ollama models (one-time)
ollama pull glm-ocr
ollama pull llama3.1:8b
```

## Architecture

A single LangGraph StateGraph with **two** human-in-the-loop interrupts (entity selection, then final decision):

```
START → gather_input → search_ch → entity_resolution
                                     ├─ needs_more_info / not_found → END
                                     └─ → await_confirmation (interrupt #1)
                                              → fetch_apis
                                                  ├─ profile missing → END
                                                  └─ → select_documents → download_documents
                                                         → process_documents → synthesize_card
                                                              → resolve_parties → compile_screening_list
                                                                   ├─→ screen_sanctions     → evaluate_sanctions_hits ─┐
                                                                   └─→ screen_adverse_media → evaluate_adverse_media   ┘
                                                                        → compile_screening_report → assess_risk
                                                                             → qa_check → qa_narrative
                                                                                  ├─ tier Low → auto_finalize → END
                                                                                  └─ Medium/High or QA fail → await_decision (interrupt #2) → END
```

Five logical phases share the graph:

1. **Entity resolution + API fetch** — search Companies House, deterministic-score the candidates, pause for user pick (LangGraph `interrupt()`), then in parallel pull profile / officers / PSC / filing-history (`Promise.allSettled`; partial failure now marks the node failed).
2. **Document pipeline** — pick the latest document per target category, download to `server/var/evidence/<companyNumber>/<transactionId>.pdf`, try text extract first, OCR with the vision model if the extractor's `ocrPolicy` says to, then run a category-specific structured-extraction prompt against the reasoning LLM.
3. **Party resolution + screening** — `resolve_parties` resolves every subject into the party master (and rewrites the graph to `party:<uuid>` IDs); then compile the subject list, run two parallel branches (sanctions against locally cached OFAC SDN + UK HMT; adverse media via GDELT on individuals only), let the reasoning LLM evaluate each potential hit (`confirmed` / `dismissed` / `needs_review`), and assemble a `screeningReport` with a deterministic risk rule.
4. **Risk assessment** — `assess_risk` runs after `compile_screening_report` (in both graphs). Deterministic weighted-factor score (geographic / entity type / structural complexity / industry) enriched by an LLM rationale, with screening-driven knockouts; persisted to `runs.final_risk_assessment`. See "Risk assessment".
5. **QA + decision** — `qa_check` (pure engine) routes the case; `qa_narrative` generates a regulator-style memo (LLM, hard-fail); then either `auto_finalize` (low risk, system approve) or `await_decision` (`interrupt()` #2) pauses for the reviewer. See "QA + final decision".

`synthesize_card` merges the API + document signals into the KYC card (LLM-driven, with a strict "API is authoritative" override re-asserted *after* the LLM as a prompt-injection defence), fills the registered address from the profile if missing, defaults `identity.countryOfIncorporation` to "United Kingdom" (Companies House is the UK registry — a critical KYC field, always populated), surfaces failed docs as red flags, and builds the Cytoscape entity graph (`nodes`/`edges`) from PSC + extracted shareholders (`rel: 'owns'`) **plus active officers/directors** (`rel: 'officer'`; resigned dropped), deduped by normalized name. `resolve_parties` later rewrites this graph to `party:<uuid>` IDs and collapses honorific/partial-name duplicates at the display layer.

State flows through the Zod schema in `server/graph/state.js`. The schema is the contract between every node — get it right and the rest is plumbing. Single-writer channels (`riskAssessment`, `qaResult`, `qaNarrative`, `screeningReport`, `kycCard`) have no reducer; concat-reducer channels (`trace`, `errors`, `fragments`, `screeningHits`, `screeningEvaluations`, `parties`, `partyLinks`) accumulate across nodes and the two parallel screening branches without a join barrier.

### Screening-only graph (rescreen)

A second compiled graph (`compiledScreeningOnlyGraph`) starts at `resolve_parties`, seeded by the rescreen route with `profile / officers / psc / kycCard / documents` from the prior run. It skips CH, document download, OCR, and synthesis but still re-runs the resolver, screening, risk, QA, narrative, and decision routing.

## Decision fragments, SSE, run lifecycle

Every node body is wrapped in `withFragment(nodeId, fn)` (`graph/fragments.js`). The wrapper:

- Captures timing, builds a `decision_fragments` row from a returned `__fragment` (or `__fragments` array) of `{ summary, inputs?, outputs?, status?, error?, kind? }`, merges it into `state.fragments`.
- Re-throws `GraphInterrupt` (LangGraph's pause control flow). Catches anything else and appends to `state.errors` instead of killing the graph. `qa_narrative` is the one intentional exception (hard-fail → run closes `failed`).

`server/sse/runtime.js` owns all in-memory thread state via a `RunRegistry` (no module-level mutable maps). It buffers + fans out SSE events (`progress`, `trace`, `error`, `fragment`, `interrupt`, `cancelled`, `done`, plus screening-specific `screening_subject_started`, `screening_hit`, `screening_hit_evaluated`; buffer capped at 2000/thread), lazily creates dossier+run rows on the first chunk carrying `companyNumber` (buffered fragments flushed in a batch), write-through-persists each streamed delta (fragments, hits, evaluations, QA result, QA narrative) by diffing per-thread cursors, GCs threads 5 min after terminus, hard-reaps runs >2h, reaps stale `running` runs on boot, and at a clean terminus `closeRun` freezes the final snapshots onto the `runs` row.

`fragments.js` classifies nodes as `decision` (entity_resolution, await_confirmation, select_documents, process_documents, synthesize_card, resolve_parties, compile_screening_list, evaluate_sanctions_hits, evaluate_adverse_media, compile_screening_report, assess_risk, qa_check, qa_narrative, await_decision) or `audit` (everything else). The DB enum also accepts `human_action` for reviewer-driven fragments written by `applyDecision` (out of band, not via graph state).

`evaluate_*` nodes emit a parent decision fragment then one **child** fragment per hit, linked via `decision_fragments.parent_fragment_id` (nullable self-FK, `ON DELETE SET NULL`). The trail nests children under their parent.

## Durable run execution (R2)

Flag-gated by `RUN_EXECUTION` (default `inline`). The above describes **inline** mode unchanged. In **queue** mode runs move out of the HTTP request and the in-memory buffer onto a durable Postgres-backed queue + worker. Design rationale in `docs/archive/P0_IMPLEMENTATION_PLAN.md` §R2.

- **Where execution happens.** `routes/runs.js` + `routes/decision.js` call `services/runDispatch.js` instead of `setImmediate(runGraph)`. Inline mode keeps `setImmediate`; queue mode writes a seq-0 "queued" marker to `run_events` and enqueues a **pg-boss** job (`services/queue.js`, one `run` queue, `kind` discriminates start/resume/rescreen/refresh/resumeFailed). `server/worker.js` is the pg-boss subscriber; its job handler calls the **same** `executeRunJob()` mapping the inline path uses, so the two can't drift.
- **Event transport across the process boundary.** The `RunRegistry` now delegates `pushEvent` to a settable **EventSink** (`services/eventSink.js`). Inline → `InMemorySink` (buffer + live `res`, exactly as before). Worker → `NotifySink` (appends each event to the durable `run_events` table in per-thread `seq` order, then `NOTIFY run_events '<threadId>'`). The web process runs `services/runEventsBus.js`: one `LISTEN run_events` connection that, per SSE subscriber, replays the durable tail (`seq > cursor`) and streams new rows on NOTIFY — so a browser reconnect (even after a **web restart**) replays from `run_events`, not memory. `runGraph` drains the sink at every terminus so the terminal event is persisted before the job completes.
- **Concurrency.** One worker, `WORKER_CONCURRENCY` default **1** — Ollama is serial on one GPU. R2 buys *durability + decoupling from the HTTP lifecycle*, **not** a speedup. Parallelism only arrives if LLM calls move to a hosted provider.
- **Checkpointer stays SQLite** (`graph-checkpoints.db`), shared via the filesystem (single host). Horizontal scale-out would need the Postgres checkpoint saver (deferred, §16.4).
- **Boot reconciliation.** On worker boot (`WORKER_RECONCILE`, default `on`), runs still marked `running` are re-driven from their checkpoint — except those paused at a human interrupt (resumed by the user's action, not auto). Web boot also reaps `run_events` older than 24h.
- **Persistence is idempotent.** `appendRunEvent` (unique `(thread_id, seq)`), `appendFragment(sBatch)` + `appendScreeningHit` (`onConflictDoNothing`), and `appendScreeningEvaluation` (`onConflictDoUpdate`) all tolerate a replayed-from-checkpoint resume without duplicating or PK-conflicting.
- **Queue-mode parity surfaces.** `GET /api/runs/active` is rebuilt from the DB (`repo.listActiveRunsFromDb`); the entity-confirmation / decision resume guards read interrupt state from `run_events` (`repo.getThreadStreamState`) since the web process holds no in-memory thread state. **Cancel** in queue mode marks the run cancelled + publishes a `cancelled` event but a worker job already past the point of no return finishes its current node (hard mid-LLM cancel is out of POC scope).
- **Bonus (closes P1 R4b).** The decision apply-then-resume becomes a durable `run.resume` job in queue mode, so a web restart between `applyDecision` and the resume no longer strands the run.

## HTTP API surface

Routes live in `server/routes/*` (each `register(app[, deps])`, wired in `index.js`).

**Runs / stream / lifecycle**
- `POST /api/run` → starts a fresh run, returns `{ threadId }`.
- `GET /api/stream/:threadId` → SSE (event types above).
- `POST /api/resume/:threadId` `{ companyNumber }` → resume after `await_confirmation` (interrupt #1).
- `POST /api/cancel/:threadId` → mark cancelled, close SSE, persist `status='cancelled'`.
- `POST /api/dossiers/:companyNumber/refresh` → new thread with `forceFresh` + auto-resume (re-uses stored companyNumber).
- `POST /api/dossiers/:cn/runs/:runId/resume` → reopen and re-run a `failed` run.
- One running run per dossier: refresh / rescreen / resume return `409 { error:'run_in_progress', threadId }` when a run is live; a start-by-name race is cancelled at first persist (duplicate-run guard in `ensureRunPersisted`).

**Dossiers / runs**
- `GET /api/dossiers`, `GET /api/dossiers/:companyNumber` (historical runs come back **lean** — full `final_*` blobs only on the latest run + latest `done` run; per-run detail via the run endpoint), `GET /api/dossiers/kpis`, `PATCH /api/dossiers/:companyNumber` (`tags`, `notes`).
- `GET /api/dossiers/:cn/runs/:runId` and `…/export.json`.
- `GET /api/documents/:documentId` → inline PDF proxy (CH Document API).
- `GET /api/audit?kind=human_action&limit=200` → flat decision-fragment feed for the Audit Log page.

**Prompts** — `GET /api/prompts`, `GET /api/prompts/:key`, `GET /api/prompts/:key/versions/:id`, `POST /api/prompts/:key/versions`, `POST /api/prompts/:key/active`.

**Health** — `GET /api/health` → cached LLM-provider probe refreshed every 15s; UI surfaces it as a banner.

**Screening**
- `POST /api/dossiers/:cn/rescreen` → screening-only thread (seeds `screeningOnlyGraph`).
- `GET /api/dossiers/:cn/runs/:runId/screening` → full hits + evaluations.
- `PATCH /api/dossiers/:cn/runs/:runId/hits/:hitId` → set/clear `human_override` (`confirmed` | `dismissed` | `null`) + optional `override_reason`; re-derives the report `summary`.
- `POST /api/dossiers/:cn/runs/:runId/carry-overrides-forward` → copies overrides into `dossier_screening_overrides`.
- `GET /api/screening/lists` → `[{ source, version, fetched_at, record_count }]`.

**Risk**
- `GET /api/risk/matrix`, `GET /api/risk/matrix/versions`, `GET /api/risk/matrix/versions/:id`, `POST /api/risk/matrix/versions` `{ body, notes }` (validated server-side; bad body → 400 `{ error, validationErrors }`; does not activate), `POST /api/risk/matrix/active` `{ versionId }`.
- `GET /api/dossiers/:cn/runs/:runId/risk` → `{ runId, riskAssessment }` (404 if not assessed).
- `POST /api/dossiers/:cn/recalculate-risk` → matrix-edit-only rebase of the latest snapshot-bearing run; no new run/thread. Returns `{ ok, runId, rationaleSource, riskAssessment }`.

**QA + decision**
- `GET /api/dossiers/:cn/runs/:runId/qa` → frozen `qaResult` (404 if not QA-checked).
- `POST /api/dossiers/:cn/runs/:runId/qa/recompute` → engine-rebase against stored snapshots + active matrix; writes `runs.qa_result` in place; re-derives `case_status` only when latest snapshot-bearing run AND dossier non-terminal.
- `POST /api/dossiers/:cn/runs/:runId/decision` (discriminated union on `action`: `approve` / `reject` / `escalate` / `request_info`; userId from the authenticated session via `readUserId`; guarded by `requireRole('reviewer')`) → `applyDecision` (txn case-status flip + immutable `human_action` fragment), **then resumes the graph** out of `await_decision` with `Command({resume:{decisionApplied:true,…}})`. `200 { ok, caseStatus, fragmentId, previousCaseStatus }`; `409 { error:'invalid_transition', from, action }`; `400 { error:'invalid_payload', validationErrors }`.

**Parties** (`routes/parties.js`)
- `POST /api/parties/match` → name matcher; always writes a `party_match_log` row (even on zero matches).
- `GET /api/parties` (filters `q`, `needs_review`, `dossier_id`, paginated), `GET /api/parties/:id`, `GET /api/parties/:id/screening` (cross-dossier summary), `GET /api/parties/:id/graph?depth=&limit=` (Cytoscape).
- `GET /api/parties/watchlist`, `POST`/`DELETE /api/parties/:id/watchlist`.
- `PATCH /api/parties/:id/overrides` → party-level (cross-dossier) screening override.
- `POST /api/parties/:id/merge` (`:id` = winner) — soft-merge, idempotent.
- `GET /api/parties/review-queue`, `POST /api/parties/review-queue/:itemId/resolve` (`merge` | `reject`).

## Routes (web)

- `/signin` — fake sign-in shell.
- `/` → redirects to `/dossiers`.
- `/dossiers` — list + KPIs.
- `/search` — `SearchForm`, kicks off a run.
- `/run/:threadId` — live agent trail + disambiguation.
- `/dossier/:companyNumber` (+ `/dossier/current`) — KYC card + ownership graph + run history + risk/QA/decision panels.
- `/dossier/:cn/run/:runId` — frozen run detail.
- `/dossier/:cn/run/:runId/diff/:otherRunId` — diff two runs.
- `/dossier/:cn/graph` (+ `/graph/current`) — full-screen Cytoscape view.
- `/parties` — party master list; `/party/:partyId` — party detail (identity, links, cross-dossier screening + graph).
- `/watchlist` — watched parties (real `GET /api/parties/watchlist` data) + party review queue tabs.
- `/audit`, `/settings` (Settings hosts screening config, the prompt editor, and the risk-matrix editor; deep-link the risk matrix via `/settings#risk-matrix`).

## Party Master

The most architecturally significant subsystem (migrations 0012–0019, `services/party/*`, `routes/parties.js`). It does **cross-run, cross-dossier party identity** ("is this the same John Smith we saw on three other dossiers?"), distinct from per-run entity *confirmation*. Read `docs/architecture/ARCHITECTURE.md` §8 before changing it.

- **8 tables**: `parties`, `party_links`, `party_link_status_history`, `party_review_queue`, `party_match_log`, `party_screening_overrides`, `party_watchlist` (+ merge-audit columns on `parties`).
- **Matcher** (`matcher.js`) — 4-layer waterfall with one SQL round trip: canonicalise via SQL `name_canonical()` → token-overlap GIN prefilter + `pg_trgm` similarity → band classify (`=1.0` EXACT / `≥0.8` HIGH / `≥0.6` REVIEW / `0.4–0.6` Double-Metaphone + Levenshtein gate). `parties.name_canonical` is a Postgres `GENERATED … STORED` column with a **JS twin** in `canonical.js` — the two must stay in lock-step (documented fragility).
- **Resolver** (`resolver.js`, called by `resolve_parties` for each subject, officers→PSCs→shareholders): strong-key first (CH appointment id for individuals; `(country, registration_number)` for corporates) → else name matcher. **EXACT auto-link is corroboration-gated for individuals (R5)**: DOB/nationality must be present and consistent (`services/party/corroborate.js`); a mismatch or a bare-name EXACT demotes to a new party + review queue (`exactDemotedToReview` counter). Corporates keep EXACT auto-link. Toggle with `PARTY_REQUIRE_CORROBORATION` (default on); historical dossiers may split parties on next run. HIGH/REVIEW create a new party + enqueue `party_review_queue`. Link upsert is idempotent on `(party_id, dossier_id, role, appointed_on, notified_on)`; status history appended on transitions; a match-log row written for *every* call; links the current run didn't touch flip to `historical`; corporate parties with a matching UK reg number get `parties.dossier_id` set (cross-dossier traversal). **Idempotency is the invariant.**
- **Merge / review queue / watchlist / cross-dossier graph** — soft-merge (loser gets `merged_into_party_id`), reviewer-resolved dedup, reviewer-flagged watchlist (membership only, no alerting in the POC), Cytoscape traversal centred on a party.

## LLM provider

A pluggable abstraction (`services/llm/*`) imported via a stable surface (`ocrPage`, `extractStructured`, `checkProviders`):

- **Per-task provider selection**, env-driven: `LLM_OCR_PROVIDER` / `LLM_REASONING_PROVIDER` → `LLM_PROVIDER` → default `ollama`. An unset `.env` behaves exactly as Ollama-for-both. NVIDIA NIM (`providers/nvidia.js`, via `@langchain/openai`) is the optional alternative.
- **OCR cache key includes provider+model** (`hash:provider:model`) so switching backends doesn't serve stale cross-model OCR. Cached in `kv_cache` on `dev-cache.db`.
- **One retry** on structured-extraction failure, prepending the `extract.json_strict_retry` prompt. No deeper retry/backoff.
- `extractStructured(input, zodSchema, prompt)` → `ChatOllama({ format:'json' }).withStructuredOutput(schema)` (Ollama) or the NIM equivalent.
- **Ollama gotcha** — `glm-ocr` needs `num_ctx: 16384` in `options` or it crashes on full-page images. **Already set; don't remove it.** ~40–50 s/page on M1/M2.
- A long-timeout undici `Agent` survives multi-minute generations.

## Prompt registry

LLM prompts are versioned in Postgres so we can iterate without a redeploy. Keys (defaults seeded on startup):

- `kyc.synthesis` — final card merge.
- `extract.confirmation_statement` — shareholders.
- `extract.accounts` — headline financials.
- `extract.incorporation` — initial subscribers.
- `ocr.page` — per-page instruction for the vision model.
- `extract.json_strict_retry` — prefix prepended on a JSON-parse retry.
- `screening.evaluate_sanctions_hit` — per-hit true/false-positive judgement; biases toward `needs_review` when identifiers are absent.
- `screening.evaluate_adverse_media` — per-article relevance + category + severity; biases toward `dismissed` for clearly-different-context articles; knows snippets are empty (untrusted-input framing).
- `risk.rationale` — regulator-defensible rationale from the risk receipt JSON; output `{ headline, drivers[≤3], sanctionsNote }`.
- `risk.normalize_country` — free-text country → ISO-3166-1 alpha-2 (or `null`); only on a static-lookup miss, cached in `kv_cache`.
- `qa.narrative` — regulator-style case memo; paragraph count scales to tier (Low 2 / Medium 4 / High 6); must agree with the routing decision.

`services/prompts.js` is the single read path: `loadPrompt(key)` reads the active version and caches in-process. `setActive` invalidates. `loadPromptVersion(key, versionId)` loads a *specific* (possibly non-active) version's body — the A/B entry point the R3 eval harness uses to score a candidate against the active baseline before `setActive`. The Settings page edits these via `/api/prompts`. Don't hard-code prompts elsewhere — register a key and call `loadPrompt`.

## Screening notes

Detailed design lives in `docs/architecture/SCREENING_PLAN.md` — read it before changing screening shape.

- **Subjects** = company (from `profile`) ∪ officers (from `officers.items`) ∪ PSCs (from `psc.items`) ∪ extracted shareholders. Party-keyed when the resolver ran (`subjectId = party:<uuid>`), legacy `${source}:${normalizedName}` otherwise. Authorized signatories and recursive ownership-chain walking are out of scope.
- **Sanctions sources** loaded into Postgres (`sanctions_lists`, `sanctions_entries`) by `npm run lists:refresh` (`server/scripts/refresh-sanctions.js`). v1 ships **OFAC SDN enhanced XML** + **UK HMT consolidated CSV**. Adding a source = a file under `services/sanctions/sources/` + a parser. **Run `lists:refresh` once after `db:migrate`** — without it, sanctions screening returns zero hits.
- **Matching**: `services/sanctions/matcher.js` uses token-set ratio (`fastest-levenshtein`) + Double Metaphone fallback against name + every alias. Single global threshold from `screening_config.match_threshold` (default 0.85). PEP screening is deferred.
- **Adverse media**: live news via the **GDELT 2.0 DOC API** (`mode=ArtList&format=json`) — free, **no API key**; optional `GDELT_DOC_ENDPOINT` / `GDELT_TIMESPAN` (default `12m`) overrides. Client in `services/adverseMedia/gdelt.js`. **Headlines only — no snippet.** Cached in `kv_cache` with **two layers (G1)**: party-keyed `partyId + ISO-week` (cross-dossier — a shared individual costs one GDELT fetch per week) then name-keyed `name + ISO-week` (legacy subjects + cross-party same-name reuse); a real fetch writes both, lookup order party → name → GDELT (7-day implicit TTL). Strictly serial semaphore (1 concurrent, **6s** min spacing) + 429/network retries; persistent 429 → soft-skip (`GDELT_RATE_LIMITED`). Screened on **individuals only** in v1. This is the dominant wall-clock cost on large boards.
- **Persistence**: hits in `screening_hits` (one row per `subject × list × match`, carries optional `party_id`); evaluations in `screening_evaluations` (LLM decision + reasoning + optional override). Frozen report on `runs.final_screening_report`.
- **Overrides**: per-run via the hits PATCH; per-dossier carry-forward via `…/carry-overrides-forward`; per-party (cross-dossier) via `PATCH /api/parties/:id/overrides`. Precedence: party-level wins over dossier-level. For sanctions the LLM still runs (audit trail) but the override decides; for adverse media the override short-circuits the LLM.
- **Refresh vs rescreen**: `refresh` re-runs the whole graph (fresh CH + OCR + screening); `rescreen` is screening-only (`screeningOnlyGraph` seeded from the latest run, starts at `resolve_parties`).
- **Risk rule** (`services/screening/report.js`, deterministic — no LLM): any confirmed sanctions hit → `high`; serious confirmed adverse media (financial_crime / corruption / fraud / money laundering, severity ≥ medium) OR sanctions `needs_review` → `medium`; otherwise → `low`. This single value feeds the risk knockouts.
- **Latest-only** — no historical re-screen-as-of-date; every run uses the current `sanctions_entries`.

## Risk assessment

Detailed design lives in `docs/architecture/IMPLEMENTATION.md` "Phase 3" — read it before changing risk shape.

- **Where it runs**: `assess_risk` node, after `compile_screening_report`, in both graphs. Plus `POST /api/dossiers/:cn/recalculate-risk` for matrix-edit-only rebases (no run / no thread).
- **Engine** (`services/risk/`, pure, no I/O): `normalize.js` (country → ISO-2, entity-type aliases, SIC coercion), `factors.js` (the four `compute*`), `knockouts.js`, `thresholds.js`, `receipt.js`, `matrix.js`, `rationale.js`, `index.js` (`assessRisk` barrel). `assessRisk` is async only because `normalizeCountry` may hit the LLM; deterministic given the resolved country.
- **v1 factors** (lean): geographic (registered country), entity type (CH `company_type`), structural complexity (corporate-PSC count + heuristic ownership layers, combined `max`), industry (longest-prefix SIC match, combined `max`). `contribution = round2(weight × baseScore)`; `score = round2(Σ contributions)`. UBO nationality / channel / financials / PEP knockout are deferred.
- **Matrix config**: Postgres `risk_matrix_versions` / `risk_matrix_active` (versioned, append-only, singleton-active — mirrors the prompt registry). `matrix.js` is the single read path: `loadActiveMatrix()` (in-process cache; falls back to bundled `defaults/matrix.json` *uncached* when unseeded → `versionId:null`), `validateMatrix(body)` → error-string array (server-side authoritative), `setActiveMatrix` invalidates. `seedRiskMatrix()` seeds v1 on boot if unseeded.
- **Knockouts** (`knockouts.js`, enumerated tags → predicates, no expression engine): read `screeningReport.summary.overallRisk` only. `screeningMediumFloor` → floor tier `Medium`; `screeningHighOverride` → force `High`; `screeningProhibited` → force `High` + `outcome='Prohibited'`. Knockouts modify tier/outcome, never the score.
- **LLM role**: `risk.rationale` (always — `rationale.js#generateRationale` throws on failure; the node falls back to `templateRationale` and tags the fragment `rationaleSource:'template'`) + `risk.normalize_country` (only on a static-lookup miss; positives cached in `kv_cache` namespace `risk_country`).
- **Persistence + shape**: `runs.final_risk_assessment` jsonb (nullable). `{ score, tier, outcome, factors[], knockoutsTriggered[], deltaFromPrevious?, deltaFlagged, matrixVersionId?, matrixVersion?, calculatedAt, rationale?, receipt }`. The `receipt` is the audit trail (raw inputs + per-factor weight/baseScore/contribution/attribute/evidence + knockouts + trajectory + warnings).
- **Trajectory**: Δ vs. the previous run's `score`; flagged when `|Δ| ≥ matrix.trajectory.deltaFlagThreshold` (default 15). `repo.getPreviousRiskAssessment(cn, excludeRunId)`.
- **Refresh vs rescreen vs recalculate**: `refresh` re-runs the whole graph; `rescreen` is screening-only + risk; `recalculate-risk` is risk-only against the *currently active* matrix, written in place (latest-only).
- **UI**: `RiskAssessmentCard.vue` on `DossierViewPage` (latest, with a "Recalculate" button) and `RunDetailPage` (frozen). Composables: `useRiskMatrix`, `useRiskAssessment`.

## QA + final decision

Detailed design lives in `docs/architecture/IMPLEMENTATION.md` "Phase 5" — read it before changing QA or decision shape.

- **Where it runs**: `qa_check` then `qa_narrative` after `assess_risk`, in both graphs; the case then `auto_finalize`s (low risk) or pauses at `await_decision` (interrupt #2). Plus `POST …/qa/recompute` for engine-rebases (no run / no thread; refuses on terminal `case_status`).
- **QA engine** (`services/qa/`, pure, no I/O, no LLM): `projectCase.js` (state → spec-shaped projection: registry_record / ubo_list / screening_results / risk_score / risk_narrative / document_status), `completenessCheck.js` (missing-field gate; document failures are warnings), `consistencyCheck.js` (ubo_not_screened / tier_too_low_for_sanction_hit / tier_too_low_for_knockout / status_contradiction_registry / status_contradiction_document), `routingEngine.js` — **tier-based**: `!passed → standard_review`; `passed && Low → auto_approved`; `passed && Medium → streamlined_review`; `passed && High → standard_review`. Routing reads the **post-knockout** tier (a confirmed sanctions hit forces High via `screeningHighOverride`). `issueMap.js` maps codes → severity + UI anchor + message; `index.js` is the `evaluateQa` barrel. No matrix thresholds are read by QA.
- **Narrative** (`qa_narrative`, LLM via `qa.narrative`): **hard-fail, no template fallback** — a narrative failure closes the run `failed`.
- **Persistence + shape**: `runs.qa_result` jsonb (nullable) `{ passed, completeness, consistency, routing:{ caseStatus, qaSummary }, highlightedIssues[], qaSummary, tier, evaluatedAt }`; `runs.qa_narrative` (the memo). The QA-routed `caseStatus` mirrors to `dossiers.case_status` + `case_status_updated_at` + `case_status_run_id` (FK, `ON DELETE SET NULL`).
- **Case lifecycle** (`case_status` enum): `pending` → QA-routed `auto_approved` | `streamlined_review` | `standard_review` → reviewer-driven `approved` | `rejected` | `escalated` | `info_requested`. Re-runs only overwrite `case_status` when the dossier is still non-terminal — finalised cases (`approved`/`rejected`) are never un-finalised by a new run.
- **Final decision** (`services/decision/index.js#applyDecision`): single transactional flow. Asserts the allowed-from set (`approve` requires `auto_approved` / `streamlined_review` / `standard_review`; others accept any non-terminal state), flips `case_status`, writes an immutable `decision_fragments` row with `kind='human_action'`, `nodeId='human_decision'`, `sequence=max+1`. Returns `{ ok, caseStatus, fragmentId, previousCaseStatus }`. Throws `code='invalid_transition'` (→409) / `code='not_found'` (→404). **Apply-then-resume**: the `/decision` route applies the decision *then* resumes the graph out of `await_decision`; the node deliberately writes no fragment on resume (the `human_action` row is canonical). `auto_finalize` approves as the `system` user. The `/api/fragments/:id` middleware refuses any non-GET against a `human_action` row.
- **Payload schema** (`lib/decisionSchema.js` + `web/src/lib/decisionSchema.js` — physical twins; CJS for server, ESM for web): discriminated union on `action`. `approve`={ userId }; `reject`={ userId, reasonCode, freeText≥10 } (reasonCode from `REASON_CODES`); `escalate`={ userId, notes≥10, suggestedAction? }; `request_info`={ userId, items[≥1] } each { description≥3, category≥1 }. Same Zod schema client- and server-side; `userId` comes from the authenticated session (`readUserId(req)` → `req.auth.userId`; the body's `userId` always loses).
- **UI**: `FinalDecisionPanel.vue` (active runs) on `DossierViewPage`; `FinalDecisionPanelReadOnly.vue` (frozen) on `RunDetailPage`; `QaNarrative.vue` for the memo. Draft state in Pinia `decision` store (per-runId), cleared after submit. Composable: `useDecision`. `AuditLogPage` renders the `human_action` feed from `GET /api/audit`.

## Authentication (R1)

App-owned user store + server-side sessions + role-based access. Supersedes the
old spoofable `x-user-id` model. Design rationale in `docs/archive/P0_IMPLEMENTATION_PLAN.md` §R1.

- **Users**: `users` table (migration 0020) — `username`, `password_hash` (bcryptjs, cost 12), `role`, `active`. Seeded by `npm run users:seed` from `SEED_{ANALYST,REVIEWER,ADMIN}_PASSWORD` env (never hard-coded). **Run once after `db:migrate`.**
- **Sessions**: `express-session` + `connect-pg-simple` on the existing pg pool (`session` table auto-created). httpOnly cookie `ccpoc.sid`, `SameSite=Lax`, `Secure` via `COOKIE_SECURE`, rolling TTL. Durable + revocable + shared across processes (ready for the R2 worker). **The cookie is auto-sent by `EventSource`, so SSE needs no special auth handling.**
- **Roles** (hierarchy `admin > reviewer > analyst`): `analyst` = run + read + recommend (incl. qa/recompute + recalculate-risk — deterministic, auditable rebases); `reviewer` = + final decisions, screening hit overrides + carry-forward, party overrides / merge / review-queue resolution / watchlist edits; `admin` = + edit prompts / risk matrix / screening config. `requireRole(min)` is hierarchy-aware (admin satisfies all). Guards are registered inside each route module next to the handler they protect — not centrally in `index.js`.
- **CSRF**: cookie auth → double-submit token on mutating methods. Client `GET /api/auth/csrf`, echoes it in `x-csrf-token`. Server `csrfProtection` middleware enforces; the web `lib/api.js` fetch wrapper attaches it automatically (+ refresh-and-retry on 403).
- **Server**: `services/auth/{index,session,passwords}.js`, `routes/auth.js` (`POST /api/auth/login` rate-limited, `/logout`, `GET /api/auth/me`, `GET /api/auth/csrf`, **`PATCH /api/auth/profile`** displayName/username/email, **`POST /api/auth/password`** with current-password check). `index.js` mounts session → `authMiddleware` (→ `req.auth = {userId, username, displayName, email, role}`) → `csrfProtection` → auth gate (all `/api/*` except `/api/auth/{login,logout,csrf,me}` + `/api/health`) → role guards → routes. `readUserId(req)` (the single identity chokepoint) now returns `req.auth.userId`. **Self-service profile/password edits use the session user id, never the body — role/active are never self-editable.** `users.email` added in migration 0021.
- **Web**: `stores/auth.js` (login/logout/me + `hasRole` + `updateProfile`/`changePassword`), `lib/api.js` (window.fetch wrapper: credentials + CSRF + 401→signin), real `SignInPage.vue`, router `beforeEach` guard, user chip (links to `/settings#account`) + sign-out in `TopBar.vue`. **"My account" tab in `SettingsPage.vue`** (edit display name / username / email + change password); the top-right chip deep-links there.
- **Dev bypass**: `AUTH_DEV_BYPASS=true` trusts `x-user-id` as an admin actor (skips CSRF) — local engine/smoke use only, **off by default**.
- **Smoke**: `npm run auth:smoke` boots the app and asserts login/CSRF/role-guard/logout (14 checks).

## Companies House notes

Two separate APIs, same API key:
- `https://api.company-information.service.gov.uk` — search, profile, officers, PSC, filing-history.
- `https://document-api.company-information.service.gov.uk` — filing PDFs.

HTTP Basic Auth: API key as username, password blank. Filings → `Accept: application/pdf`. iXBRL/XHTML are out of scope. The client (`services/ch.js`) has an SSRF allowlist on redirect-follow, input-validation regexes + `var/evidence/` path-containment, secret redaction in errors, and SQLite `http_cache` caching. Rate limit is 600 req / 5 min — a non-issue locally because of the cache; `forceFresh` bypasses it (the `refresh` flow does).

## Document selection rule

Per company, only fetch the latest filing in each of: `confirmation-statement`, `accounts`, `incorporation`. Hard cap: 3 documents. OCR is hard-capped at 5 pages (`OCR_PAGE_CAP` in `processDocuments.js`), raster scale `1.5`. **Truncation is surfaced, not silent (X1)**: docs carry `truncated`/`pagesProcessed`/`pagesTotal`/`pagesSelected`, `synthesize_card` raises a dedicated red flag, and the UI shows the counts. *Which* 5 pages get OCR'd follows text-layer keyword relevance per category (`OCR_PAGE_SELECTION=relevance|first`, default `relevance`; falls back to first-N when the text layer is empty/scoreless — see `pageTextHints` in `services/pdf.js`).

Per-extractor `ocrPolicy`:
- `confirmation-statement` → `always` (table-heavy)
- `accounts` → `ifLowText` (charsPerPage < 200)
- `incorporation` → `ifLowText`

## Entity resolution

Per-run *confirmation* (which CH company is this?) — deterministic scoring layered on top of CH search, in `nodes/entityResolution.js`. (Distinct from cross-dossier party *identity*; see "Party Master".)

- Base = `max(0, 1 - apiRank/20)`
- +1.00 if user-supplied company number matches (hard match)
- +0.30 if user-supplied postcode matches `registered_office_address.postal_code`
- +0.20 if incorporation year matches
- +0.15 if a shared type keyword (`ltd`, `limited`, `plc`, `llp`, `cic`) appears in both the input name and the candidate title

Decision logic:
- Top score ≥ 0.85 **and** ≥ 0.20 ahead of #2 → `auto_match` (still goes through `await_confirmation` for explicit user OK).
- Otherwise → `needs_user_pick`, top 5 returned to the UI.
- Zero candidates → `needs_more_info`.

The reasoning LLM is *not* used as a tie-breaker — the deterministic path is the whole story.

## Conventions

- Node functions: `async (state, config) => Partial<State>`. Return only the keys the node updates. Wrap with `withFragment(nodeId, fn)`.
- Decision/audit trail: append to `state.fragments` via the `__fragment` shape in your return value — don't push directly.
- **Never throw out of a node** — `withFragment` catches and converts to `state.errors` + a `failed` fragment, but `GraphInterrupt` must propagate. (`qa_narrative` is the one intentional hard-fail.)
- Trace events: `traceEvent(node, msg, extra?)` → `state.trace`. The SSE stream is built from this + fragments + errors.
- All LLM extraction goes through `extractStructured(input, zodSchema, prompt)`. New prompts go in `services/prompts.js` `DEFAULTS` (seeded automatically).
- `forceFresh` is plumbed through `config.configurable.forceFresh` → CH cache + download + OCR cache.
- Several nodes (`resolve_parties`, `auto_finalize`) re-derive `dossierId`/`runId` from the DB by `thread_id` because LangGraph snapshots `configurable` at stream start — known smell, see `docs/architecture/ARCHITECTURE.md` §16.4.
- The SQL `name_canonical()` and its JS twin (`services/party/canonical.js`), and the decision Zod schema twins (CJS + ESM), must stay in lock-step.
- No secrets in source. `.env` only.
- UI: sentence case for strings, no emoji, design tokens in `web/src/styles/tokens.css`.

## What NOT to do (POC scope guards)

- **Auth is now real (R1)** — app-owned users + server-side sessions + roles. See "Authentication" below. Still single-tenant (no multi-tenancy); the legacy `x-user-id` path survives only behind `AUTH_DEV_BYPASS` (off by default).
- No production observability (LangSmith optional, not wired) — `console.*` only.
- No vector store / RAG (also no vector-similarity name matching).
- No iXBRL parsing — PDFs only.
- No retry-with-backoff infra beyond the one JSON-retry on extraction + GDELT retries.
- No token-level streaming to the UI — node-level SSE events are sufficient.
- Testing has three tiers, each with a job: **Vitest unit tests** (`server/test/*.test.mjs`, pure engines only — qa, risk, sanctions matching, screening report, canonical, decision schema; v0.1 target 80% coverage on these), the `server/scripts/*-smoke.js` scripts (integration; tiered by smoke-all.js), and the **R3 eval harness** (`server/eval/`) — a deliberately small, frozen golden-set quality scorer. Don't unit-test graph nodes / routes / DB modules (that's the smoke tier's job); keep the golden corpus small (~3–10 cases per type).
- **Screening v1 explicitly excludes**: PEP screening, recursive ownership-chain walking, authorized signatories, historical sanctions list versioning / re-screen-as-of-date, LLM alias generation, multilingual name matching beyond Latin transliteration, screening in the run-diff view. See `docs/architecture/SCREENING_PLAN.md` §11.

## Hard environment constraints

- **No Docker, ever.** Docker is not permitted on this machine. Do not propose `docker`, `docker-compose`, or any container-based workflow at any time. Postgres is installed natively (Windows installer / `winget install PostgreSQL.PostgreSQL.17`). See `server/db/SETUP.md`.
- Platform is Windows (bash via Git Bash / Cygwin) — use forward slashes in paths, `/dev/null` not `NUL`.

## External docs

- Companies House API: https://developer-specs.company-information.service.gov.uk/
- LangGraph.js: https://docs.langchain.com/oss/javascript/langgraph/overview
- GLM-OCR: https://huggingface.co/zai-org/GLM-OCR
- Cytoscape.js: https://js.cytoscape.org/
- Drizzle ORM: https://orm.drizzle.team/docs/overview
- GDELT 2.0 DOC API: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
