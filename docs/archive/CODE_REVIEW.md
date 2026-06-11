# CompanyCardPOC — Code review

**Date**: 2026-06-10
**Scope**: full repo — `server/` (Express 5 + LangGraph + Drizzle/Postgres + SQLite + pg-boss worker), `web/` (Vue 3), `server/db/migrations/` (0000–0023), scripts, config, deps.
**Lenses**: security, performance, maintainability (+ reliability/correctness where it intersects).
**Previous review**: 2026-05-15, archived at `CODE_REVIEW_2026-05-15.md`. This review verifies every P0/P1 from that pass against the current code (§1), then reports what's new.
**What changed since May**: routes split out of `index.js` (R0), real auth with sessions + roles (R1), durable queue-mode run execution + `run_events` SSE transport (R2), eval harness (R3), resume reconciler (R4b), party corroboration gating (R5), structured logging (R7). Migrations grew 0010→0023.

---

## 0. Executive summary

**The May review was acted on thoroughly.** Of the 14 P0s, 12 are verifiably fixed, 1 is partially fixed, and 1 (key rotation) was never done. Most P1s are fixed too, including the big architectural ones (index.js split, `RunRegistry`, batched fragment persistence, lean dossier-list projection, prompt-injection identity override). The codebase is in markedly better shape than it was.

The new review's headline items, in priority order:

1. **The live Companies House and NVIDIA API keys flagged on 2026-05-15 were never rotated** — `server/.env` still holds the same `_qKf…` CH key. The supporting work (root `.gitignore`, `server/.env.example`) landed; the rotation itself didn't. Four weeks of additional exposure. (§3.1)
2. **Role-based authorization has gaps.** Only five endpoints carry `requireRole` guards (decision, prompts ×2, risk matrix ×2). An **analyst** can: change the sanctions `match_threshold` (`PATCH /api/screening/config`), override screening hit decisions, carry overrides forward, set cross-dossier party overrides, merge parties, resolve the dedup review queue, and edit the watchlist. Per the stated role model ("analyst = run + read, recommend only"), these are reviewer or admin actions. (§3.2)
3. **The one-running-run-per-dossier guard creates ghost runs instead of 409s.** The partial unique index from migration 0010 exists, but `ensureRunPersisted` swallows the conflict and returns `null` — a second concurrent run for the same dossier executes the full graph (LLM cost and all) with **no persistence whatsoever**: no run row, no fragments, no audit trail. (§4.1)
4. **`graph-checkpoints.db` is 48 MB and grows without bound.** Every thread's checkpoints live forever; nothing reaps them. Two months in, it's already the largest file in the repo. (§5.1)
5. **`getDossier` ships every run's full `final_*` jsonb blobs** to the dossier page — the same N×MB problem `listDossiers` was already fixed for. (§5.2)

Nothing here blocks demoing. Items 1–2 should be fixed before the app is exposed beyond localhost; item 3 before any multi-user demo. The action plan in §8 sequences all of it.

---

## 1. Status of the 2026-05-15 findings

### P0s (old §3)

| # | Finding | Status | Evidence |
|---|---|---|---|
| 3.1 | Live secrets in `server/.env` | **⚠ Partial** | Root `.gitignore` (`**/.env`) and `server/.env.example` exist. **Keys NOT rotated** — CH key still starts `_qKf`, NVIDIA key still present. Folder is still not a git repo. |
| 3.2 | Path traversal in `downloadDocumentToFile` / rasterizer | **✔ Fixed** | `services/ch.js:35-37` regexes + double containment check at `ch.js:174-183`; `pdf.js:7-13` documents the trust contract. |
| 3.3 | `parent_fragment_id` CASCADE → SET NULL | **✔ Fixed** | Migration `0010_p0_hardening.sql` §3.3 block; `schema.js:103-106` declares it. |
| 3.4 | Drizzle schema vs migrations drift | **✔ Fixed** | `case_status_run_id` and `parent_fragment_id` `.references()` declared in `schema.js:50,103`. |
| 3.5 | Missing Drizzle snapshots | **✔ Resolved by policy** | `db:generate` removed from `server/package.json`. Residue: CLAUDE.md still documents `npm run db:generate`, `drizzle-kit` is still a devDep, and `meta/_journal.json` lists 24 entries vs 2 snapshots — see §6.1. |
| 3.6 | Overrides unique NULLs-distinct bug | **✔ Fixed** | 0010 §3.6: dedupe + `UNIQUE NULLS NOT DISTINCT`. |
| 3.7 | SSRF / credential-forward on CH redirects | **✔ Fixed** | `ch.js:19-30` host allowlist + `beforeRedirect` check on every axios call; `redactSecrets` on all thrown errors. |
| 3.8 | Unbounded SSE map / no backpressure | **✔ Fixed** | `sse/runtime.js`: `RunRegistry`, 2000-event cap (`eventSink.js:24`), GC timers, hard reap, try/catch on `res.write`. |
| 3.9 | Fragments middleware fail-open | **✔ Fixed** | `routes/decision.js:21-37` fails closed with 503. |
| 3.10 | QA result + case-status not transactional | **✔ Fixed** | `repo.finalizeRunQa` (`repo.js:904-967`) — single txn, terminal-state guard inside. |
| 3.11 | `match_threshold` not clamped | **✔ Fixed** | Route (`screening.js:124-133`) and repo (`repo.js:540-553`) both clamp to [0.5, 0.99]. |
| 3.12 | Concurrent-run race | **⚠ Partial** | Index `runs_one_running_per_dossier` exists (0010), but no route/runtime handles the conflict — see new finding §4.1. |
| 3.13 | `human_action` immutability HTTP-only | **✔ Fixed** | 0010: `BEFORE UPDATE` trigger (DELETE deliberately left open for cascade — documented in-migration). |
| 3.14 | Fragment sequence race | **✔ Mostly fixed** | `UNIQUE (run_id, sequence)` added in 0010. `applyDecision` still has the stale "if a unique constraint is added later" comment and no 23505 retry — see §4.2. |

