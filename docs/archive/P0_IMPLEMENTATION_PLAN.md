# P0 Implementation Plan

Build-ready plan for every **P0** item in `ARCHITECTURE.md` §16. These are the
"before any shared deployment" blockers. They are sequenced so the cheap,
unblocking work lands first and the one Large item (R2) is de-risked by the
others.

Scope reality: the POC bans Docker and runs locally on native Postgres + two
SQLite files. Every choice below stays inside that constraint — in particular
R2 uses **pg-boss** (a Postgres-backed queue) rather than BullMQ/Redis, because
Postgres is already installed and Redis would need a container the POC forbids.

## The P0 set

| ID | Theme | What | Effort | Status |
|----|-------|------|--------|--------|
| **R0** | Docs | Reconcile `CLAUDE.md` ↔ `ARCHITECTURE.md`; adopt the arch doc as the system view | S | ✅ |
| **R1** | Prod | Auth tier + verified `userId` identity (keep `x-user-id` for local dev only) | M | ✅ |
| **R3** | AI | Extraction/screening **eval harness** with golden dossiers, wired to the prompt registry | M | ✅ |
| **R2** | Prod | Move runs onto a durable job queue + worker; decouple from the HTTP request lifecycle | L | ✅ |

**Recommended build order: R0 → R1 → R3 → R2.** (All four implemented.)
- R0 is a half-day and removes doc drift that every other item references.
- R1 is a self-contained middleware change with one clean chokepoint
  (`readUserId` at `index.js:58`) and is a hard gate for *any* shared use.
- R3 has no infra dependency and is the highest-leverage AI item — it also
  becomes the regression net that makes R2's big refactor safe.
- R2 is the Large, invasive one; do it last, with R3 green as the safety net.

---

## R0 — Docs reconciliation (S)

**Goal.** Make `ARCHITECTURE.md` the authoritative system view and ensure
`CLAUDE.md` doesn't contradict it. Today `CLAUDE.md` is already detailed; the
P0 is to remove drift and cross-link, not to rewrite.

**Why P0.** Every other recommendation cites these docs; if they disagree,
contributors (human or agent) act on stale facts. Low effort, removes friction.

**Steps.**
1. Diff the two docs for factual drift: migration count (`CLAUDE.md` says
   migrations 0000–0019 in several places — confirm against
   `server/db/migrations/` and bump consistently), node count, route list.
