# Test strategy & coverage plan

Status: **Phase 5c (web interactive components + remaining pages) complete** (infra + server engines + web pure layer + server integration tier + graph nodes + server routes/repos sweep + web fetch/store composables + display components + page smoke tests + interactive components + remaining pages + server LLM-node integration stubs) · Date: 2026-06-15 ·
Owner: TBD

> **Captured baselines (whole-codebase `coverage.all`):**
> - **Server Phase 0 (2026-06-13):** 8.54% stmts / 9.91% br / 8.05% fn / 8.61% ln over 6,562
>   stmts (was measured over 563 on the old curated list). Floor 8 / 9 / 7 / 8.
> - **Server Phase 1 (2026-06-13):** **11.67% stmts / 14.16% br / 10.8% fn / 11.84% ln** —
>   193 tests (from 109). Pure engines covered: qa (consistency, issueMap,
>   projectCase), sanctions (matcher core + normalize), risk (assessRisk +
>   receipt + normalize lookup + matrix validation + formatRationale), party
>   corroborate, llm/config, gdelt helpers, agents/defs. Floor raised to
>   11 / 13 / 10 / 11 + 8 per-file engine guards.
> - **Server Phase 3 (2026-06-13):** **~32.5% stmts / ~21.1% br / ~29.1% fn / ~34.4% ln** —
>   234 tests (41 integration). Routes + DB repos exercised against a real test
>   Postgres via supertest on the real `buildApp()` pipeline (auth via dev
>   bypass; LLM forced to a dead host so engine-LLM routes hit their template
>   fallback offline). Suites: dossier/run/party repo round-trips; dossier +
>   reference reads; party list/detail/matcher/watchlist/overrides/graph; admin
>   config (risk matrix versions/activate, agent config + enable); risk read +
>   recalculate-risk. db/repo 38%, routes 32%, services/risk 66%. Floor
>   30 / 17 / 26 / 32. **Integration-inclusive number** — the canonical coverage
>   run sets `TEST_DATABASE_URL`.
> - **Server Phase 4 (2026-06-13):** **~34.4% stmts / ~24.0% br / ~31.5% fn / ~36.4% ln** —
>   259 tests. Graph layer: `withFragment` + `state` + pure nodes (selectDocuments,
>   gatherInput, templateRationale) as unit; DB-config nodes (entityResolution,
>   qaCheck) as integration against seeded Postgres. `graph/` top-level 79%.
>   Floor 32 / 19 / 28 / 34.
> - **Server Phase 5 — untested-but-easy (2026-06-14): 44.6% stmts / 33.75% br / 44.6% fn / 47.1% ln** —
>   380 tests (11 new integration suites). Repo modules: users, screening, qa,
>   fragments. Routes: auth (login/CSRF/profile/password), health (/api/health +
>   openapi.json), prompts (CRUD + versioning), screening (config + hits +
>   overrides + carry-forward), qa (get + recompute), runs (validation + cancel +
>   guard paths), decision (all actions + invalid_transition + human_action
>   immutability). Floor 42 / 31 / 43 / 44.
> - **Web Phase 0 (2026-06-13):** 0.25% over 4,331 stmts. Floor 0. Harness proven (2 suites).
> - **Web Phase 2 (2026-06-13):** **10.8% stmts / 6.51% br / 8.06% fn / 11.49% ln** — 76
>   tests (8 suites). lib **96%** (countries, decisionSchema, partyMatchSchema,
>   api wrapper), stores **74%** (auth 90%, decision/dossier/health high, agent
>   store SSE handling 62%), useDecision composable 94%. Floor 10 / 6 / 7 / 11
>   + 6 per-file guards. Low global is expected — components (8.6k LOC) are
>   Phase 5b. "Web ~40%" from the original §8 estimate is unreachable until then.
> - **Web Phase 5b (2026-06-14): 32.2% stmts / 20.16% br / 23.85% fn / 34.83% ln** — 181
>   tests (12 suites, 4 new). Fetch composables: useDossiers, useRiskMatrix,
>   useAgents, usePrompts, useRiskAssessment, useRunDetail, useRunPair, useParties,
>   usePartyReviewQueue, useParty. Store composables: useDossier, useRun (with
>   `store.attach` mocked), useScreening, useRefresh. Display components: SearchForm,
>   CandidateDisambiguation, NotFound, QaNarrative, FinalDecisionPanelReadOnly.
>   Page smoke tests (8 pages): SignInPage, SearchPage, DossiersPage, AuditLogPage,
>   SettingsPage, WatchlistPage, PartiesPage, GraphPage. Key learnings: `useRun`
>   calls `store.attach()` on mount via immediate watcher — must be spied on to
>   prevent SSE side effects; `ALLOWED_TAGS` guards `toggleTag`; `mountPage` must
>   share the `beforeEach` pinia (not create a new one) for store spies to work;
>   DossiersPage kpis template expects `{ dossiersThisMonth: { value, trend }, ... }`
>   nested shape. Floor 31 / 19 / 22 / 33 + 6 per-file guards (carried from Phase 2).
> - **Web Phase 5c (2026-06-15): 63.47% stmts / 40.45% br / 48.47% fn / 68.13% ln** — 244
>   tests (16 suites, 4 new). Interactive components: CountryFlag, AgentTrail,
>   LiveEvidenceCard, ScreeningEvidenceCard, ScreeningHitPanel, PartyIdentityCard,
>   KycCard, RiskAssessmentCard, HealthIndicator, SideNav, TopBar, PartyGraph,
>   FinalDecisionPanel, ScreeningTab. Remaining pages: RunPage, DossierViewPage,
>   RunDetailPage, RunDiffPage, PartyDetailPage, AdminPage (6 pages, all now ≥ 34%).
>   Server integration stubs: assessRisk (template fallback), screenSanctions
>   (no-LLM), evaluateSanctionsHits/AdverseMedia (early-return), synthesizeCard
>   (no-profile guard), processDocuments (empty-docs guard), qaNarrative (hard-fail).
>   Key learnings: cytoscape must be vi.mock'd globally (hoisted); KycCard uses
>   `card.addresses.registered` (pre-formatted string) not `card.registeredAddress`;
>   `auth.user = {...}` seeds the auth store directly (it's an exposed `ref(null)`);
>   ScreeningHitPanel renders display names (`OFAC SDN`, `Needs review`) not raw keys;
>   `<img src="/logo.png">` in SFCs needs `transformAssetUrls: false` in the Vitest
>   vue() plugin to avoid module-resolution failures in jsdom.
>   Floor 61 / 38 / 46 / 66 + 6 per-file guards (carried).

### Running the integration tier (Phase 3+)
Integration suites (`server/test/*.int.test.mjs`) gate on **`TEST_DATABASE_URL`**
so they never touch the dev DB (they TRUNCATE). Locally:
```bash
# one-time: create + migrate a throwaway test DB
createdb kyc_poc_test   # or via psql / pgAdmin
DATABASE_URL=postgres://USER:PW@localhost:5432/kyc_poc_test npm run db:migrate -w server
# then run the full suite (unit + integration) with coverage
TEST_DATABASE_URL=postgres://USER:PW@localhost:5432/kyc_poc_test npm run test:unit:coverage -w server
```
Without `TEST_DATABASE_URL`, `npm run test:unit` runs the unit tier only (the
4 integration files skip). The harness (`test/helpers/appHarness.mjs`) points
`db/client` at the test DB, switches on `AUTH_DEV_BYPASS` (x-user-id ⇒ admin,
CSRF skipped), and mounts the real `buildApp()` for supertest. CI's
`server-tests` job provisions a dedicated Postgres and sets `TEST_DATABASE_URL`.

### Learnings (carry into later phases)
- **LLM mocking & the unit tier must be offline.** Local Ollama responds on the
  dev box, so any "unit" test that reaches `services/llm` runs the real model —
  slow and nondeterministic. Worse, `vi.mock` does **not** reliably intercept a
  module's *runtime* `require('../llm')` (it works for `rationale.js` but not
  `normalize.js`). Rule: keep LLM/cache-dependent paths out of the unit tier;
  cover them in **integration** where the boundary is injected (or the provider
  is mocked at the HTTP level). `formatRationale` (pure) is unit-tested;
  `generateRationale` / `normalizeCountry` miss-path are deferred to integration.