### P1s (old §4) — abridged

**Fixed**: index.js monolith split (`routes/*`, `sse/runtime.js`, `RunRegistry`); `emitDelta` extracted + fragment batching (`appendFragmentsBatch`); provider prompt-loading moved to `llm/index.js` boundary; global error handler hiding `err.message`; CORS pinned + `127.0.0.1` bind; session auth replacing `x-user-id`; `pdfjs-dist` pinned via `overrides`; deterministic identity override after the LLM in `synthesizeCard`; adverse-media prompt untrusted-input framing; `sicMatch`→`typeMatch`; `initialSubscribers` summary; `rel` on `GraphEdgeSchema`; `reopenRun` clears `final_*`/QA columns; resume-without-interrupt 409 guard; boot stale-run reaper; `processDocuments` parallelized; `listDossiers` lean `DISTINCT ON` projection with jsonb projections; all seven missing indexes (0010); sanctions matcher memoized metaphone + prefilter limit raised to 5000; SSE `onerror` readyState handling; `AgentTrail` includes `assess_risk`/`qa_check`; `engines.node` on server; hardcoded email removed; mock dossiers removed from SearchPage; `tmp` reaper + `tmp:clean`.

**Still open** (carried into this review): `WatchlistPage` is still 100% mock (§6.2); `pdf-to-png-converter` still a dependency but unused (§6.3); `uuid` dep still used where `crypto.randomUUID()` would do (§6.6); `test` script still the error stub and no `smoke:all` aggregator across ~30 smoke scripts (§6.4); `extractStructured` retry still catches every error class and has no timeout/abort (§4.5); `repo.js` single-file split never happened and it has tripled in size (§6.5).

---

## 2. Priority matrix

| Severity | Count | Meaning |
|---|---|---|
| **P0 — fix now** | 2 | Real exposure with a live trigger path (§3.1, §3.2). |
| **P1 — fix soon** | 5 | Correctness/ops issues that will bite a demo or a second user (§4.1, §4.3, §5.1, §5.2, §6.2). |
| **P2 — cleanup** | ~15 | Hardening, drift, and growth issues. |
| **P3 — nits** | ~8 | Cosmetic / documentation. |

---

## 3. Security findings

### 3.1 (P0) API keys flagged in May were never rotated

