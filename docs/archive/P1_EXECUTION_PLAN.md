# P1 Execution Plan

Build-ready execution breakdown for every item in `P1_IMPLEMENTATION_PLAN.md`,
reconciled against the **post-P0 tree** (R1 auth, R2 queue, R3 eval harness all
landed since that plan was written). Each item lists verified code anchors,
ordered steps, exact new files, env flags, acceptance criteria, and rollback.

## Reconciliation with the landed P0 work (read first)

The P1 plan predates P0 landing. Four assumptions changed:

1. **Migration numbering.** The plan says "next after 0019". Migrations now run
   `0000`–`0022` (`0020` users, `0021` users_email, `0022` run_events). The one
   new P1 migration (R4b) is **`0023_resume_owed.sql`**.
2. **R4b is half-closed by R2.** In queue mode the decision resume is already a
   durable pg-boss job (`routes/decision.js:64-68` says so explicitly). R4b
   shrinks to: (a) an atomic "resume owed" marker written inside the
   `applyDecision` transaction (covers the residual crash window between commit
   and enqueue, and the whole gap in inline mode), (b) boot drains of that
   marker in both processes, (c) idempotent `await_decision` resume. The
   worker's existing `reconcile()` (`worker.js:60-104`) deliberately skips runs
   paused at human interrupts — which is *exactly* the state a
   decision-applied-but-resume-lost run is in, so the marker fills a hole the
   worker reconciler intentionally leaves open.
3. **R3 exists.** R6's confidence calibration and X1's slice 3 were "gated on
   the eval harness" — that gate is now open. We still build the structural
   parts first and measure before slice 3, but the measurement tool is real
   (`server/eval/`, `npm run eval`).
4. **Auth is real.** R7's `/api/metrics` lands *inside* the R1 auth gate by
   default (the global gate covers all `/api/*` except the auth allowlist +
   `/api/health`) — no "gate it later" note needed. One new wrinkle instead:
   in queue mode graph nodes execute in the **worker process**, so node/LLM
   metrics accumulate there, not in the web process. See R7 step 7.

**Build order (unchanged, dependency-aware):**
`C1 → R7 → R4a → R4b → R5 → R6 → X1 → G1`

Suggested checkpoint after each item: run the smoke set listed in that item,
plus `npm run db:smoke` as a cheap regression canary.

---

## C1 — Config-drift parity guard (S)

**Verified anchors.** `scripts/decision-schema-parity-smoke.js` exists (npm
script `decision:schema-parity-smoke`). The unguarded twins:
`services/party/canonical.js` ↔ SQL `name_canonical()` (created in migration
`0012_party_master_matcher.sql`), and `server/lib/partyMatchSchema.js` ↔
`web/src/lib/partyMatchSchema.js`.

**Steps.**
1. **New `server/scripts/canonical-parity-smoke.js`** — behavioural
   differential test:
   - A fixed `CASES` array of ~30 adversarial names: honorifics (`Mr`, `MRS.`,
     `Dr.`, `Sir`), suffixes (`LTD`, `Limited`, `L.T.D.`, `PLC`, `LLP`),
     punctuation (`O'Brien`, `Smith-Jones`, `J. P. Morgan`), unicode
     (`Müller`, `José`, `Łukasz`), casing, double/leading/trailing spaces,
     token reordering, empty-ish inputs (`''`, `'  '`, `'Mr.'`).
   - For each: `nameCanonical(input)` (JS) vs
     `pool.query('SELECT name_canonical($1) AS c', [input])` — assert
     string-equal. Print a per-row diff table on mismatch.
   - Uses `db/client.js`'s pool; requires `DATABASE_URL` (same precondition as
     every other DB smoke).
2. **New `server/scripts/party-match-schema-parity-smoke.js`** — mirror the
   decision-schema smoke's approach: read both files as text, extract exported
   schema names, enum member lists, and `.min(`/`.max(` literals by regex,
   assert set-equality. (Text-twin check is right here — the files are meant
   to be physically identical apart from the CJS/ESM module wrapper.)