2. Add a one-line pointer at the top of `CLAUDE.md` ("system-architecture view:
   `ARCHITECTURE.md`; this file is the agent quick-reference") and vice-versa.
3. Fold the §16 backlog status into `IMPLEMENTATION.md` so the phase tracker and
   the backlog don't diverge.
4. Note the new `P0_IMPLEMENTATION_PLAN.md` / `P1_IMPLEMENTATION_PLAN.md` in both
   index docs.

**Testing.** None (docs). Sanity: grep for the migration-range string and
confirm one consistent number everywhere.

**Risk/rollback.** None.

---

## R1 — User management & authentication (M)

> **Decision (supersedes the original "verify an external token" sketch).** We
> manage users *in the application*: a real `users` table, multiple seeded
> users, and a hardcoded role enum. Chosen because the audit trail's central
> claim — "this *named* human approved this case" — should be first-class and
> demonstrable, not outsourced. This also unlocks the §16.5 four-eyes /
> maker-checker story and removes the SSE auth wrinkle (see below).

**Goal.** Stop trusting `x-user-id` verbatim. Authenticate users against an
application-owned user store, carry identity in a **server-side session**, and
derive every audited actor (`userId`/`role`) from that verified session.

**Why P0.** `readUserId` (`server/index.js:58`) clips the `x-user-id` header and
hands it straight to `applyDecision` as the immutable audit actor — and the web
client doesn't even send the header, so **every action is currently attributed
to the constant `local-user`**. The system carefully makes the `human_action`
fragment immutable while writing an unauthenticated, spoofable identity into it.
For a KYC system that's a compliance hole, not a nicety.

**Decisions locked (see conversation):**
- **Session transport: server-side sessions backed by Postgres**
  (`express-session` + `connect-pg-simple`) in an **httpOnly** cookie — *not*
  stateless JWT. Rationale: real revocation (logout / role-change / suspicion),
  durable + shared across the web and the future R2 worker process (same
  Postgres store → same identity), and production-keepable. The cookie is sent
  automatically by `EventSource`, so **the SSE auth problem disappears** (no
  query-param tokens, no stream tickets).
- **Credentials: real passwords**, hashed with **`bcryptjs`** (pure JS, zero
  native deps — matches the `@napi-rs/canvas` choice; avoids Windows native
  build pain). Cost factor ~12. Passwords never logged.
- **Roles: `analyst` | `reviewer` | `admin`** (hardcoded enum on the user row).
  - `analyst` — run + read, recommend only; **cannot** make a final decision.
  - `reviewer` — `analyst` + make final decisions / approvals.
  - `admin` — `reviewer` + edit prompts, risk matrix, screening config.

**Production-grade considerations (built in, not deferred):**
- **CSRF.** Cookie auth means the browser auto-sends credentials, so
  state-changing routes need CSRF protection: `SameSite=Lax` cookies **plus** a
  CSRF token on POST/PATCH/DELETE. SSE is a GET → unaffected.
- **Cookie flags:** `httpOnly`, `Secure` (prod), `SameSite=Lax`, signed, rolling
  TTL with idle + absolute expiry.
- **Login rate-limit** (`express-rate-limit`) to blunt brute force.
- **No credentials in source.** Seed users from `.env`-provided initial
  passwords (e.g. `SEED_ADMIN_PASSWORD`), not committed literals.
- **Maker-checker hook:** with `analyst` unable to approve, segregation of
  duties is ready; a later "approver ≠ the analyst who ran it" check is then a
  small addition on the decision route. We stub the hook, don't enforce same-user
  yet.

**Data model.**
- `users` — `id`, `username` (unique), `display_name`, `password_hash`,
  `role` (enum `analyst|reviewer|admin`), `active`, `created_at`,
  `last_login_at`.
- Session table — managed by `connect-pg-simple` (its standard `session` table;
  created via the library's `createTableIfMissing` or an explicit migration).

**Files.**
- `server/db/migrations/00XX_users.sql` + `server/db/schema.js` — `users` table
  + `user_role` enum (and the `session` table if we migrate it explicitly).
- `server/services/auth/passwords.js` — **new**. `hash(pw)` / `verify(pw, hash)`
  via `bcryptjs`.
- `server/services/auth/session.js` — **new**. `express-session` +
  `connect-pg-simple` store config; cookie policy.
- `server/services/auth/index.js` — **new**. `authMiddleware` →
  `req.auth = { userId, username, role }`; `requireAuth`, `requireRole(...)`
  guards; CSRF middleware.
- `server/routes/auth.js` — **new**. `POST /api/auth/login` (rate-limited),
  `POST /api/auth/logout`, `GET /api/auth/me`, `GET /api/auth/csrf`.
- `server/db/repo.js` — `getUserByUsername`, `touchUserLogin`, user helpers.
- `server/scripts/seed-users.js` — **new**. Seeds analyst/reviewer/admin from
  env passwords; idempotent.
- `server/index.js` — mount session + auth middleware before route registration;
  **rewrite `readUserId` to return `req.auth.userId`** and drop the `x-user-id`
  trust (a dev-only bypass may sit behind an env flag, **off by default**);
  apply `requireRole` to decision + Settings-mutation routes.
- `server/routes/decision.js`, `server/routes/parties.js` — keep `{ readUserId }`
  signature; they now receive a verified id. Add `requireRole('reviewer')` to the
  decision POST.
- `server/routes/{prompts,risk,screening}.js` — `requireRole('admin')` on
  mutating endpoints (new prompt version / setActive, matrix version / setActive,
  screening-config writes).
- `web/src/pages/SignInPage.vue` — real login form (username + password).
- `web/src/stores/auth.js` — **new**. Current user from `/api/auth/me`;
  login/logout actions.
- `web/src/lib/http` / Axios setup — `withCredentials: true`; attach CSRF token
  on mutating requests; 401 interceptor → redirect to sign-in.
- `web/src/router/index.js` — navigation guard: unauthenticated → `/signin`;
  hide/deny admin-only routes by role.
- `.env` — `SESSION_SECRET`, `SESSION_TTL`, `COOKIE_SECURE`, `SEED_*_PASSWORD`,
  optional `AUTH_DEV_BYPASS` (default off).

**Steps.**
1. Migration + schema: `users` table + `user_role` enum; repo helpers.
2. `services/auth/passwords.js` (bcryptjs) + `seed-users.js`; seed the three
   users from env.
3. `services/auth/session.js` (express-session + connect-pg-simple) and mount it.
4. `routes/auth.js`: login (verify password, regenerate session, set identity),
   logout (destroy session), `/me`, `/csrf`. Add login rate-limit.
5. `services/auth/index.js`: `authMiddleware` populates `req.auth`; `requireAuth`
   / `requireRole`; CSRF verification on mutating methods.
6. Rewrite `readUserId`; apply `requireRole` guards to decisions + admin routes;
   remove `x-user-id` trust.
7. Frontend: auth store, real sign-in form, `withCredentials`, CSRF header, 401
   interceptor, router guard, role-gated UI.

**Testing.** New `scripts/auth-smoke.js`: login with correct/incorrect password;
session cookie round-trips; `/me` reflects the user; an `analyst` is `403` on the
decision route while a `reviewer` succeeds; a mutating request without a CSRF
token is rejected; logout invalidates the session. `decision-smoke` updated to
authenticate first (or run with `AUTH_DEV_BYPASS` for the pure-engine path).

**Risk/rollback.** This retires the CLAUDE.md "no auth / sign-in is a UX prop"
scope guard — update the docs as part of the change. Main risks: (1) CSRF done
wrong locks out the SPA — mitigate with the `SameSite=Lax` + token combo and an
auth-smoke assertion; (2) every existing route now sits behind auth — keep
`GET /api/health` public and verify the SSE GET works via the cookie. Rollback is
the `AUTH_DEV_BYPASS` flag for local engine work, not a return to spoofable
headers.

**Sequencing.** Before R2 so the worker/queue inherits a verified identity on
every job, and the Postgres session store is already the shared identity source
across processes.

---

## R3 — Extraction/screening eval harness (M)

**Goal.** Replace "every prompt change is a blind change" with a golden-set
harness that scores extraction field accuracy, sanctions confirm/dismiss
precision/recall, and adverse-media classification — and that can A/B a candidate
prompt version against the active one **before** activation.

**Why P0.** There is no automated measure of LLM-judgement quality today, only
manual `*-smoke.js` scripts. This is the single highest-leverage AI item and the
prerequisite for safely changing any prompt (and for R2's refactor — it's the
regression net).

**Design.**
- **Golden corpus** under `server/eval/golden/`: a set of cases, each a frozen
  input snapshot + expected labels. Three case types:
  1. **Extraction** — a CH document (or its already-rasterised pages / cached
     OCR text) + the known-correct extracted records (shareholders, financials,
     subscribers).
  2. **Sanctions** — a subject + a known list-truth (is this a true hit?), so we
     can score the `evaluate_sanctions_hit` LLM confirm/dismiss/needs_review.
  3. **Adverse media** — a subject + GDELT-style headlines + the
     known-correct category/severity/relevance labels.
- **Runner** (`server/eval/run.js`): for each case, call the *real* service path
  (`extractStructured` with the extractor schema/prompt;
  `evaluate_sanctions_hit` / `evaluate_adverse_media` prompts) and score against
  the labels. Deterministic, no network where possible (use cached OCR + frozen
  GDELT fixtures so the harness is reproducible and free).
- **Metrics:** extraction → per-field precision/recall + exact-record match rate;
  sanctions → confusion matrix + precision/recall on `confirmed`; adverse media →
  classification accuracy + category F1. Emit a JSON report + a human summary.
- **Prompt A/B:** the harness takes a `--prompt-version <key>=<id>` override that
  loads a *non-active* prompt version from the registry (the registry already
  supports `getVersion`/`listAll`) and scores it against the active baseline,
  printing a per-metric delta. This is what lets compliance trial a prompt before
  `setActive`.

**Files.**
- `server/eval/golden/` — **new** fixtures (`*.json` cases + any cached OCR text /
  rasterised pages committed as fixtures, kept small).
- `server/eval/run.js` — **new** runner/CLI.
- `server/eval/score.js` — **new** scoring functions (pure, unit-testable).
- `server/eval/labels.schema.js` — **new** Zod schemas for the label files so a
  malformed golden case fails fast.
- `server/services/prompts.js` — confirm `getVersion(key, id)` read path exists;
  if A/B needs a "load this specific version" entry point, add one (the active
  read path is `loadPrompt`; A/B needs `loadPromptVersion(key, id)`).
- `server/package.json` — `"eval": "node eval/run.js"`,
  `"eval:ab": "node eval/run.js --prompt-version …"`.
- Reuse `services/llm/index.js` (extraction) and the two screening evaluate nodes'
  underlying prompt calls — factor the LLM-call core out of
  `graph/nodes/screening/evaluateSanctionsHits.js` /
  `evaluateAdverseMedia.js` into a callable function if it's currently
  node-bound, so the harness exercises the exact same code path as production.

**Steps.**
1. Define the label schemas + 1 case per type end-to-end (walking skeleton) so
   the runner + scorer are exercised before scaling the corpus.
2. Factor the screening-evaluation LLM call out of the graph node into a reusable
   function (production node calls it; harness calls it). Same for extraction —
   it already goes through `extractStructured`.
3. Build `score.js` (precision/recall/F1, field-level diff) — pure, with its own
   `scripts/eval-score-smoke.js`.
4. Build the runner: iterate golden cases, call services, score, emit report.
5. Add the prompt-version A/B override + delta report.
6. Grow the corpus to ~5–10 cases per type (enough signal without becoming a
   maintenance burden — this is a POC harness, not a full benchmark suite; cap it
   and say so).

**Testing.** The harness *is* test infrastructure — but keep it honest: a
`scripts/eval-smoke.js` runs the walking-skeleton case offline (cached OCR +
frozen GDELT) and asserts the report shape + that a deliberately-wrong prompt
scores worse than the baseline.

**Risk/rollback.** Pure addition; no production path changes except the
extraction/evaluation refactor-to-callable (covered by existing
`screening-smoke` / `llm-smoke`). Don't let it balloon into a test framework
(CLAUDE.md explicitly warns against that) — golden corpus stays small and frozen.

**Sequencing.** Before R2 — a green eval run is the safety net for the run-model
rewrite. Independent of R0/R1.

---

## R2 — Durable run execution: queue + worker (L)

> **Status: ✅ Implemented.** pg-boss queue (`services/queue.js`, single `run`
> queue) + worker (`server/worker.js`) + the `run_events` table (migration
> 0022) + LISTEN/NOTIFY transport (`services/eventSink.js` NotifySink →
> `services/runEventsBus.js`). Flag-gated by `RUN_EXECUTION` (default `inline`
> = unchanged). `services/runDispatch.js` is the single inline-vs-queue branch +
> the shared `executeRunJob` mapping. Verified by `npm run queue:smoke` (8/8:
> NotifySink→run_events→bus replay+live, pg-boss enqueue→work) and a live
> worker-driven run that paused at the entity interrupt with events landing in
> `run_events` in seq order. The decision apply-then-resume is now a durable job
> in queue mode (closes P1 R4b). See CLAUDE.md "Durable run execution (R2)". The
> cross-process **restart test** remains a manual check (needs Ollama + CH).

**Goal.** Move graph runs out of the HTTP request that starts them and out of the
in-memory `RunRegistry`, onto a durable Postgres-backed job queue with a worker
pool. A process restart must not lose in-flight runs; SSE must reconnect to a
run driven by the worker; the LangGraph checkpointer becomes the source of truth
for resume.

**Why P0.** Today `POST /api/run` does `setImmediate(() => runGraph(...))`
(`routes/runs.js:15`) — the run executes inside the web process with **all live
state in the in-memory `RunRegistry`** (`sse/runtime.js`). A restart loses every
in-flight run's memory (mitigated only by the boot reaper + the checkpointer).
It's also the scaling ceiling: one process, shared pool, serial Ollama.

**The hard part (be honest about it).** SSE currently streams from the in-memory
`t.events` buffer that `runGraph` writes to *in the same process*. If the worker
runs the graph in a **different** process, the web process's SSE handler can no
longer read that buffer. So R2 is really two coupled changes:
1. **Execution** moves to a worker (pg-boss job → `runGraph`).
2. **Event transport** must cross the process boundary: the worker publishes
   SSE events to a shared channel; the web SSE handler subscribes.

**Design (Postgres-only, no Redis/Docker).**
- **Queue: `pg-boss`** (Postgres-backed). Jobs: `run.start`, `run.resume`,
  `run.rescreen`, `run.refresh`. Payload carries `threadId`, input/command, the
  graph selector, `forceFresh`, and the verified `userId` from R1.
- **Worker process** (`server/worker.js`): a pg-boss subscriber that runs
  `runGraph` against the compiled graphs. Same code, different host process. Can
  run as a second `node` process (no container needed).
- **Event transport: Postgres `LISTEN/NOTIFY`** (already have `pg`). The worker's
  `pushEvent` does `NOTIFY run_events, '<threadId>:<json>'` (or writes to a
  lightweight `run_events` table and notifies a channel; table-backed is more
  robust for replay). The web SSE handler `LISTEN`s and fans out to the connected
  `res`. Replay-on-reconnect reads the tail from the `run_events` table instead
  of the in-memory buffer.
- **Checkpointer as source of truth for resume.** Already true via `SqliteSaver`
  (`graph-checkpoints.db`) — but if the worker is a separate process, that SQLite
  file must be reachable by the worker (it's a local file → fine for a
  single-host POC; note that multi-host would need the Postgres checkpoint saver,
  which §16.4 already flags). For the POC: **single-host, worker + web share the
  filesystem**, so SQLite checkpointer stays. Document that horizontal scale-out
  needs the Postgres saver (deferred, P2 in §16.4).
- **`RunRegistry` becomes per-process cache, not the system of record.** Lazy
  dossier/run creation, fragment persistence, hit/eval persistence already write
  through to Postgres in `emitDelta` — that part is reusable as-is. What changes
  is *where* `runGraph` executes and *how* events reach the browser.

**Migration strategy (incremental, keep it shippable at each step).**
1. **Step 0 — extract the event sink.** Refactor `registry.pushEvent` to go
   through an injectable `EventSink` interface. Today's sink writes to the
   in-memory buffer + live `res`. This is a no-op refactor that unlocks a second
   sink implementation. Ship it; nothing changes behaviourally.
2. **Step 1 — table-backed events + replay.** Add a `run_events` table
   (`threadId`, `seq`, `payload jsonb`, `ts`). Make the in-process sink also
   append there; make SSE replay read from it. Still single-process. Ship.
3. **Step 2 — introduce pg-boss + worker, same process first.** Start pg-boss in
   the web process; route `POST /api/run` to enqueue `run.start` instead of
   `setImmediate(runGraph)`; the in-process pg-boss handler runs `runGraph`. No
   transport change yet (still same process). This proves the queue path with
   minimal blast radius. Ship behind `RUN_EXECUTION=queue|inline` (default
   `inline`, flip to `queue` once green).
4. **Step 3 — move the worker to its own process + NOTIFY transport.** Stand up
   `server/worker.js`; the worker's `EventSink` writes to `run_events` +
   `NOTIFY`; the web SSE handler `LISTEN`s and pushes to `res`. Now a web
   restart doesn't kill the run; the worker keeps going and events keep landing
   in `run_events`; the browser reconnects and replays the tail. Ship.
5. **Step 4 — boot reconciliation.** On worker boot, requeue/resume any
   `running` run with a live checkpoint; on web boot, the SSE handler can serve
   any thread purely from `run_events` + the DB (no in-memory dependency).

**Files.**
- `server/worker.js` — **new** worker entrypoint (pg-boss subscriber).
- `server/services/queue.js` — **new** pg-boss setup + job definitions.
- `server/services/eventSink.js` — **new** sink abstraction (in-memory, table,
  notify implementations).
- `server/db/migrations/00XX_run_events.sql` + `server/db/schema.js` —
  `run_events` table (+ index on `(thread_id, seq)`); optional `runs.worker_id`
  / heartbeat columns for liveness.
- `server/sse/runtime.js` — `pushEvent` → `EventSink`; `runGraph` stays but is
  now invoked by the worker; SSE replay reads `run_events`.
- `server/routes/runs.js` — `POST /api/run`/`refresh`/`rescreen`/`resume` enqueue
  jobs instead of `setImmediate(runGraph)`; `GET /api/stream/:threadId` subscribes
  to NOTIFY + replays from `run_events`.
- `server/routes/decision.js` — the apply-then-resume becomes an enqueue of
  `run.resume` (this also fixes the P1 **R4b** fire-and-forget atomicity for
  free — the resume is now a durable job, retriable by the queue).
- `server/index.js` — start pg-boss; `package.json` — `"worker": "node worker.js"`,
  and a dev convenience to run web + worker together.
- `.env` — `RUN_EXECUTION`, `PGBOSS_SCHEMA`, worker concurrency.

**Concurrency note.** Ollama is effectively serial on one host (one GPU). The
worker pool concurrency should default to **1** for the Ollama-backed path so we
don't thrash the model; the win here is *durability + decoupling from the HTTP
lifecycle*, not parallel LLM throughput. Parallelism arrives only if/when LLM
calls move to a hosted provider (NVIDIA NIM path already exists). Say this
explicitly so nobody expects a speedup from R2 alone.

**Testing.**
- `scripts/queue-smoke.js` — enqueue a `run.start`, assert the worker drives it
  to a terminus and `run_events` accumulates.
- **Restart test** (the whole point): start a run, kill the web process
  mid-run, restart it, reconnect SSE → run completed (worker survived) and the
  tail replays from `run_events`.
- Full regression: `decision-smoke`, `screening-smoke`, `qa-integration-smoke`,
  and the **R3 eval run** all green under `RUN_EXECUTION=queue`.

**Risk/rollback.** Highest of the four. Mitigations: (1) every step is shippable
and flag-gated (`RUN_EXECUTION=inline` reverts to today's behaviour exactly);
(2) the event-sink + `run_events` refactor (Steps 0–1) delivers durable replay
*before* any process split, so even partial adoption is a win; (3) keep the
SQLite checkpointer (single-host) so we don't also take on the Postgres-saver
migration in the same change — that's deferred §16.4 work.

**Sequencing.** Last. Depends on nothing technically, but should land with R3
green (regression net) and R1 done (jobs carry a verified `userId`). Note the
bonus: R2's durable `run.resume` job subsumes the P1 **R4b** atomicity fix.

---

## Cross-cutting notes

- **No Docker, Postgres-only.** Queue = pg-boss (Postgres), transport =
  LISTEN/NOTIFY + `run_events` table, checkpointer stays SQLite (single host).
  No Redis, no collector, no container anywhere.
- **R1 → R2 ordering.** Do auth first so every enqueued job carries a verified
  actor; otherwise the queue would persist spoofable identities.
- **R3 is the safety net for R2.** Don't start the run-model rewrite until the
  eval harness gives a green baseline to diff against.
- **R2 absorbs a P1.** The durable `run.resume` job replaces the
  fire-and-forget resume in `routes/decision.js`, closing the P1 R4b
  apply-then-resume atomicity gap as a side effect.
- **Migrations.** R1 needs `users` (+ `user_role` enum, + the `connect-pg-simple`
  `session` table); R2 needs `run_events` (+ optional worker-liveness columns).
  Both append after 0019. R0/R3 need none.
- **SSE auth is solved by the cookie (R1).** The httpOnly **session cookie** is
  sent automatically by `EventSource` on same-origin requests, so
  `GET /api/stream/:threadId` authenticates with no special handling. (This is
  why server-side sessions beat Bearer-in-localStorage here — the latter would
  reintroduce the EventSource-can't-set-headers problem.)
- **R1 retires a scope guard.** It supersedes CLAUDE.md "no auth / sign-in is a
  UX prop" — fold that into the R0 docs reconciliation.

## Effort roll-up

| Item | Effort | New migration | Hard gate for shared deploy | Notes |
|------|--------|---------------|------------------------------|-------|
| R0 | S | no | no | doc reconciliation only |
| R1 | M | yes (`users` + session) | **yes** | app-owned users, Postgres sessions, bcryptjs, roles analyst/reviewer/admin; cookie solves SSE |
| R3 | M | no | no (quality gate) | regression net for R2; keep corpus small |
| R2 | L | yes (`run_events`) | **yes** | incremental + flag-gated; subsumes P1 R4b; no speedup expected |