**Where**: `server/.env` — `CH_API_KEY` (same `_qKf…` prefix the May review quoted) and `NVIDIA_API_KEY`.
**Why it matters**: these keys have now been pasted into review tooling at least twice, four weeks apart. The mitigations that landed (`.gitignore`, `.env.example`) protect against *future* leakage paths; they do nothing about the values already exposed. `SESSION_SECRET` and the three `SEED_*_PASSWORD` values are in the same file and the seed passwords look like they follow a guessable pattern (`anal…`, `revi…`, `admi…`).
**Fix**: rotate `CH_API_KEY` (CH developer hub) and `NVIDIA_API_KEY` (build.nvidia.com) today; regenerate `SESSION_SECRET` (invalidates sessions — that's fine); re-seed users with strong random passwords (`npm run users:seed` after updating `SEED_*`). Five minutes of work that has been outstanding for four weeks.

### 3.2 (P0) Authorization gaps — analyst can perform reviewer/admin actions

**Where**: `server/index.js:107-111` registers exactly five role guards. Every other mutating route is reachable by any authenticated user (lowest role: analyst).

Unguarded mutating endpoints, with the role they should require per CLAUDE.md's own model ("analyst = run + read, recommend only; reviewer = + final decisions; admin = + edit prompts / risk matrix"):

| Endpoint | Today | Should be |
|---|---|---|
| `PATCH /api/screening/config` (sanctions match threshold!) | analyst | **admin** — this is engine configuration on par with the risk matrix |
| `PATCH …/runs/:runId/hits/:hitId` (override a sanctions/AM decision) | analyst | **reviewer** — overriding a screening decision *is* a decision |
| `POST …/carry-overrides-forward` | analyst | **reviewer** |
| `PATCH /api/parties/:id/overrides` (cross-dossier override) | analyst | **reviewer** — broader blast radius than a per-run override |
| `POST /api/parties/:id/merge` | analyst | **reviewer** — merging identities changes screening outcomes on every linked dossier |
| `POST /api/parties/review-queue/:itemId/resolve` | analyst | **reviewer** |
| `POST/DELETE /api/parties/:id/watchlist` | analyst | **reviewer** (defensible as analyst; decide explicitly) |
| `POST …/qa/recompute`, `POST …/recalculate-risk` | analyst | acceptable as analyst (deterministic rebase, auditable) — decide explicitly |
| `PATCH /api/dossiers/:companyNumber` (tags/notes) | analyst | fine as analyst |

**Why it matters**: the R1 work built a real role system and then left the highest-impact override surfaces outside it. An analyst dismissing a sanctions hit via the PATCH and carrying it forward silently neuters future screening of that party on every dossier — exactly the action the reviewer tier exists to gate.
**Fix**: extend the guard block in `index.js` (or move guards into each route module next to the handler, which scales better than the central list — the central list already missed these). One line per route. Update `auth-smoke.js` to assert 403s for an analyst on each.

### 3.3 (P2) Login timing-uniformity defence doesn't work

**Where**: `routes/auth.js:144` — the dummy hash `'$2a$12$0000…'` is 59 characters; a valid bcrypt hash is 60. bcryptjs detects the malformed hash and returns false without doing the ~100ms of key-derivation work, so the username-exists timing oracle the comment says it closes is still open.
**Fix**: generate one real hash at module load — `const DUMMY_HASH = hashPasswordSync(crypto.randomBytes(16).toString('hex'))` — and compare against that.

### 3.4 (P2) CSRF token comparison is not constant-time

**Where**: `services/auth/index.js:96` — `sent !== expected`.
**Fix**: `crypto.timingSafeEqual(Buffer.from(sent), Buffer.from(expected))` with a length pre-check. Marginal in practice (tokens are 64 hex chars over HTTP) but it's a one-liner and reviewers will flag it forever.

### 3.5 (P2) Login rate limiter shares one bucket behind the dev proxy

**Where**: `routes/auth.js:18-25` keys on `req.ip`; `app.set('trust proxy', …)` is never called. Behind the Vite dev proxy (and any future reverse proxy) every client is `127.0.0.1`, so (a) one attacker locks out all users for 15 minutes — a trivially-triggered DoS of the login page, and (b) per-IP semantics are meaningless.
**Fix**: for the POC, key the limiter on `username` (lowercased) instead of/in addition to IP; if a reverse proxy ever fronts this, set `trust proxy` accordingly.

### 3.6 (P2) Web fetch wrapper retries *every* 403'd mutation

**Where**: `web/src/lib/api.js:70-77` — any 403 on a mutating call triggers a CSRF refresh and a full re-send. Role-guard 403s (`{error:'forbidden'}`) therefore fire the request twice. Harmless today because the guard rejects both times before the handler runs, but it's a latent double-submit for any future endpoint that returns 403 *after* side effects.
**Fix**: parse the body and retry only when `error === 'invalid_csrf_token'`.

### 3.7 (P3) ILIKE wildcard injection in search filters

**Where**: `repo.js:210-211` (`listDossiers`), `repo.js:1382-1383` (`listPartiesPage`) — user `q` is interpolated into `%…%` without escaping `%`/`_`. Parameterized (no SQLi), but a `%%%…` query forces pathological scans.
**Fix**: `q.replace(/[%_\\]/g, '\\$&')`.

### 3.8 (P3) Stale security comment in `routes/parties.js`

The header (lines 8-12) still says "this repo has no authn — userId comes from the x-user-id header". Misleading for the next reader; the actual identity comes from the session. Delete/rewrite the paragraph when adding the role guards from §3.2.

---

## 4. Reliability / correctness findings

### 4.1 (P1) Duplicate concurrent run becomes a ghost run, not a 409

**Where**: index `runs_one_running_per_dossier` (0010) + `sse/runtime.js:118-156` (`ensureRunPersisted`).
**What happens**: second `POST /api/run` (or refresh) for a company that already has a `running` run → graph starts → first chunk with `companyNumber` → `repo.createRun` violates the partial unique index → `ensureRunPersisted` catches, logs, returns `null` → **the graph keeps executing to completion** (CH calls, OCR, LLM evaluations) with `t.runId === null`: no run row, no fragments, no screening hits, no audit trail. The user watches a live SSE stream of a run that never existed. In queue mode the same applies inside the worker.
**Fix** (two layers):
1. Route-level pre-check in `POST /api/run` / `refresh` / `rescreen`: if `repo` finds a `running` run for the dossier, return `409 { error:'run_in_progress', threadId }` so the UI can offer "attach to the running run" instead. (Start-by-name runs don't know the dossier yet — layer 2 covers those.)
2. Runtime-level: in `ensureRunPersisted`, detect pg error `23505` on `runs_one_running_per_dossier`, mark the thread cancelled, emit an SSE `error` event ("a run is already in progress for this company"), and stop the graph (`t.cancelled = true` is already honoured at the next terminus; better, throw so `runGraph`'s catch closes the stream immediately).

### 4.2 (P2) `applyDecision` sequence allocation: stale comment, no conflict retry

**Where**: `services/decision/index.js:128-139`.
The comment still says "If a unique (run_id, sequence) constraint is added later…" — it **was** added (0010). Today a collision (e.g. a graph fragment landing between the `max()` read and the insert, or two concurrent decisions) makes the insert throw 23505 and the whole decision transaction roll back as a 500 — the reviewer's decision is lost.
**Fix**: catch 23505 inside `applyDecision` and retry the txn once (re-reading `max(sequence)`); update the comment. ~10 lines.

### 4.3 (P1) `NotifySink` silently drops events it fails to persist

**Where**: `services/eventSink.js:96-119` — each `appendRunEvent` failure is logged and skipped; the flush loop continues, `drain()` reports success.
**Why it matters**: in queue mode `run_events` *is* the SSE stream. If the row that fails is `done`/`cancelled`/`interrupt`, every replay forever shows the run still in flight: `getThreadStreamState` reports not-interrupted/not-terminal, the resume guards refuse, `/runs/active` keeps listing it. One transient Postgres blip at terminus wedges the run's UI state permanently (until the row reaper deletes the whole stream).
**Fix**: retry failed appends (2-3 attempts with short backoff) and keep the failed batch at the head of `pending` rather than dropping it; have `drain()` throw (or return `{ok:false}`) if events remain unpersisted so `worker.js#handleJob` can fail the job loudly instead of completing it.

### 4.4 (P2) Worker reconcile bypasses the concurrency cap

**Where**: `worker.js:108-113` — reconciled runs call `executeRunJob` directly (fire-and-forget), outside pg-boss's `localConcurrency`. A worker that boots with 2 crashed runs + 1 queued job drives three graphs concurrently against a serial Ollama. Wall-clock degrades; nothing breaks.
**Fix**: re-enqueue `resumeFailed` jobs via `enqueueRun` instead of driving them in-process — the queue then serializes them naturally (and the jobs survive a second crash during reconciliation, which the current in-process drive does not).

### 4.5 (P2) `extractStructured`: blind retry, no timeout (carried over from May)

**Where**: `services/llm/index.js:87-95`.
Still catches *every* error class — a provider network failure or timeout triggers a full second extraction (doubling multi-minute wall-clock) with a JSON-strictness prefix that can't help. Still no per-call timeout/abort: a wedged provider stalls the node, and in queue mode burns the job until the 2h `expireInSeconds`.
**Fix**: (a) retry only on parse/validation-shaped errors (zod errors, `OutputParserException`, JSON.parse failures); rethrow network/timeout errors immediately. (b) wrap the provider call in an `AbortSignal.timeout(LLM_CALL_TIMEOUT_MS)` (default generous, e.g. 10 min) and plumb the signal into the providers.

### 4.6 (P2) Inline SSE heartbeat can throw uncaught

**Where**: `routes/runs.js:191-193` — the inline-mode heartbeat `res.write` has no try/catch (the queue-mode one at line 152 does). A write against a response torn down without a `close` event throws inside the `setInterval` callback → uncaught exception → process exit. Narrow race, one-line fix: copy the queue-mode `try { … } catch { /* noop */ }`.

### 4.7 (P2) `runEventsBus._pump` gives up until the next NOTIFY

**Where**: `services/runEventsBus.js:143-147` — a transient DB error mid-pump is logged and the pump stops. If the run has already finished (no further NOTIFYs on that channel payload), the subscriber never receives the tail — including the terminal event — until reconnect.
**Fix**: on pump failure, schedule one retry (`setTimeout(() => this._pump(sub), 1000)`) instead of waiting for a NOTIFY that may never come.

### 4.8 (P3) `POST /api/run` body is unvalidated

`routes/runs.js:32-47` passes `req.body` straight into graph state via `gatherInput`. The graph tolerates junk, but a Zod schema at the route (name/companyNumber/postcode/incorporationYear, length-capped) would reject garbage before a thread + checkpoint row is created for it.

---

## 5. Performance findings

### 5.1 (P1) `graph-checkpoints.db` grows without bound (48 MB and counting)

**Where**: `server/graph-checkpoints.db`; `graph/build.js:50-52`.
Every LangGraph step on every thread writes checkpoint rows; nothing ever deletes them. Threads are one-shot (UUID per run) so old threads are pure dead weight — and each checkpoint snapshots the *full state*, including OCR text, profile/officers/PSC blobs, and the screening hit set. At POC pace it's 48 MB in ~2 months; a busy demo week doubles it. SQLite performance also degrades as the table grows.
**Fix**: add a boot-time reaper alongside `reapStaleRuns`: delete checkpoint rows for thread_ids whose run reached a terminal status more than N days ago (7 is plenty — resume-failed is the only consumer of old checkpoints). The saver's tables are `checkpoints` / `writes` keyed by `thread_id`; a `better-sqlite3` pass over `SELECT DISTINCT thread_id` joined against `runs` does it. Keep paused-at-interrupt threads unconditionally.

### 5.2 (P1) `getDossier` returns every run's full jsonb snapshots

**Where**: `repo.js:312-327` — `SELECT * FROM runs` for the dossier, all rows, all `final_*` columns. `listDossiers` was carefully fixed in the May pass (lean `DISTINCT ON` projection, jsonb sub-selects) but the single-dossier read — which the DossierViewPage, RunDiffPage and GraphPage all hit — still ships `final_kyc_card + final_screening_report + final_profile + final_officers + final_psc + final_documents + qa_result + receipt` for **every historical run**. Ten runs on a busy dossier ≈ several MB per page load, parsed and discarded by the run-history list which renders only status/trigger/timing.
**Fix**: split into `getDossier` (dossier + lean run summaries: id, status, trigger, timestamps, error, risk tier extract — reuse the `listDossiers` projection) and keep the existing full-blob read only in `getRun` (already exists and is what RunDetailPage uses). Adjust `useDossier`/DossierViewPage to fetch the latest run's detail via the existing `GET …/runs/:runId` when it needs the card.

### 5.3 (P2) `run_events` type-probe queries scan jsonb per thread

**Where**: `repo.js:1119-1137`, `1173-1190` — `payload ->> 'type' = 'interrupt'` / `in ('done','cancelled')` filtered per thread, plus `listActiveRunsFromDb` runs two of these per running run (N+1). Fine at POC scale because streams are reaped at 24h; will degrade if the reaper is ever loosened.
**Fix (cheap)**: add a generated/expression index `ON run_events (thread_id, (payload->>'type'), seq DESC)`, or denormalize `event_type` into a real column at append time. Batch the `listActiveRunsFromDb` probes into one query with `DISTINCT ON (thread_id)` if active-run count ever matters.

### 5.4 (P2) `computeKpis` runs five sequential full scans per dashboard load

**Where**: `repo.js:425-524`. Five separate `db.execute` round-trips (two with `generate_series` joins) on every `/api/dossiers/kpis` hit, uncached. Fine at 100 dossiers; easy win later: run them via `Promise.all` (independent) and/or cache for 30s.

### 5.5 (P3) `getRunEvents` replays the whole tail in one buffer

`runEventsBus._pump` loads every row past the cursor into memory before writing. Streams are capped by the 24h reaper so this is acceptable; add a `LIMIT`/loop if streams ever get longer.

---

## 6. Maintainability findings

### 6.1 (P2) Documentation drift — CLAUDE.md vs reality

- CLAUDE.md still documents `npm run db:generate`; the script was (correctly) removed. Add the "migrations are hand-written; do not run drizzle-kit generate" note to CLAUDE.md **and** `server/db/SETUP.md`, and consider dropping `drizzle-kit` from devDeps entirely (nothing else uses it).
- CLAUDE.md says migrations run `0000`–`0022`; `0023_resume_owed.sql` exists.
- `routes/parties.js` header still describes the pre-R1 `x-user-id` auth model (§3.8).
- `services/decision/index.js:128-133` comment predates migration 0010 (§4.2).
A 30-minute docs pass closes all four; stale docs in a repo that explicitly feeds them to AI agents are a correctness issue, not a cosmetic one.

### 6.2 (P1) `WatchlistPage` is still mock data while a real watchlist API exists

**Where**: `web/src/pages/WatchlistPage.vue:4,58-60` renders `MOCK_WATCHLIST` (fake `GB-…` numbers); `GET /api/parties/watchlist`, the add/remove endpoints, and `repo.listWatchedParties` are all live, and the party pages already write to them. The `/watchlist` nav item shows fabricated data one click away from real screening results — actively misleading in a demo.
**Fix**: rewrite the page against `GET /api/parties/watchlist` (the response already carries name/type/linked-dossier count/reason/addedBy) and delete `stores/mockData.js`. ~Half a day including the empty-state.

### 6.3 (P2) Dead dependency: `pdf-to-png-converter` (carried over from May)

Still in `server/package.json:76`; zero imports outside `node_modules` (rasterization goes through `pdf-parse`'s `getScreenshot`). It drags the `@napi-rs/canvas` binary tree (~40 MB) into every install. `npm uninstall pdf-to-png-converter`.

### 6.4 (P2) ~30 smoke scripts, no aggregator, `test` still exits 1

`server/scripts/` now holds ~27 smoke scripts plus the eval harness, and the count grew with every phase. There is still no `smoke:all`, and `npm test` is still the "no test specified" stub. The known failure mode (per project memory: stale smokes go unnoticed because nothing runs them) compounds with each new script.
**Fix**: add a `scripts/smoke-all.js` runner that executes the node-only smokes (no DB/LLM) by default and everything with `--full`, point `npm test` at the node-only tier. Keep it dumb (sequential, fail-fast).

### 6.5 (P2) `repo.js` is 2,257 lines and still growing

The May review suggested splitting by aggregate root at 24 KB; it's now 74 KB. Every subsystem (runs, screening, risk, QA, parties ×6 concerns, users, run_events) shares one module and one export object of ~90 functions. Mechanical split into `db/repo/{runs,dossiers,fragments,screening,risk,qa,parties,users,runEvents}.js` with `db/repo.js` re-exporting (so no call sites change) is two hours of low-risk work and stops the file's growth curve. `services/party/resolver.js` (27 KB) is next on the watch list but still coherent.

### 6.6 (P3) Small carried-over items

- `uuid` dep used only for thread ids (`routes/runs.js:9`) — `crypto.randomUUID()` drops the dependency.
- `graph/build.js` `SqliteSaver` connection never closed on shutdown (harmless; SQLite).
- `screening_config.bing_results_per_subject` naming survives from the Bing era while the actual provider is GDELT (`opts.count` cap). Rename in a future migration or alias in the route as `resultsPerSubject`.
- `dev-cache.db` `http_cache` has no TTL/eviction; `forceFresh` is the only invalidation. Acceptable, but note it before anyone trusts a stale CH profile.

---

## 7. What's well done (preserve during fixes)

The remediation work since May was high quality; several pieces are worth calling out as patterns to keep:

- **`services/runDispatch.js#executeRunJob`** — one kind→graph mapping shared by inline and worker paths makes mode drift structurally impossible. The cleanest piece of R2.
- **`run_events` transport design**: per-thread `seq` with `UNIQUE (thread_id, seq)` idempotency, replay-from-cursor in `runEventsBus._pump` with the dirty-flag re-run, and the seq-0 queued marker. The ordering/no-miss contract is documented where it's implemented.
- **`finalizeRunQa`** with `mirrorCaseStatus` / `requireLatestRun` options — the transaction encodes the business rules (terminal-state guard, latest-snapshot gate) instead of scattering them across callers.
- **Auth pipeline ordering** (`index.js:87-102`): session → identity → CSRF → gate → role guards → routes, with per-request user reload for instant revocation, login session-regeneration, and the rate-limited login. The dev bypass is properly fenced.
- **`awaitDecision`/`autoFinalize` deliberately not wrapped in `withFragment`**, with the sequence-collision rationale written down at `awaitDecision.js:19-24`. Someone thought hard about the two sequence-allocation conventions and documented the boundary.
- **Migration 0010** is a model hardening migration: idempotent blocks, dirty-data guards that NOTICE-and-skip instead of aborting, and a written rationale for what it deliberately does *not* do (the DELETE trigger).
- **`ensureRunIdentity` helper** (R4a) tamed the "re-derive dossierId/runId from the DB" smell into one shared, documented path.
- **GDELT client** (`adverseMedia/gdelt.js`): serial semaphore with spacing that accounts for edge-metering jitter, separate 429 vs network retry ladders, soft-skip code, and the semaphore held across retries on purpose.
- The **review-comment breadcrumbs** (`See CODE_REVIEW §x.y`) left at each fix site made this re-review dramatically cheaper. Keep doing that — this document's section numbers are the new anchors.

---

## 8. Action plan

Sequenced for dependency and impact; each item has an acceptance check. Items within a phase are independent unless noted. Total estimate: **~6 working days** for everything P0–P2.

> **Execution status (2026-06-10, same day):** Phases **1–4 are implemented and verified** — role guards in route modules + 34-check auth-smoke matrix (1.1–1.5); 409 pre-checks + ghost-run 23505 cancellation + applyDecision retry + NotifySink retry/strict-drain + reconcile re-enqueue + heartbeat/pump hardening (2.1–2.6); checkpoint reaper (boot + `npm run checkpoints:reap [--orphans]`, 11.2→0.6 MB on first run) + lean `getDossier` + migration `0024` expression index + batched active-run probes + narrowed/timeout-guarded `extractStructured` + parallel `computeKpis` (3.1–3.5); real WatchlistPage + `mockData.js` deleted + `uuid`/`pdf-to-png-converter`/`drizzle-kit` removed + `smoke-all.js` (`npm test` = node tier, 14/14 green with `--db`) + `repo.js` split into 10 aggregate-root modules behind a facade (88-export parity verified) + security one-liners + docs pass + `/api/run` Zod gate (4.1–4.7). One stale smoke (`qa-data-smoke` calling long-gone `appendHumanActionFragment`) was fixed in passing.
> **Phase 0 remains with the user.** Note: auth-smoke shows the seeded **admin** password no longer matches `SEED_ADMIN_PASSWORD` — re-run `npm run users:seed` after updating the `SEED_*` values, then `npm run auth:smoke` should be 36/36.

### Phase 0 — today (≈ 1 hour)

| # | Action | Files | Done when |
|---|---|---|---|
| 0.1 | Rotate `CH_API_KEY` + `NVIDIA_API_KEY`; regenerate `SESSION_SECRET`; set strong random `SEED_*_PASSWORD`s and re-run `npm run users:seed` | `server/.env` | Old CH key returns 401 from CH; app boots with new values |
| 0.2 | `git init` at the repo root, verify `git status` shows no `.env`, no `*.db`, no `tmp/`, then make the initial commit | repo root | History exists; secrets untracked. (Do this *after* 0.1 so even the initial commit never knew the old keys' replacement) |

### Phase 1 — authorization hardening (≈ ½ day)

| # | Action | Files | Done when |
|---|---|---|---|
| 1.1 | Add `requireRole('admin')` to `PATCH /api/screening/config` | `server/index.js` or `routes/screening.js` | Analyst PATCH → 403 |
| 1.2 | Add `requireRole('reviewer')` to: hit override PATCH, carry-overrides-forward, party overrides PATCH, party merge, review-queue resolve | `routes/screening.js`, `routes/parties.js` | Analyst on each → 403 |
| 1.3 | Decide + document watchlist add/remove and qa-recompute / recalculate-risk tiers (recommend: watchlist = reviewer; recompute/recalculate = analyst) in CLAUDE.md's auth section | CLAUDE.md + routes | Documented; guards match |
| 1.4 | Prefer registering guards inside each route module (pass `requireRole` via `register(app, deps)`) instead of growing the central list in `index.js` — the central list is how these were missed | `routes/*` | Guards live next to handlers |
| 1.5 | Extend `auth-smoke.js`: for each guarded route, assert analyst→403 and reviewer/admin→non-403 | `scripts/auth-smoke.js` | `npm run auth:smoke` covers the new matrix |

### Phase 2 — run-lifecycle correctness (≈ 1 day)

| # | Action | Files | Done when |
|---|---|---|---|
| 2.1 | Ghost-run fix, route layer: pre-check `running` run on refresh/rescreen → `409 { error:'run_in_progress', threadId }` | `routes/runs.js` | Concurrent refresh returns 409 with the live threadId |
| 2.2 | Ghost-run fix, runtime layer: in `ensureRunPersisted`, on pg `23505` (constraint `runs_one_running_per_dossier`) set `t.cancelled = true`, emit SSE `error` event, and throw so `runGraph` closes the stream | `sse/runtime.js` | Second start-by-name run for the same company halts within one chunk; no orphan LLM work |
| 2.3 | `applyDecision`: retry once on 23505 sequence conflict; fix the stale comment | `services/decision/index.js` | Decision survives a concurrent fragment insert; comment matches reality |
| 2.4 | `NotifySink`: retain + retry failed appends; make `drain()` surface persistent failure; fail the worker job loudly when terminal events can't persist | `services/eventSink.js`, `worker.js` | Kill Postgres for 5s at run terminus in queue mode → events arrive after recovery; no permanently-stuck run |
| 2.5 | Worker reconcile: re-enqueue `resumeFailed` jobs via `enqueueRun` instead of in-process drive | `worker.js` | Reconciled runs respect `WORKER_CONCURRENCY`; survive a crash during reconcile |
| 2.6 | try/catch the inline SSE heartbeat write; add the `_pump` failure retry timer | `routes/runs.js`, `services/runEventsBus.js` | Both paths survive injected write/DB errors |

### Phase 3 — performance (≈ 1 day)

| # | Action | Files | Done when |
|---|---|---|---|
| 3.1 | Checkpoint reaper: boot-time job deleting SQLite checkpoint rows for threads whose run is terminal and older than `CHECKPOINT_RETENTION_DAYS` (default 7); never touch paused-at-interrupt threads | new `scripts/checkpoint-reap.js` + call in `index.js#start` | `graph-checkpoints.db` shrinks (VACUUM) and stays bounded; resume-failed within 7 days still works |
| 3.2 | Lean `getDossier`: project run summaries (reuse the `listDossiers` jsonb projection); DossierViewPage fetches full latest-run detail via existing `GET …/runs/:runId` | `db/repo.js`, `web/src/composables/useDossier.js`, `DossierViewPage.vue` | `/api/dossiers/:cn` payload drops from MBs to KBs on a 10-run dossier; card still renders |
| 3.3 | Expression index on `run_events (thread_id, (payload->>'type'), seq DESC)`; batch the `listActiveRunsFromDb` probes | migration `0024`, `db/repo.js` | EXPLAIN shows index use; `/api/runs/active` is one round-trip + one probe query |
| 3.4 | `extractStructured`: narrow the retry to parse/validation errors; add `AbortSignal.timeout` plumbed into both providers | `services/llm/index.js`, `providers/*` | Network failure no longer doubles wall-clock; wedged provider fails the node at the timeout instead of hanging |
| 3.5 | `computeKpis`: `Promise.all` the five queries; optional 30s in-process cache | `db/repo.js` | KPIs latency ~⅕; dashboard unchanged |

### Phase 4 — product/maintainability (≈ 1½ days)

| # | Action | Files | Done when |
|---|---|---|---|
| 4.1 | Rebuild `WatchlistPage` on `GET /api/parties/watchlist`; delete `stores/mockData.js` | `web/src/pages/WatchlistPage.vue` | Page shows real watched parties; zero `MOCK_` imports repo-wide |
| 4.2 | `npm uninstall pdf-to-png-converter`; replace `uuid` with `crypto.randomUUID()` and uninstall | `server/package.json`, `routes/runs.js` | Install size drops ~40 MB; all smokes pass |
| 4.3 | `smoke-all` runner: node-only tier by default, `--full` for DB/LLM tiers; point `npm test` at the node-only tier | `scripts/smoke-all.js`, `package.json` | `npm test` exits 0 and actually runs something |
| 4.4 | Split `db/repo.js` by aggregate root with a re-exporting facade (no call-site changes) | `db/repo/*.js`, `db/repo.js` | Each module < 500 lines; all smokes pass |
| 4.5 | Security one-liners: real dummy bcrypt hash (§3.3), `timingSafeEqual` CSRF compare (§3.4), username-keyed login limiter (§3.5), CSRF-only 403 retry in `lib/api.js` (§3.6), ILIKE escaping (§3.7) | `routes/auth.js`, `services/auth/index.js`, `web/src/lib/api.js`, `db/repo.js` | Each verified by a line in `auth-smoke.js` where testable |
| 4.6 | Docs pass: CLAUDE.md (migrations 0000–0023, remove `db:generate`, auth tiers from 1.3), SETUP.md drizzle-kit note, stale comments in `routes/parties.js` + `services/decision/index.js`; drop `drizzle-kit` from devDeps | docs + 2 comments | Grep for `db:generate`, `x-user-id` (outside bypass), "constraint is added later" returns nothing stale |
| 4.7 | Validate `POST /api/run` body with a small Zod schema (§4.8) | `routes/runs.js` | Garbage body → 400, no thread created |

### Explicitly deferred (agreed POC scope — do not do)

- Hard mid-LLM cancellation in queue mode (documented out of scope).
- Postgres checkpoint saver / horizontal worker scale-out (ARCHITECTURE §16.4).
- Unit-test framework (smoke scripts + eval harness remain the testing story).
- PEP screening, ownership-chain recursion, historical list versioning (SCREENING_PLAN §11).
- Multi-tenancy, production observability.

---

## 9. Re-review protocol

When a finding is fixed, leave a `// See CODE_REVIEW §x.y` breadcrumb at the fix site (the May→June re-verification was fast almost entirely because of these). Next full review: after Phase 4 lands or in ~4 weeks, whichever is first; it should start by re-running §1's verification table against this document.

*End of review.*