3. **New `server/scripts/config-parity-smoke.js`** — umbrella: `require()` and
   run all three checks sequentially (decision schema, party-match schema,
   canonical), collect failures, print one summary line
   (`parity: 3/3 OK` or the failing twin names), set `process.exitCode = 1`
   on any failure.
4. **`server/package.json`** — add `"parity": "node scripts/config-parity-smoke.js"`.
5. **`CLAUDE.md` "Conventions"** — add one line: *"`npm run parity` must pass
   before touching any twin (canonical SQL/JS, decision schema, party-match
   schema). There is no CI server — parity is run manually."*

**Acceptance.** `npm run parity` green on a migrated DB. Mutation test:
temporarily remove the honorific strip from `canonical.js` → the canonical
check fails on an honorific row; revert.

**Rollback.** None needed — pure addition, zero runtime-path changes.

---

## R7 — Structured logging + metrics + run-level tracing (M)

**Verified anchors.** `graph/fragments.js` already captures `startedAt` /
`durationMs` per node (lines 38–55, 75). `decision.js`, `runtime.js`,
`worker.js` etc. use `console.*`. No pino in deps yet.

**Steps.**
1. **Deps:** `npm i pino pino-http` + `npm i -D pino-pretty` (server only).
2. **New `server/services/log.js`:**
   - Root `logger = pino({ level: process.env.LOG_LEVEL || 'info' })`;
     when `LOG_PRETTY=true` (dev), wrap with `pino-pretty` transport.
   - `childLogger(bindings)` → `logger.child({ runId, threadId, nodeId, … })`.
   - Export both. Worker and web share this module (separate process, separate
     stream — fine, lines carry `pid` + `processKind` binding; set
     `processKind: 'worker'` in `worker.js`, `'web'` in `index.js`).
3. **New `server/services/metrics.js`** — tiny in-process registry, no deps:
   - `inc(name, labels = {}, by = 1)` (counter),
     `observe(name, value, labels = {})` (histogram: count/sum/min/max +
     fixed buckets `[50, 200, 1000, 5000, 30000, 120000]` ms).
   - Series key = `name + JSON.stringify(sortedLabels)`.
   - `snapshot()` → plain JSON `{ counters: [...], histograms: [...] }` with
     a Prometheus-ish shape so a later exporter swap is mechanical.
4. **Instrument the one chokepoint:** in `graph/fragments.js#withFragment`,
   around the existing `startedAt`/`durationMs` capture:
   - `metrics.observe('node_latency_ms', durationMs, { node: nodeId })`.
   - `childLogger({ nodeId, threadId: config?.configurable?.thread_id })`
     `.info({ durationMs, status }, 'node complete')` on exit;
     `.error({ err }, 'node failed')` on the caught-error path. After R4a
     lands, also bind `runId: state.runId` (cheap follow-up edit).