- **`no-unused-vars` flip deferred to Phase 3.** Remaining warnings live only in
  retiring `scripts/*` (converted in Phase 3) and the in-flight `qa/narrative.js`
  WIP. Flipping to error now would churn retiring code and touch a working-tree
  edit, so it stays `warn` until those settle. `no-only-tests` is already error.
- **`all:true` branch counting varies slightly run-to-run** (~0.1–0.2%); keep
  ratchet floors a point or two below measured, and avoid over-tight per-file
  guards (the `sanctions/normalize.js` guard was dropped for this reason).
- **Per-file guards don't survive the mixed unit+integration run.** When an
  integration file *loads* a module (e.g. via `buildApp`) without executing its
  functions, v8 reports that loaded-but-not-run per-file view even though the
  global union is correct. All per-file guards were removed in Phase 3 — the
  global floor + the dedicated engine suites are the protection.
- **Integration files must run sequentially.** They share one test Postgres and
  TRUNCATE between tests; `fileParallelism: false` (vitest.config.mjs) stops
  files racing each other's truncations. Never run two coverage processes
  against the same test DB at once (they'll race and flake).
- **`index.js` exports `buildApp()`** (the app factory, no side effects) and only
  boots when `require.main === module`. Integration tests import `buildApp`; the
  composition root's seeding/LLM-probe/listen stay in `start()`.
- **`vi.mock` cannot intercept the CJS `require` *inside* a graph-node/service
  module** — proven decisively in Phase 4 (a mocked `loadAgentConfig` threshold
  was ignored; the node used the real DB value). The test file's own `import`
  gets the mock, but the module-under-test's internal `require` resolves to the
  real module. **Consequence for the path to 80%:** node/service code that
  depends on the registry, the LLM, the repo, or DB-backed config is **not unit-
  testable with fakes** in this codebase. Three options, in preference order:
  (1) test against the real seeded test DB in the **integration tier** (works
  today for DB/config/repo deps — see `graph-nodes.int.test.mjs`); (2) **refactor
  to dependency injection** (pass the registry/llm in via `config.configurable`
  or a node factory) so the boundary is fakeable — the cleanest long-term fix and
  likely a prerequisite for covering searchCh/fetchApis/synthesizeCard/screening/
  qaNarrative; (3) full-graph integration with captured CH/LLM fixtures. Pure
  nodes (no I/O) remain plain unit tests.

This document assesses the current test harness (server + web), establishes a
coverage baseline, and lays out a phased plan to reach **≥ 80% global code
coverage across the whole codebase** plus a set of automated quality gates. It
also defines how the ~33 `*-smoke.js` scripts are replaced by real,
CI-executable tests with the LLM / Companies House / GDELT boundaries mocked.

> **Scope decision (2026-06-13).** This plan deliberately **revises** the POC
> scope guard in `CLAUDE.md` that said "don't unit-test graph nodes / routes /
> DB modules." The target is now whole-codebase 80%, so those layers are
> in-scope. `CLAUDE.md` must be updated when Phase 0 lands (see §9).

---

## 1. Executive summary

| Area | Today | Target |
|---|---|---|
| Server unit coverage scope | ~17 curated pure-engine files (490 lines measured) | All server JS, ≥ 80% global |
| Server unit coverage value | 79.75% stmts / **69.72% br (RED)** / 87.17% fn / 81.83% ln *on the curated subset only* | ≥ 80% stmts/fn/lines, ≥ 75% branches, **globally** |
| Web test infrastructure | **None** (lint + build only) | Vitest + @vue/test-utils + jsdom, ≥ 80% |
| Integration confidence | ~33 `*-smoke.js` scripts, only the node tier + DB/auth smoke run in CI | DB-dependent smokes → real CI integration tests; LLM/CH/GDELT mocked |
| CI required checks | 4 (gitleaks, server unit+node-smoke, server DB+auth-smoke, web lint+build) | + global coverage gates (server & web), server lint, coverage upload |

**Honest effort framing.** The codebase is ~39,000 LOC (server ≈ 20,900, web ≈
18,250) and the *measured* base today is ~490 lines. Strict global 80% is a
large undertaking — realistically **6–9 focused work-weeks** spread over the
phases in §8, not a single sprint. The plan front-loads infrastructure and the
highest-value/lowest-cost layers (pure engines, schemas, stores, composables)
so coverage climbs fast early, then grinds through routes, graph nodes, DB
repos, and Vue components where each percent costs more.

---

## 2. Current state assessment

### 2.1 Server

**What exists**
- **Vitest unit tests** — 10 suites in `server/test/*.test.mjs` covering the
  pure engines: qa (routing/checks/projection), risk (factors/knockouts/
  thresholds), sanctions matching/normalize, screening report, party canonical,
  registry merge, config secrets, decision schema.
- **`vitest.config.mjs`** — coverage `include` is a hand-curated allow-list of
  ~17 I/O-free files. Thresholds: statements 75 / branches 70 / functions 80 /
  lines 75. **Everything else in the server is invisible to coverage.**
- **~33 `*-smoke.js` scripts** in `server/scripts/`, aggregated by
  `smoke-all.js` into three tiers:
  - `node` (5 scripts) — no DB/LLM/network; runs in CI via `npm test`.
  - `db` (10 scripts) — need Postgres; **not run in CI** except `db-smoke` and
    `auth-smoke` which are invoked directly by the `server-db` job.
  - `full` (6 scripts) — need LLM / CH / a booted app; **local/nightly only.**
- **R3 eval harness** (`server/eval/`) — golden-set LLM quality scorer;
  intentionally never a PR gate.

**Gaps**
- **No coverage on**: all 15 route modules (2,048 LOC), all 31 graph files
  (4,763 LOC, incl. every node body), all 14 DB modules (3,426 LOC), `sse/`
  (661 LOC), and the I/O-bearing services (llm, ch, adverseMedia, party
  resolver/matcher/merge/graph, prompts, queue, eventSink, runDispatch,
  runEventsBus, auth, decision). That is ~90% of server LOC.
- **Smokes are assertion-light and not coverage-instrumented.** They prove a
  path runs; they don't measure it or fail granularly. Most never run in CI.
- **Branch threshold is currently failing locally** (69.72% < 70%) — the gate
  is at its razor's edge and brittle.
- **No ESLint on the server** (web has oxlint + eslint; server has none).

### 2.2 Web

**What exists**
- `oxlint` + `eslint` + `prettier`, and `vite build`. CI runs lint + build.

**Gaps**
- **No test runner at all.** No `vitest`, no `@vue/test-utils`, no jsdom/
  happy-dom, no `@vitest/coverage-v8`.
- **0% coverage** across pages (6,808 LOC / 14), components (8,648 LOC / 23),
  composables (1,384 LOC / 15), stores (824 LOC / 5), lib (369 LOC / 4),
  router (72 LOC), layouts (141 LOC).
- The web/server `lib/` schema twins (`decisionSchema.js`, `partyMatchSchema.js`)
  and `lib/api.js` (fetch wrapper: credentials + CSRF + 401 redirect) are
  untested despite being correctness-critical and easy to test.

### 2.3 CI

- 4 jobs / 4 required checks (gitleaks; server unit+coverage+node-smoke;
  server migrate+db-smoke+auth-smoke against a Postgres service; web lint+build).
- Postgres 17 service is already wired into the `server-db` job — **the
  integration substrate we need already exists.**
- No LLM on CI (correct — keep it that way; we mock the boundary instead).
- No coverage reporting/upload, no per-PR coverage diff, no server lint.

### 2.4 Baseline coverage numbers (measured 2026-06-13)

Current Vitest run **over the curated include-list only**:

```
All files          | 79.75 stmts | 69.72 br | 87.17 fn | 81.83 ln  (449/563 stmts, 401/490 ln)
  services/qa       | 59.19       | 50.74    | 75       | 63.05     ← weakest
  services/sanctions| 60.00       | 43.13    | 72.22    | 63.75     ← weakest
  services/risk     | 97.50       | 85.24    | 100      | 98.18
  services/screening| 100         | 86.88    | 100      | 100
  services/registry | 96.55       | 89.28    | 100      | 100
  services/config   | 96.29       | 93.33    | 100      | 100
```

Even inside the curated set, **qa** (consistencyCheck, issueMap, projectCase)
and **sanctions matcher** are under-tested. These are the first quick wins.

---

## 3. Target & quality-gate definitions

### 3.1 Coverage gates

| Gate | Server | Web |
|---|---|---|
| Statements | ≥ 80% | ≥ 80% |
| Lines | ≥ 80% | ≥ 80% |
| Functions | ≥ 80% | ≥ 80% |
| Branches | ≥ 75% | ≥ 75% |

- **Measured globally** via `coverage.all = true` (instrument every source file,
  not just imported ones) with a small, explicit `exclude` list (see §5.4).
  Replaces the curated `include` allow-list.
- **Ratchet, never regress.** Thresholds rise as suites land (schedule in §8).
  A drop below the current floor fails CI.
- **Per-PR coverage diff** uploaded (Codecov or `vitest --coverage` lcov +
  `lcov`/`codecov-action`), so reviewers see the delta a PR introduces.

### 3.2 Additional quality gates (proposed)

1. **Server ESLint** — add `eslint` (flat config, CommonJS-aware) + `npm run
   lint` in the server workspace; make it a required CI check. Parity with web.
2. **No-skip / no-only guard** — lint rule (`no-only-tests`) so a stray
   `it.only` / `describe.skip` can't silently shrink the suite.
3. **Deterministic tests** — ban real network/LLM in unit+component tiers
   (enforced by mocking, see §5); integration tier uses only the CI Postgres
   service. No `Date.now()`/random flakiness — inject clocks/seeds.
4. **Smoke-rot guard retired** — once DB smokes become real tests, the
   "verify a smoke failure is yours" footgun goes away; remaining LLM smokes
   stay clearly labelled local/nightly.
5. **(Optional, stretch) Mutation testing** on the pure engines (`stryker`) —
   guards against assertion-free "coverage theatre." Nightly, non-gating.
6. **Coverage on new code** — CI comments if a PR adds source files with < 80%
   patch coverage (Codecov patch gate). Prevents backsliding while we climb.

---

## 4. Test pyramid & where each layer lives

```
        ┌───────────────────────────────────────────┐
  few   │  E2E (DEFERRED — not in this plan)         │   Playwright, future phase
        ├───────────────────────────────────────────┤
        │  Integration (CI, real Postgres,           │   server: supertest on the
  some  │  mocked LLM/CH/GDELT)                       │   Express app + repo round-trips
        ├───────────────────────────────────────────┤
        │  Component (web, jsdom) +                   │   @vue/test-utils mount,
        │  Unit (server engines, web stores/          │   mocked fetch / Pinia
  many  │  composables/lib, graph node logic)        │
        └───────────────────────────────────────────┘
```

- **Unit** — pure functions, schemas, store actions, composable logic. Fast,
  no I/O. The bulk of coverage gains.
- **Integration** — Express routes via `supertest` against a test app instance,
  hitting a **real CI Postgres** but with **LLM/CH/GDELT modules mocked**.
  Replaces the `db`-tier smokes. Also covers DB repo modules through the routes.
- **Component** — Vue components mounted in jsdom with mocked `fetch`/stores.
- **E2E** — explicitly **out of scope** for this plan (the chosen web depth is
  "unit + component"). Noted as a future phase.

---

## 5. Mocking boundaries (the enabling work)

Strict 80% is only reachable if the external boundaries are cleanly mockable.
Phase 0 builds these fixtures/mocks once; everything else reuses them.

### 5.1 LLM (`services/llm/index.js`)
Single chokepoint exporting `ocrPage`, `extractStructured`, `checkProviders`.
- Provide `server/test/helpers/mockLlm.js` that `vi.mock`s this module and
  returns scripted structured outputs per prompt key. Graph node + extractor
  tests assert on the *deterministic* logic around the LLM, not the model.
- For route/integration tests, the mock returns canned synthesis/eval results.

### 5.2 Companies House (`services/ch.js` + `services/registry/`)
- Graph nodes import the **registry port**, not `ch.js` directly. Mock the
  registry capabilities (`search/profile/officers/ownership/filings/documents`)
  with fixture JSON captured from real CH responses (sanitised).
- `routes/documents.js` still imports `ch.js` directly — mock `getDocumentBinary`/
  `downloadDocumentToFile` there.
- Add `server/test/fixtures/ch/*.json` (one profile/officers/psc/filing set per
  golden company; reuse the eval corpus where possible).

### 5.3 GDELT (`services/adverseMedia/gdelt.js`)
- Mock the fetch client to return canned `ArtList` JSON; assert the cache layer
  (party-key → name-key → fetch) and the serial semaphore logic with fake
  timers. No live HTTP.

### 5.4 Postgres
- **Unit tier**: mock `db/repo` (the facade) — assert call shape & branching.
- **Integration tier**: use the **real CI Postgres service** (already present),
  run migrations, seed minimal fixtures, truncate between tests. This is how
  DB repo modules and routes earn real coverage.
- A `server/test/helpers/testDb.js` boots a transaction-per-test or
  truncate-per-suite harness against `DATABASE_URL`.

### 5.5 Other boundaries
- **Sessions/auth** — `supertest` agent that logs in once and reuses the cookie
  + CSRF token (mirror `auth-smoke.js` logic, but as assertions). `AUTH_DEV_BYPASS`
  is available for non-auth-focused route tests.
- **pg-boss / SSE / run_events** — covered by the existing `queue-smoke` logic
  rewritten as an integration test; unit-test `eventSink`/`runEventsBus` pure
  bits with mocked NOTIFY.

### 5.6 Coverage exclude list (the only allowed gaps)
Kept deliberately tiny and justified:
- `server/index.js` / `worker.js` composition roots (smoke-covered at boot).
- `db/migrations/**`, `db/migrate.js` (exercised by the migrate CI step).
- `eval/**` (quality harness, not product code).
- `scripts/**` (replaced/retired; any survivors are dev tooling).
- generated/vendored code, `*.config.*`.
- web `main.js` bootstrap.

---

## 6. Server plan (by layer)

Ordered by value-per-effort. Each item is a new `*.test.mjs` (unit) or
`*.int.test.mjs` (integration, real DB).

**6.1 Close the curated-engine gaps (quick wins, no new infra)**
- qa: `consistencyCheck` (all 5 codes), `issueMap` (every code→severity/anchor),
  `projectCase` (party-resolved vs legacy UBO paths, all branches).
- sanctions `matcher.js` (token-set + double-metaphone fallback, threshold
  bands), `normalize.js` edge cases.
- Brings the *existing* gate green and to ≥ 85% on engines.

**6.2 Remaining pure/near-pure services (unit, mock minimal I/O)**
- party: `corroborate`, `merge`, `matcher` (canonical already done), `graph`
  builder. `resolver` is integration (DB) — see 6.4.
- risk: `normalize`, `receipt`, `rationale` (mock LLM), `matrix` (mock repo),
  `index` barrel.
- screening: `evaluateSanctionsHit` / `evaluateAdverseMediaHit` cores (mock LLM).
- adverseMedia: `cache` + `index` + `gdelt` (mock fetch, fake timers).
- config `store`, agents `defs`/`config` (mock repo), prompts (mock repo).
- llm `config.js` (provider selection matrix), cache/retry wrapper (mock
  providers).

**6.3 Graph nodes (unit, mock registry + LLM + repo)**
- Each `graph/nodes/*.js` is `async (state, config) => Partial<state>`. Test the
  decision logic per node with fixture state in / asserted partial out:
  entityResolution scoring, selectDocuments rule, processDocuments truncation,
  synthesizeCard "API authoritative" override, resolveParties idempotency,
  assessRisk template fallback, qaCheck/qaNarrative routing, screening nodes.
- `fragments.js` (`withFragment` timing/error capture, GraphInterrupt
  propagation, qa_narrative hard-fail) and `state.js` reducers.
- `assemble.js` / `build.js` enabled-set topology (the `agents-assemble-smoke`
  logic, as assertions).

**6.4 Routes + DB repos (integration, real CI Postgres, supertest)**
- One `*.int.test.mjs` per route module: runs/stream/lifecycle, dossiers,
  screening, risk, qa, decision, prompts, parties, agents, auth, health,
  documents, meta, docs. Assert status codes, role guards, validation 400s,
  invalid_transition 409s, payload schemas.
- DB repo modules (`db/repo/*`) earn coverage transitively + via direct
  round-trip tests (the `db-smoke` / `party-*-smoke` / `qa-data-smoke` logic).
- `sse/runtime.js` RunRegistry: buffer/fan-out/write-through/GC with a fake sink.
- `services/decision`, `runDispatch`, `eventSink`, `runEventsBus`, `queue`,
  `resumeReconciler` — integration where they touch the DB/queue.

**6.5 Smoke → test conversion map**
| Smoke script | Becomes |
|---|---|
| `qa-engine`, `risk-engine`, `decision-schema-parity`, `eval-score`, `agents-assemble` (node tier) | fold assertions into unit suites (mostly already mirrored) |
| `db-smoke`, `match-smoke`, `party-resolver/corroboration/graph-smoke`, `qa-data-smoke`, `decision-smoke`, `screening-rekey-smoke`, `queue-smoke`, `config-parity` (db tier) | `*.int.test.mjs` against CI Postgres |
| `auth-smoke` | `auth.int.test.mjs` (supertest login/CSRF/role matrix) |
| `screening`, `qa-integration`, `graph-resolver`, `llm`, `eval` (full tier) | integration tests with **mocked LLM/CH/GDELT**; the true-LLM `eval` stays in `eval/` (local/nightly) |
| `match-perf-smoke` | keep as a perf smoke (local), not a coverage test |

Retire `smoke-all.js` tiers as each script is converted; keep a thin
`local-checks` script only for genuinely environment-dependent perf/LLM probes.

---

## 7. Web plan (by layer)

**7.1 Infrastructure (Phase 0)**
- Add devDeps: `vitest`, `@vue/test-utils`, `jsdom` (or `happy-dom`),
  `@vitest/coverage-v8`, `@pinia/testing`.
- `web/vitest.config.js` (jsdom env, Vue plugin, coverage v8, `coverage.all`,
  exclude `main.js`/router bootstrap).
- `web/test/setup.js` — global `fetch` mock, Pinia, router stubs.
- Scripts: `test:unit`, `test:unit:coverage` mirroring server.

**7.2 Pure JS layer (quick wins)**
- `lib/decisionSchema.js`, `lib/partyMatchSchema.js` (twin parity with server),
  `lib/countries.js`, `lib/api.js` (CSRF attach, 401→signin, 403 refresh-retry).
- Pinia stores (`auth`, `agent` SSE slice, `dossier`, `health`, `decision`) —
  actions/getters with mocked fetch.
- Composables (15) — `useDecision`, `useDossier(s)`, `useRun`, `useScreening`,
  `useRiskMatrix`, `useParties`, etc. with mocked fetch/EventSource.

**7.3 Components (the bulk)**
- Mount with `@vue/test-utils` + mocked stores/fetch. Prioritise correctness-
  bearing components: `KycCard`, `ScreeningHitPanel`, `RiskAssessmentCard`,
  `QaNarrative`, `FinalDecisionPanel(/ReadOnly)`, `CandidateDisambiguation`,
  `AgentTrail`, `AgentsPanel`, graphs (mock Cytoscape), `CountryFlag`.
- Pages (14) — render-and-route smoke + key interactions with mocked composables;
  cheaper per-line than full interaction coverage, gets pages over the bar.

**7.4 EventSource / SSE**
- Mock `EventSource` in `test/setup.js`; drive the agent store with scripted
  events to cover the reactive thread slice.

---

## 8. Phased roadmap

Each phase ends green with the coverage ratchet bumped. Estimates assume one
engineer; parallelisable across server/web.

| Phase | Scope | Coverage move | Est. |
|---|---|---|---|
| **0 — Infra & mocks** ✅ | Server: `include`→`all` + exclude list, LLM/CH/GDELT mocks + `testDb` harness (`server/test/helpers/`), ESLint. Web: Vitest+@vue/test-utils+jsdom + 2 proof suites. CI: server `lint`, server+web coverage steps + artifacts. Floors set just below the true baseline (not 80 — that's the ratchet target). | server true baseline 8.5%; web 0.25% (both gated green) | **done** |
| **1 — Server engines green** ✅ | §6.1 + §6.2 (the *pure* subset). Red branch gate replaced with a global floor + 8 per-file engine guards. LLM/DB-bound "engines" (party resolver/matcher, config store, screening eval cores, risk rationale/normalize-miss) re-scoped to the integration tier (Phase 3), since they can't be unit-tested offline. | 193 tests; global 11.7%; qa 60%, risk 69%, pure engines locked | **done** |
| **2 — Web pure layer** ✅ | §7.2 (lib, stores, composables). lib **96%**; stores 74% (agent-store SSE-error/hydrate paths deferred to integration); useDecision 94%. Global stays ~11% until components land (Phase 5) — the "~40%" estimate assumed components. | 76 tests; web global 10.8%; lib/stores locked | **done** |
| **3 — Server routes + DB (integration)** ✅ | Foundation: `buildApp()` factory + `appHarness` (supertest + test Postgres + dev-bypass auth + dead-LLM host) + `TEST_DATABASE_URL` safety gate. Suites: dossier/run/party repo round-trips; dossier/reference/party/admin/risk routes; recalculate-risk via template fallback. **Remaining for full 65%+** (follow-up): screening/qa/decision/documents routes, party merge + review-queue, the remaining DB-repo modules, and role-guard 403s (need real sessions). | 234 tests (41 integ); server global **32.5%**; db/repo 38%, routes 32% | **done (foundation + core routes)** |
| **4 — Graph nodes** ✅ | `withFragment` + `state` reducers/schemas + pure nodes (selectDocuments, gatherInput, templateRationale) as unit; DB-config nodes (entityResolution, qaCheck) as integration. **Discovered `vi.mock` can't fake a node's internal CJS `require`** (see learnings) — so registry/LLM-bound nodes (searchCh, fetchApis, synthesizeCard, processDocuments, screening, qaNarrative) are **deferred pending a DI refactor**. Server global ≥80% therefore needs that refactor + remaining routes/services. | 259 tests; server global **34.4%**; graph top-level 79% | **done (testable nodes)** |
| **5 — Server untested-but-easy** ✅ | 11 new integration suites covering the "easy" route + repo layer not touched in Phase 3: repo-users, repo-screening, repo-qa, repo-fragments; routes-auth (login/CSRF/profile/password), routes-health, routes-prompts, routes-screening, routes-qa, routes-runs, routes-decision. No DI refactor needed — these routes exercise purely DB + validation logic. | 380 tests; server global **44.6%**; floor 42/31/43/44 | **done** |
| **5b — Web components + pages** | §7.3 + §7.4. | web ≥ 80% | 6–8 d |
| **6 — Gate hardening** | Ratchet both to final thresholds; enable patch-coverage gate; (optional) mutation testing nightly; update `CLAUDE.md`. | gates locked at 80/75 | 1–2 d |

**Total: ~27–36 working days (≈ 6–9 weeks elapsed).** Phases 1–2 and 3–5 can run
in parallel across two people, compressing to ~4–5 weeks.

**Ratchet schedule** (CI thresholds, raised at each phase end, never lowered):
Phase 0 hold → P1 server 80/75 on engines via per-directory thresholds →
P3 server global 65 → P4 server global 80/75 → P5 web global 80/75.

---

## 9. Changes to existing docs/config (Phase 0 + 6)

- **`CLAUDE.md`** — replace the "Don't unit-test graph nodes / routes / DB
  modules" guard and the "80% on the pure-engine include list" line with the new
  whole-codebase target + tier model from this doc.
- **`vitest.config.mjs`** — swap `include` allow-list for `all: true` + the §5.4
  `exclude` list; keep ratcheting thresholds.
- **`docs/README.md`** — add this file to the Architecture (live) table.
- **`docs/CI.md`** — document the new required checks (server lint, web tests +
  coverage, coverage upload) and update the ruleset job-name pins (the ruleset
  matches checks by exact job `name` — renaming/adding jobs requires a ruleset
  update or auto-merge hangs).
- **`.github/workflows/ci.yml`** — add web `test:unit:coverage`, server lint,
  fold converted integration tests into the `server-db` job (real Postgres),
  add coverage artifact upload.

---

## 10. Risks & tradeoffs

- **Big bang on `coverage.all`.** Flipping to global instrumentation will show a
  much lower true % than today's curated 80%. Mitigated by holding thresholds in
  Phase 0 and ratcheting up — never let CI go red on the switch itself.
- **Integration test flake/runtime.** Real-Postgres tests are slower and can
  flake on shared state. Mitigate with truncate/transaction-per-test isolation
  and a single serial DB suite if needed.
- **Mock drift.** CH/LLM fixtures can drift from reality. Mitigate by sourcing
  fixtures from the eval corpus and adding a (local/nightly) contract check that
  the mock shapes still match a live sample.
- **Graph-node tests coupling to topology.** Node tests assert on `Partial<state>`
  contracts, not graph wiring, to stay robust to assembly changes.
- **Coverage ≠ quality.** 80% line coverage with weak assertions is a trap; the
  optional mutation-testing gate (§3.2.5) is the antidote on the pure engines.
- **Effort vs POC ethos.** This is a deliberate quality investment that exceeds
  typical POC scope; confirm the business wants the spend before Phase 3+.

---

## 11. Immediate next actions (Phase 0 kickoff)

1. Server: replace `vitest.config.mjs` `include` with `all:true` + exclude list;
   capture the true global baseline number (commit it here).
2. Server: add `server/test/helpers/{mockLlm,mockRegistry,mockGdelt,testDb}.js`.
3. Server: add ESLint flat config + `npm run lint`.
4. Web: install test deps; add `vitest.config.js` + `test/setup.js`; one smoke
   component test to prove the harness.
5. CI: add web test job + coverage upload; hold all thresholds at current values.
6. Update `CLAUDE.md` scope guard + `docs/README.md` index.

---

*Appendix — full per-file target inventory to be generated during Phase 0 from
`coverage.all` output (the uncovered-file list becomes the work backlog).*