5. **LLM + cache + GDELT:**
   - `services/llm/index.js`: time `ocrPage` / `extractStructured` →
     `observe('llm_latency_ms', ms, { task, provider })`; the existing
     `cached` flag → `inc('cache_hit_total', { cache: 'ocr' })` / miss.
   - `services/cache.js`: `inc('cache_{hit,miss}_total', { cache: 'http_cache' | 'kv_cache' })`
     in `kvGet`/HTTP-cache lookups.
   - `services/adverseMedia/gdelt.js`: `inc('gdelt_rate_limited_total')` on
     the `GDELT_RATE_LIMITED` soft-skip; `inc('gdelt_request_total')` per
     real fetch (G1's measurement baseline — do it now, G1 reads it later).
6. **`GET /api/metrics`** — add to `routes/meta.js`: `res.json(metrics.snapshot())`.
   It sits behind the R1 auth gate automatically (any authenticated role).
7. **Queue-mode caveat (document, don't build):** in queue mode the worker
   holds node/LLM metrics. POC answer: the worker logs
   `logger.info(metrics.snapshot(), 'metrics snapshot')` every 5 min
   (`setInterval`, unref'd) and on SIGINT; `/api/metrics` documents that it
   reports **web-process** counters only. Cross-process aggregation is
   deliberately deferred (would need a store — out of POC scope).
8. **Console sweep:** replace `console.*` in `server/` (index.js, worker.js,
   sse/runtime.js, routes/*, services/*) with `logger.*`. **Keep `console` in
   `scripts/*-smoke.js` and `eval/`** (they're CLIs; pretty output is the
   point). Install `pino-http` in `index.js` at `info` level with
   `autoLogging: { ignore: req => req.url.startsWith('/api/stream') }` (SSE
   long-poll spam).

**Acceptance.** `npm run risk:engine-smoke`, `screening:smoke`,
`qa:integration-smoke` pass. After one full run (inline mode):
`/api/metrics` shows one `node_latency_ms` series per executed node and a
non-empty `llm_latency_ms`. Set a bogus `GDELT_DOC_ENDPOINT`, rescreen →
`gdelt_rate_limited_total` > 0. `npm run queue:smoke` still green.

**Rollback.** Mechanical; revert. No schema/state changes.

---

## R4a — Run identity as a first-class state channel (M)

**Verified anchors.** The DB-by-thread fallback lives at
`graph/nodes/resolveParties.js:185-223` (config → `getRunByThreadId` →
`getDossier(companyNumber)`); `autoFinalize.js` has the sibling copy. No other
node greps for thread-based recovery. Per the plan's own recommendation:
**Option B (centralised helper) first**, Option A optional.

**Steps.**
1. **`graph/state.js`** — add two single-writer channels (no reducer):
   `dossierId: z.string().nullable().optional()`,
   `runId: z.string().nullable().optional()`.
2. **New `server/graph/nodes/_identity.js`:**
   ```js
   // ensureRunIdentity(state, config) → { dossierId, runId }
   // Order: state → config.configurable → repo.getRunByThreadId(thread_id)
   //        → repo.getDossier(state.companyNumber) (dossierId only).
   ```
   Lift the body of `resolveParties.js:185-210` verbatim. Pure read, no cache
   beyond what the caller persists via its returned partial state.
3. **`resolveParties.js`** — replace lines 185–223 with
   `const { dossierId, runId } = await ensureRunIdentity(state, config);`
   keep the existing skip-on-no-dossier guard; **add `dossierId, runId` to the
   node's returned partial state** so every downstream node hits the cheap
   `state` branch.
4. **`autoFinalize.js`** — same replacement + write-through.
5. (Optional, separate commit) Option A: in `sse/runtime.js`, when the lazy
   dossier+run upsert fires, stash `{dossierId, runId}` on the thread record —
   only worth it if a node *upstream* of `resolve_parties` ever needs identity.
   Skip unless needed.
6. **R7 follow-up edit:** bind `runId: state.runId` into the `withFragment`
   child logger now that it exists in state.

**Acceptance.** `graph-resolver:smoke`, `qa:integration-smoke`,
`decision:smoke`, `screening-rekey:smoke` pass. Add one assertion to
`qa-integration-smoke`: the `runId` visible in `auto_finalize`'s fragment
equals the run row id.

**Rollback.** Behaviour-preserving refactor (helper is a superset of today's
logic); revert node edits — unused channels are inert.

---

## R4b — Apply-then-resume atomicity, residual slice (M → S/M after R2)

**Verified anchors.** `routes/decision.js:69-107`: apply → best-effort resume;
queue mode already dispatches a durable `run.resume` job when
`getThreadStreamState` says interrupted; inline mode resumes only if the
in-memory registry still has the thread. `awaitDecision.js` already writes no
fragment on resume and tolerates a terminal dossier (lines 40-67). Gaps:
(a) crash between `applyDecision` commit and enqueue/resume, (b) thread GC'd
in inline mode → resume silently skipped, (c) nothing drains the gap on boot
(worker `reconcile()` skips interrupted runs by design).

**Steps.**
1. **Migration `0023_resume_owed.sql`** + `db/schema.js`: add nullable
   `runs.resume_owed_at timestamptz`.
2. **`db/repo.js`:** `markResumeOwed(runId)` (accepts an optional drizzle `tx`
   so it can join the decision transaction), `clearResumeOwed(runId)`,
   `getRunsOwedResume()` (→ runs where `resume_owed_at IS NOT NULL AND
   status = 'running'`).
3. **`services/decision/index.js#applyDecision`:** inside the existing
   transaction, after the case-status flip + fragment insert, call
   `markResumeOwed(runId, tx)`. "Decision applied ⇒ resume owed" is now
   atomic.
4. **`routes/decision.js`:** after a *successful* dispatch
   (`dispatchResume` returned in inline mode; job enqueued in queue mode),
   call `clearResumeOwed(run.id)`. In queue mode it's also safe to clear at
   enqueue time — the pg-boss job is itself durable from that point.
   Belt-and-braces: `runGraph`'s clean terminus (in `sse/runtime.js#closeRun`
   path) also calls `clearResumeOwed` — covers the resume-crashed-mid-flight
   case.
5. **Boot reconciler — new `server/services/resumeReconciler.js`,** called
   from both `index.js` (inline mode) and `worker.js` (queue mode, after the
   existing `reconcile()`), behind `RESUME_RECONCILE` (default `on`):
   - For each `getRunsOwedResume()` row: re-read the latest `human_action`
     fragment for the run (it holds action/caseStatus/userId/fragmentId);
     rebuild the resume payload `{ decisionApplied: true, … }`.
   - If a LangGraph checkpoint exists for `thread_id` (probe via the compiled
     graph's `getState`), re-issue the resume through
     `runDispatch.executeRunJob`/`dispatchResume` (same path as live).
   - If the checkpoint is gone, `closeRun(runId, 'complete')` (the decision
     *did* land — closing is honest) + `clearResumeOwed`.
   - Never touches `case_status` — that transaction already committed.
6. **`awaitDecision.js` idempotency assert:** on resume, if the run row is
   already `status !== 'running'` (a replayed resume after a clean close),
   return only a trace line — no error append. One small guard at the top of
   the post-`interrupt()` section keyed on `resumePayload.fragmentId`.

**New smoke `scripts/decision-resume-recovery-smoke.js`** (+ npm script
`decision:recovery-smoke`): drive a run to `await_decision`, call
`applyDecision` directly (bypassing the route → simulates crash-before-resume),
assert `resume_owed_at` set + run `running`; invoke the reconciler; assert run
closed, `resume_owed_at` null, no duplicate `human_action` fragment.

**Acceptance.** New smoke green; `decision:smoke`, `qa:integration-smoke`,
`queue:smoke` unchanged.

**Rollback.** `RESUME_RECONCILE=off` disables the reconciler; the marker
column is inert without it. Migration is additive.

---

## R5 — Corroborated EXACT auto-link (M)

**Verified anchors.** The EXACT branch: `services/party/resolver.js:266-276`.
`buildOfficerParty`/`buildPscParty` already populate `dateOfBirthYear/Month`
+ `nationality[]` (lines 166-168, 185-187); the resolver already backfills DOB
onto existing parties on link (lines 314-315) — corroboration data improves
with every run. Shareholders carry neither → bare-name → review queue (the
intended safer outcome).

**Steps.**
1. **New `server/services/party/corroborate.js`** — pure, table-testable:
   ```js
   // corroborate(incoming, candidate) → { ok, reason, signalsUsed: [] }
   // - dob_year mismatch        → { ok: false, reason: 'dob_mismatch' }
   // - dob month mismatch (both years match, both months present) → same
   // - nationality arrays disjoint (both non-empty) → { ok: false, reason: 'nationality_disjoint' }
   // - ≥1 signal present-and-consistent → { ok: true, signalsUsed: ['dob_year', …] }
   // - no signal on either side → { ok: false, reason: 'no_corroborating_signal' }
   ```
   Nationality comparison is case-insensitive on the normalized strings
   `nationalityArray()` already produces.
2. **`resolver.js` EXACT branch (~L266):** when `top.confidence === 'EXACT'`
   **and** `partyData.partyType === 'individual'` **and**
   `PARTY_REQUIRE_CORROBORATION !== 'false'` (env, default on):
   - `const cand = await repo.findPartyById(top.partyId);`
     `const cor = corroborate(partyData, cand);`
   - `cor.ok` → existing auto-link path; extend `matchEvidence` with
     `corroboration: { ok: true, signalsUsed }`.
   - `!cor.ok` → **fall through to the existing HIGH/REVIEW branch** (new
     party + `outcome: 'new_party_queued'` + review-queue items), with
     `insertInput.reviewReason = 'EXACT name match demoted: <reason>'` and
     `matchEvidence.corroboration = { ok: false, reason }`.
   - Corporates: untouched (strong key = registration number runs first;
     name-EXACT stays auto-link).
3. **Counters:** in `resolveParties`' `result.counts` add
   `autoLinkedCorroborated` and `exactDemotedToReview`; increment in
   `consumeOutcome` from the evidence (`corroboration.ok` true/false on a
   `name_match` link / queued outcome). Surface both in the
   `resolve_parties` fragment summary.
4. **Docs:** note in `CLAUDE.md` Party Master section that EXACT auto-link is
   now corroboration-gated for individuals (`PARTY_REQUIRE_CORROBORATION`),
   and that historical dossiers may split parties on next run.

**New smoke `scripts/party-corroboration-smoke.js`** (+ npm script):
- Same name, different DOB year → 2 parties + 1 review item, no auto-link.
- Same name + same DOB year/month + overlapping nationality → 1 party.
- Same name, no DOB on either → new party + review item
  (`no_corroborating_signal`).
- Same name, corporate → still auto-links (control case).
- Flag off (`PARTY_REQUIRE_CORROBORATION=false`) → legacy behaviour (1 party).

**Acceptance.** New smoke + `party-resolver:smoke`, `graph-resolver:smoke`,
`screening:smoke`, `screening-rekey:smoke`. Watch the rekey smoke's party
counts — if its fixtures relied on bare-name EXACT merging, update the
fixture expectations (that's the intended posture change, not a regression).

**Rollback.** `PARTY_REQUIRE_CORROBORATION=false` restores today's behaviour
exactly.

---

## R6 — Per-field extraction confidence + abstention (M)

**Verified anchors.** `DocumentSchema` already carries `processedBy`
(`text`|`ocr`). Extractors live in `graph/extractors/{confirmationStatement,
accounts,incorporation}.js` as `{ schema, getPrompt(), ocrPolicy }`. Risk
already models honesty via `rationaleSource` — same pattern.

**Steps.**
1. **Schema additions (all optional → old data validates):**
   - Each extractor `schema`: per-record
     `confidence: z.enum(['high','medium','low']).optional()`.
   - `graph/state.js`: extend `KycShareholderSchema` (and the officer/financial
     shapes the card carries) with
     `provenance: z.enum(['api','text','ocr']).optional()` +
     `confidence: z.enum(['high','medium','low']).optional()`.
2. **Prompts via the registry (never in-place):** new versions of
   `extract.confirmation_statement`, `extract.accounts`,
   `extract.incorporation` adding the abstention instruction: *"If a value is
   not clearly legible in the source, omit it or set confidence to low — do
   not guess. confidence is your self-assessment and will be labelled as
   such."* Update `services/prompts.js` `DEFAULTS` (seeds fresh installs) and
   create new versions + `setActive` on the existing DB via the Settings page
   or a one-off script. **Before activating, run `npm run eval` against the
   golden corpus with the candidate via `npm run eval:ab` — R3 exists now;
   use it.**
3. **Provenance stamping:** in `processDocuments.js`, after a successful
   extraction, stamp `provenance: doc.processedBy` onto every extracted
   record. In `synthesizeCard.js`, the post-LLM "API is authoritative"
   override sets `provenance: 'api'` on API-sourced fields; preserve
   extraction-carried flags through the merge (the LLM may drop unknown keys —
   re-attach from the pre-merge records by matching on normalized name, the
   same way the override re-asserts API values).
4. **UI (`web/src/components/KycCard.vue`):**
   - Small muted badge per flagged record: "from OCR" (provenance `ocr`) and
     "low confidence" (confidence `low`), tooltip: "model-reported".
   - Card-level summary line: "N field(s) below high confidence".
   - Styles via `tokens.css` muted tokens; sentence case, no emoji.
5. **Hard rule:** risk/QA engines must **ignore** `confidence` — grep
   `services/risk/` + `services/qa/` after wiring to confirm nothing reads it.

**Acceptance.** New/extended smoke (`extraction-confidence-smoke` or extend
`llm:smoke`): a known low-text fixture yields records with
`provenance:'ocr'`; a doc-extracted shareholder absent from the API keeps its
flags through `synthesize_card`. Manual UI check. `npm run eval` shows no
extraction-score regression with the new prompts (that's the activation gate).

**Rollback.** All additive/optional; deactivate the new prompt versions via
the registry to restore old prompts instantly.

---

## X1 — Surface OCR truncation + page-relevance OCR (M)

**Verified anchors.** `processDocuments.js:7` `OCR_PAGE_CAP = 5`; line 80
silently clamps `pageLimit = min(pageCount, 5)`; `extractText` already
returns `pageCount` (line 71). `rasterizePages(path, pageLimit, scale)`
currently takes a *count*, not page indices — slice 2 needs an API extension.

**Slice 1 — surface truncation (S, ship first).**
1. `graph/state.js` `DocumentSchema`: add `truncated: z.boolean().optional()`,
   `pagesProcessed: z.number().optional()`, `pagesTotal: z.number().optional()`.
2. `processDocuments.js`: when `useOcr && pageCount > OCR_PAGE_CAP`, set
   `truncated: true, pagesProcessed: pageLimit, pagesTotal: pageCount` on the
   doc; emit a trace event; include the counts in the node fragment.
3. `synthesizeCard.js`: lift `truncated` docs into a red flag **distinct from
   the failed-doc flag**: `"OCR truncated: processed 5 of 52 pages of the
   confirmation statement — shareholder list may be incomplete."`
4. UI: `KycCard.vue` + `LiveEvidenceCard.vue` render the truncation notice
   prominently (warning banner on the evidence card, not buried in the
   red-flag list).
5. **New smoke `scripts/extraction-truncation-smoke.js`** with a >5-page
   fixture PDF: assert `truncated:true`, `pagesProcessed:5`, red flag present.

**Slice 2 — page-relevance selection (M).**
6. `services/pdf.js`: add `pageTextHints(pdfPath)` → per-page keyword score
   from the text layer (no LLM): keywords
   `['shareholder', 'subscriber', 'allotment', 'share capital', 'statement of capital', 'class of share']`,
   case-insensitive count per page.
7. `rasterizePages`: accept `pages: number[]` (1-based indices) as an
   alternative to the count form; keep the count form for callers that want
   first-N.
8. `processDocuments.js`: behind `OCR_PAGE_SELECTION=relevance|first`
   (default `relevance`): score pages, take top-`OCR_PAGE_CAP` by score
   (stable order), **fall back to first-N when all scores are 0** (scanned
   PDFs have no text layer). Record `pagesSelected: number[]` on the doc +
   fragment so a reviewer can see *which* pages were read. Apply relevance
   keywords per category (the list above for `confirmation-statement`;
   `['balance sheet','profit and loss','total assets','net assets']` for
   `accounts`; first-N is usually right for `incorporation`).
9. Extend the truncation smoke: a fixture with the shareholder table on page 7
   is captured under `relevance` and missed under `first`.

**Slice 3 — second-pass on disagreement: deferred**, but now *measurable* —
note in the smoke/README that the entry criterion is an eval-harness baseline
(`npm run eval`) showing extraction disagreement worth the second LLM pass.

**Acceptance.** New smoke green; `m2:smoke` / `llm:smoke` unchanged; OCR cache
behaviour unchanged for ≤5-page docs (cache key is file-hash based — page
*selection* changes which pages are OCR'd, and each page's OCR is keyed by its
own image hash, so no stale-cache hazard).

**Rollback.** Slice 1 additive. Slice 2: `OCR_PAGE_SELECTION=first` restores
today's behaviour.

---

## G1 — GDELT: party-level cache, then (maybe) async adverse media (M)

**Verified anchors.** `services/adverseMedia/cache.js` keys on
`sha256(name|isoWeek|max)`; `index.js#search(name, opts)` is the single entry;
`screenAdverseMedia.js:85` already has `subject.partyId` in hand. R7 added
`gdelt_request_total` — the before/after measurement for (b).

**Lever (b) — party-level cache (do first, cache-only).**
1. `cache.js`: add `buildPartyKey(partyId, opts)` =
   `sha256('party:' + partyId + '|' + week + '|' + max)`; export
   `getByParty/setByParty`. Keep the 7-day ISO-week TTL semantics —
   watchlisted parties still refresh weekly.
2. `index.js#search(name, opts)`: accept `opts.partyId`. Lookup order:
   party cache → name cache → GDELT. On a fetch, write **both** caches
   (party-keyed when partyId present; name-keyed always — preserves the
   legacy-subject path and cross-party same-name reuse).
3. `screenAdverseMedia.js`: pass `{ partyId: subject.partyId }` into
   `adverseMedia.search` (one-line change at the call on line 77).
4. **Measure:** extend `screening:smoke` (or a new
   `adverse-media-cache-smoke`) with two dossiers sharing one individual;
   assert run 2's GDELT fetch count for the shared party is 0
   (`gdelt_request_total` delta or a spy on `searchGdelt`). Serial 6 s
   spacing + 429 soft-skip untouched.

**Lever (c) — async/non-blocking adverse media: do NOT build yet.**
5. Prerequisite is a **product/compliance decision**, not code: *may a case
   auto-approve before adverse media returns, and re-open if serious media
   lands late?* Record the question in `SCREENING_PLAN.md` §open-questions.
   Only after it's answered "yes":
   - `graph/build.js`: move `screen_adverse_media → evaluate_adverse_media`
     to a trailing branch after `qa_narrative`'s routing fork; sanctions-only
     `compile_screening_report` feeds risk/QA.
   - `compileScreeningReport.js` + `assessRisk` + the QA recompute route gain
     a "report updated post-routing" path (re-derive overall risk; if it
     rises, flip a non-terminal dossier back to `standard_review` via the
     existing recompute machinery — never un-finalise, per case-lifecycle
     rules).
   - Gate the topology behind `ADVERSE_MEDIA_ASYNC=true` (default off).
   Scope as its own PR with its own plan section once the question is
   answered. Note: in queue mode (R2), `WORKER_CONCURRENCY=1` means the
   "async" branch still serialises behind the run — the win is *routing not
   waiting*, not parallel GDELT.
6. Lever (a) (second provider) stays optional/unscheduled; the `index.js`
   interface already accommodates it.

**Acceptance.** (b): smoke proves zero GDELT fetches for a party-cache hit;
existing `screening:smoke` green. (c): not built until the product question
is answered.

**Rollback.** (b) is cache-only — stop passing `partyId` and behaviour is
exactly today's. (c) flag-gated off by default.

---

## Roll-up

| Item | Effort | Migration | Env flags | New smokes | Key risk |
|------|--------|-----------|-----------|------------|----------|
| C1 | S | — | — | `parity` (umbrella) | none |
| R7 | M | — | `LOG_LEVEL`, `LOG_PRETTY` | manual `/api/metrics` check | metrics split across processes in queue mode (documented) |
| R4a | M | — | — | assertion added to `qa:integration-smoke` | none (refactor) |
| R4b | S/M | `0023_resume_owed` | `RESUME_RECONCILE` | `decision:recovery-smoke` | run-lifecycle touch; reconciler only closes/replays |
| R5 | M | — | `PARTY_REQUIRE_CORROBORATION` | `party-corroboration-smoke` | more review-queue volume; historical dossiers may split parties |
| R6 | M | — | — | `extraction-confidence-smoke` | prompt regression — gate activation on `npm run eval` |
| X1 | M | — | `OCR_PAGE_SELECTION` | `extraction-truncation-smoke` | slice 2 changes which pages are OCR'd; flag-gated |
| G1 | M | — | `ADVERSE_MEDIA_ASYNC` (c only) | adverse-media cache smoke | (c) is compliance-sensitive — blocked on product answer |

**Definition of done per item:** its smoke(s) green, the listed existing
smokes green, `npm run parity` green (C1 onward), CLAUDE.md updated where the
item changes a documented behaviour (R5, X1, G1, R4b), and prompt changes (R6)
A/B-scored via the eval harness before `setActive`.
