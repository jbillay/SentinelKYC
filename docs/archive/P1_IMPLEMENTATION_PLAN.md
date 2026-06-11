# P1 Implementation Plan

Detailed, build-ready plan for every **P1** item in `ARCHITECTURE.md` §16. P0s
(auth, job queue, eval harness) are explicitly out of scope here — several P1s
are easier once P0s land, and sequencing notes call that out where it matters.

Scope guard: this is still a POC (single user, local, no Docker). Each item is
sized to land **without** introducing production infra that the POC bans. Where
a "real" answer needs heavy infra, the plan picks the POC-appropriate slice and
marks the deferred remainder.

## The P1 set (from the shortlist + prose in §16)

| ID | Theme | What | Effort |
|----|-------|------|--------|
| **R4a** | Arch | Make run identity (`dossierId`/`runId`) a first-class state channel | M |
| **R4b** | Arch | Apply-then-resume atomicity: idempotent/retriable resume + boot reconcile | M |
| **R5** | KYC | Tighten EXACT-name auto-link with DOB/nationality corroboration | M |
| **R6** | AI | Per-field extraction confidence + abstention, surfaced to reviewer | M |
| **R7** | Prod | Structured logging + metrics + run-level tracing | M |
| **G1** | Perf | GDELT cost: party-level cache + async/non-blocking adverse media | M |
| **C1** | Docs | Config-drift CI guard (canonical twin + schema twins) | S |
| **X1** | AI | Extraction robustness: surface OCR truncation, page-relevance, 2nd pass | M |

Recommended build order (dependency-aware): **C1 → R7 → R4a → R4b → R5 → R6 → X1 → G1**.
C1 and R7 are low-risk foundations; R4a unblocks clean run-id usage that R4b/R7
both benefit from; R5/R6/X1 are independent KYC/AI quality items; G1 is the most
invasive (touches graph topology) so it goes last.

---

## C1 — Config-drift CI guard (S)

**Goal.** One script that fails loudly when any of the three known "physical
twin" pairs drift. Today only the decision schema is guarded
(`scripts/decision-schema-parity-smoke.js`); the SQL `name_canonical()` ↔ JS
`canonical.js` twin and the `partyMatchSchema` twin are unguarded.

**Why P1.** The CLAUDE.md "must stay in lock-step" invariants are enforced by
human memory. A canonical-function drift silently corrupts party dedup
(different canonicalisation → matcher misses → duplicate parties).

**Files.**
- `server/scripts/decision-schema-parity-smoke.js` — generalise / keep as-is.
- `server/scripts/config-parity-smoke.js` — **new** umbrella runner.
- `server/services/party/canonical.js` (JS twin) and the SQL
  `name_canonical()` body (in a migration under `server/db/migrations/`).
- `server/lib/partyMatchSchema.js` ↔ `web/src/lib/partyMatchSchema.js`.
- `server/package.json` — add `"parity": "node scripts/config-parity-smoke.js"`.

**Steps.**
1. **Canonical twin check.** Add a fixed table of ~30 adversarial input names
   (honorifics, punctuation, casing, unicode, suffixes like `LTD`/`LIMITED`,
   double spaces). For each, compute the JS `nameCanonical(x)` and the SQL
   `SELECT name_canonical($1)` via the `pg` pool, assert string-equal. This is
   the highest-value addition — it's a behavioural twin, not a text twin, so a
   table-driven differential test is the right tool. Pull the SQL function body
   from `information_schema`/`pg_proc` is not needed; just call the function.
2. **partyMatchSchema twin check.** Mirror the decision-schema approach: compare
   exported names + any `.min()`/enum members by regex over both files.
3. **Umbrella runner** invokes all three twin checks, sets `process.exitCode=1`
   on any failure, prints a single summary line.
4. Document in `CLAUDE.md` "Conventions" that `npm run parity` must pass before
   touching any twin. (No CI server exists in the POC — the "CI" here is the
   npm script run manually / in a future pre-commit hook. Note that explicitly
   so nobody hunts for a missing GitHub Action.)

**Testing.** Deliberately edit `canonical.js` to drop the honorific strip →
runner must fail on a honorific row. Revert.

**Risk/rollback.** None — pure addition, no runtime path touched.

---

## R7 — Structured logging + metrics + run-level tracing (M)

**Goal.** Replace ad-hoc `console.*` with a structured logger, attach a
`runId`/`threadId`/`nodeId` context to every line, and emit per-node + per-LLM
timing metrics. Make a stuck run observable without reading the SSE trace.

**Why P1.** Today the only window into a live run is the SSE stream; a hung
Ollama generation or a silent GDELT soft-skip is invisible post-hoc.

**Design decisions (POC-appropriate).**
- **Logger: `pino`** (already named in the doc). JSON to stdout; `pino-pretty`
  in dev via an env flag. No log shipping infra.
- **Metrics: in-process counters + a `/api/metrics` JSON endpoint** rather than
  Prometheus/OTel collectors (no Docker, no collector to run). Shape is
  Prometheus-compatible-ish so a later swap is mechanical.
- **Tracing: structured, not OTel.** Keep LangSmith as the documented no-op
  hook point. Per-node spans become structured log lines with `durationMs`
  (the `withFragment` wrapper already measures this — we just also log it).

**Files.**
- `server/services/log.js` — **new**. Exports `logger` (root pino) +
  `childLogger({ runId, threadId, nodeId })`.
- `server/services/metrics.js` — **new**. Counters/histograms:
  `run_duration_ms`, `node_latency_ms{node}`, `llm_latency_ms{task,provider}`,
  `gdelt_rate_limited_total`, `cache_hit_total{cache}` / `cache_miss_total`.
- `server/graph/fragments.js` — `withFragment` already times each node; add a
  `metrics.observe('node_latency_ms', durationMs, { node: nodeId })` +
  a structured log line on enter/exit/error. This is the single highest-leverage
  hook — every node flows through it.
- `server/services/llm/index.js` — wrap `ocrPage` / `extractStructured` with
  timing → `llm_latency_ms`; log cache hit/miss (the `cached` flag already
  exists in `ocrPage`).
- `server/services/adverseMedia/gdelt.js` — increment `gdelt_rate_limited_total`
  on the existing `GDELT_RATE_LIMITED` soft-skip path.
- `server/services/cache.js` — count `http_cache` / `kv_cache` hit/miss.
- `server/routes/meta.js` (or a new `routes/metrics.js`) — `GET /api/metrics`.
- `server/index.js` — install a pino HTTP request logger; replace boot
  `console.*` with `logger`.

**Steps.**
1. Add `pino` (+ `pino-http`, `pino-pretty` dev). Build `services/log.js` with a
   root logger reading `LOG_LEVEL` from `.env` (default `info`).
2. Build `services/metrics.js` — a tiny registry (Map of name → {type, values}).
   Histograms can be simple count/sum/min/max/p50-ish buckets; don't over-build.
3. Thread a child logger through `withFragment` — it has `nodeId` and can read
   `config.configurable.thread_id`. Once **R4a** lands, it also has `runId` from
   state, removing the DB lookup. (Order R7 before R4a is fine; R4a just makes
   the logger context richer.)
4. Instrument LLM + cache + GDELT as above.
5. Expose `GET /api/metrics`. Keep it unauthenticated for the POC but note it
   should sit behind the R1 auth tier later.
6. Sweep remaining `console.*` in `server/` to `logger.*` (keep `console` only
   in `scripts/*-smoke.js`).

**Testing.** `risk-engine-smoke`/`screening-smoke` still pass; hit `/api/metrics`
after a run and confirm `node_latency_ms` has one series per node and
`llm_latency_ms` is non-empty. Force a GDELT 429 (set a bogus
`GDELT_DOC_ENDPOINT`) → `gdelt_rate_limited_total` increments.

**Risk/rollback.** Logging swap is mechanical; the only behavioural risk is a
metrics endpoint leaking internal counts — acceptable for the POC, gated later.

---

## R4a — Run identity as a first-class state channel (M)

**Goal.** Set `dossierId`/`runId` into graph state **once**, early, so downstream
nodes (`resolve_parties`, `auto_finalize`, and anything new) read them from
state instead of re-querying Postgres by `thread_id`.

**Why P1.** The DB-by-`thread_id` recovery (seen in
`graph/nodes/resolveParties.js:197-205`) is load-bearing but implicit — a known
smell called out in CLAUDE.md "Conventions" and §16.4. It exists because
LangGraph snapshots `configurable` at stream start, so the SSE runtime's later
mutation of `configurable.dossierId` doesn't reach nodes.

**The wrinkle.** The dossier+run rows are created *lazily* by the SSE runtime on
the first chunk carrying `companyNumber` (`sse/runtime.js`), which is *after*
`gather_input`. So we cannot set `runId` in `gather_input` — the row doesn't
exist yet. Two viable placements:

- **Option A (recommended): set it in the SSE runtime at row-creation time** by
  writing into state via a graph update, OR have the first node that runs
  *after* lazy creation (`search_ch` / `entity_resolution`) read-through and
  populate the channel. Cleanest: when `runtime.js` lazily creates the
  dossier+run, stash `{dossierId, runId}` on the in-memory thread record, and
  add a tiny `hydrate_identity` step (or fold into `entity_resolution`) that
  copies them from the thread record into state.
- **Option B: keep the DB lookup but centralise it** in one helper
  `ensureRunIdentity(state, config)` that all nodes call, caching on `state`.
  Lower-risk, less pure, but removes the copy-paste.

Given POC risk tolerance, **do Option B first** (1 helper, mechanical, removes
duplication and is the 80% win), and leave Option A as a follow-up if the team
wants the channel to be truly authoritative.

**Files.**
- `server/graph/state.js` — add `dossierId: z.string().optional()` and
  `runId: z.string().optional()` channels (single-writer, no reducer).
- `server/graph/nodes/_identity.js` — **new** `ensureRunIdentity(state, config)`
  helper: returns `{ dossierId, runId }`, preferring `state` → `config` →
  DB-by-thread-id (the existing fallback logic, lifted verbatim from
  `resolveParties.js`).
- `server/graph/nodes/resolveParties.js`, `server/graph/nodes/autoFinalize.js`
  — replace inline recovery with the helper; return `{ dossierId, runId }` in
  the node's partial state so it's persisted into the channel on first use.
- Grep for other `getRunByThreadId` / `getRunByThread` callers in `graph/nodes`
  and migrate them.

**Steps.**
1. Add the two state channels.
2. Extract the recovery logic from `resolveParties.js:185-233` into
   `_identity.js` unchanged (it already handles config → thread → companyNumber).
3. Make the helper write-through: on first resolution, the node returns the ids
   in its partial state so later nodes hit the cheap `state` branch.
4. Migrate `auto_finalize` and any sibling.
5. (Optional Option A) Populate the channel at lazy-creation in `runtime.js`.

**Testing.** `graph-resolver-smoke`, `qa-integration-smoke`, `decision-smoke`
must pass. Add an assertion to `qa-integration-smoke` that the resolved `runId`
in `auto_finalize` equals the run row's id (guards the helper).

**Risk/rollback.** Behaviour-preserving refactor; the helper is a superset of
today's logic. Rollback = revert the node edits (channels are inert if unused).

---

## R4b — Apply-then-resume atomicity (M)

**Goal.** Make the `/decision` resume idempotent and retriable, and reconcile
stuck threads on boot, so a finalised dossier never strands a `running` thread.

**Why P1.** `routes/decision.js:66-88` commits the case-status flip in a
transaction, then **fire-and-forgets** a graph resume. If the process dies (or
the thread was GC'd) between commit and resume, the dossier is finalised but the
run thread stays open — only the 2h stale-run reaper eventually closes it, and
the `await_decision` node never emits its terminal trace.

**Design.** This is a saga: the DB txn is the source of truth; the resume is a
*compensable, replayable* projection. Two mechanisms:

1. **Idempotent resume.** The `await_decision` node, on resume, must tolerate
   "already applied": it currently writes no fragment on resume (the
   `human_action` row is canonical — good). Make the resume safe to run twice by
   keying any side effect on `result.fragmentId`. If the node is asked to resume
   with a `decisionApplied:true` payload whose fragment already closed the run,
   it should no-op to a clean terminus.
2. **Boot reconciler.** Extend the existing boot reaper in `sse/runtime.js`.
   Today it reaps stale `running` runs. Add: for each `running` run whose
   dossier `case_status` is **terminal** (`approved`/`rejected`/`escalated`/
   `info_requested`) or whose latest fragment is a `human_action`, attempt a
   resume from the LangGraph checkpointer (`compiledGraph` /
   `compiledScreeningOnlyGraph` keyed by `thread_id`) with the stored decision
   outcome; if the checkpoint is gone, close the run cleanly (`closeRun`) rather
   than leaving it `running`.

**Files.**
- `server/routes/decision.js` — keep apply-then-resume, but record a
  `resume_pending` marker (a column or a row) so the reconciler knows a resume
  is owed. Simplest: a nullable `runs.resume_owed_at timestamptz`.
- `server/db/migrations/00XX_resume_owed.sql` + `server/db/schema.js` — add the
  column.
- `server/db/repo.js` — `markResumeOwed(runId)`, `clearResumeOwed(runId)`,
  `getRunsOwedResume()`.
- `server/sse/runtime.js` — on a successful resume completion, `clearResumeOwed`;
  extend the boot reconciler to drain `getRunsOwedResume()`.
- `server/graph/nodes/awaitDecision.js` — assert idempotency on resume.

**Steps.**
1. Migration: add `runs.resume_owed_at`.
2. In `/decision`, inside the same flow: after `applyDecision` commits, call
   `markResumeOwed(runId)` (cheap, same connection if you fold it into the txn —
   preferred, so "decision applied ⇒ resume owed" is atomic). Then attempt the
   in-process resume; on the resume's clean terminus, `clearResumeOwed`.
3. Boot reconciler: `getRunsOwedResume()` → for each, if thread checkpoint
   exists, re-issue `Command({resume})` with the stored outcome (re-read from
   the `human_action` fragment); else `closeRun(..., 'cancelled'|'complete')`
   and `clearResumeOwed`.
4. Make `awaitDecision` resume a no-op-safe terminus.

**Testing.** New `scripts/decision-resume-recovery-smoke.js`: apply a decision,
**skip** the in-process resume (simulate crash), assert `resume_owed_at` set and
run still `running`; run the reconciler; assert run closed + `resume_owed_at`
cleared. Existing `decision-smoke` must still pass.

**Risk/rollback.** Medium — touches run lifecycle. Mitigation: the reconciler is
idempotent and only ever *closes* or *replays*, never re-flips case status (that
already committed). Feature-flag the reconciler via env if needed.

**Sequencing.** Lands cleaner after **R4a** (reconciler can read run identity
from state/checkpoint without bespoke lookups) but doesn't hard-depend on it.

---

## R5 — Tighten EXACT-name auto-link with corroboration (M)

**Goal.** Stop auto-linking two real humans who share a canonical name. Require a
corroborating identifier (DOB year/month and/or nationality) before an EXACT
name match auto-links an individual; route bare-name EXACT to the review queue.

**Why P1.** `resolver.js:266-276` auto-links on `confidence === 'EXACT'`
(sim 1.0) with no other signal — a documented KYC risk ("for the POC"). Identical
canonical names → one merged party → contaminated cross-dossier screening and a
wrong ownership graph. The data model already carries `dateOfBirthYear/Month`,
`nationality`, `countryOfResidence` on parties, so this is **resolver logic only**.

**Decision rule (new).** In `resolveSubject`, on the name-matcher EXACT branch,
**for individuals only**:
- Compute a corroboration check between the incoming `partyData` and the EXACT
  candidate party (re-fetched via `findPartyById`):
  - **DOB:** if both have `dateOfBirthYear`, they must match (and month if both
    present). A mismatch → **not** the same person → treat as REVIEW (new party
    + queue), regardless of name EXACT.
  - **Nationality:** if both have nationality arrays, require non-empty
    intersection; disjoint → REVIEW.
  - **Corroboration present + consistent** → auto-link (today's behaviour).
  - **No corroborating identifier on either side** (bare name) → **route to
    review queue** (create new party + enqueue), do *not* auto-link.
- **Corporates** keep EXACT auto-link (their strong key is the registration
  number; name EXACT for corporates is lower-risk and already gated by the
  strong-key path running first).

**Files.**
- `server/services/party/resolver.js` — the EXACT branch in `resolveSubject`
  (~L266) gains a `corroborate(partyData, candidateParty)` gate. `partyData`
  already carries DOB/nationality for officers/PSCs (see `buildOfficerParty` /
  `buildPscParty`). Shareholders carry no DOB → bare-name → review queue (a
  *good* outcome; doc-extracted shareholders shouldn't silently merge).
- `server/services/party/matcher.js` — no change to bands; corroboration is a
  resolver-layer gate on top of the EXACT band.
- New `server/services/party/corroborate.js` — pure
  `corroborate(incoming, candidate) → { ok, reason, signalsUsed[] }`.
- `match_evidence` payload — record `corroboration: {...}` so the audit trail
  shows *why* an EXACT name did or didn't auto-link.

**Steps.**
1. Write `corroborate.js` (pure, table-testable): DOB-year/month compare,
   nationality intersection, "no signal" detection.
2. In `resolveSubject`, when `top.confidence === 'EXACT'` and the subject is an
   individual, call `corroborate`. On `ok` → existing auto-link path (annotate
   evidence). On `!ok` → fall through to the existing HIGH/REVIEW branch
   (`outcome: 'new_party_queued'` + `needsReview`), with
   `reviewReason` explaining the corroboration failure.
3. Add counters to the `resolveParties` result: `autoLinkedCorroborated`,
   `exactDemotedToReview`.

**Testing.** New `scripts/party-corroboration-smoke.js`:
- Two officers, identical name, **different DOB year** → two parties, one review
  item; assert no auto-link.
- Same name + same DOB + overlapping nationality → single party (auto-link).
- Same name, **no DOB on either** → new party + review item.
Existing `party-resolver-smoke`, `graph-resolver-smoke`, `screening-smoke`,
`screening-rekey-smoke` must still pass (the rekey smoke asserts the
party→subject pivot; watch for changed party counts in fixtures).

**Risk/rollback.** Behavioural change to dedup → **more** parties + more review
queue volume. That's the intended safer posture, but it can surprise existing
dossiers on re-run. Mitigation: gate behind `PARTY_REQUIRE_CORROBORATION`
(default on) so it can be toggled; document that historical dossiers may split
parties on next run.

**Sequencing.** After **R4a** only incidentally (resolver already has
dossierId/runId). Independent of the rest.

---

## R6 — Per-field extraction confidence + abstention (M)

**Goal.** Stop presenting a hallucinated shareholder identically to a verified
one. Carry a confidence / provenance signal per extracted field (or at least
per extracted record + an explicit OCR-degraded flag) and surface low-confidence
fields in the reviewer UI.

**Why P1.** `extractStructured` returns a parsed object with no confidence
signal. The risk subsystem already models honesty (`rationaleSource: llm|template`)
— extend that pattern to extraction.

**Pragmatic scope (POC).** Full per-field model-confidence is hard with
`withStructuredOutput` (the model doesn't reliably self-report calibrated
probabilities). Do the **achievable, honest** version:
1. **Provenance flag per extracted record** — `processedBy` (`text` vs `ocr`)
   already exists on `DocumentSchema`. Propagate it onto each extracted entity so
   the card can mark "from OCR" vs "from text extract".
2. **Low-text / OCR-degraded flag** — already partially present; make it
   explicit and per-document, and bubble to the card as a field annotation.
3. **Optional model self-assessment** — extend extractor schemas with an
   optional `_confidence: z.enum(['high','medium','low']).optional()` per record
   and ask the prompt to abstain (omit a field / mark low) rather than guess.
   Treat this as advisory, clearly labelled "model-reported", not ground truth.

**Files.**
- `server/graph/extractors/{confirmationStatement,accounts,incorporation}.js` —
  add optional `confidence`/`provenance` fields to each `schema`; update
  `getPrompt()` to instruct abstention ("if a value is not legible, omit it or
  mark confidence low — do not guess").
- `server/graph/state.js` — extend `KycShareholderSchema` etc. with optional
  `provenance: z.enum(['api','text','ocr']).optional()` and
  `confidence: z.enum(['high','medium','low']).optional()`.
- `server/graph/nodes/processDocuments.js` — stamp `processedBy` onto each
  extracted record's `provenance`.
- `server/graph/nodes/synthesizeCard.js` — preserve the flags through the merge
  (the "API is authoritative" override sets `provenance:'api'`).
- `web/src/components/KycCard.vue` — render a small "low confidence" / "from OCR"
  affordance on flagged fields; `web/src/styles/tokens.css` for the muted style.
- `server/services/prompts.js` `DEFAULTS` — update the three `extract.*` prompts
  (new versions via the registry, not in-place, so it's auditable).

**Steps.**
1. Schema additions (extractors + state) — all optional, so old data validates.
2. Prompt updates with explicit abstention instruction; register as new prompt
   versions.
3. Stamp provenance in `processDocuments` / `synthesizeCard`.
4. UI: annotate low-confidence / OCR-sourced fields; add a card-level "N fields
   below high confidence" summary line.

**Testing.** Extend `llm-smoke` (or a new `extraction-confidence-smoke`) to run a
known low-text PDF fixture and assert records carry `provenance:'ocr'`. Manual UI
check that flags render.

**Risk/rollback.** Additive + optional fields → safe. The model self-confidence
is the weakest signal — keep it clearly labelled and don't let it drive any
deterministic routing (risk/QA engines must ignore it). Ties into the eval
harness (P0 R3): once that exists, calibrate whether `confidence:'low'` actually
correlates with errors.

---

## X1 — Extraction robustness: surface OCR truncation + smarter OCR (M)

**Goal.** A reviewer must be able to tell "shareholders were dropped" from
"shareholders were absent". Today the 5-page OCR cap (`OCR_PAGE_CAP` in
`processDocuments.js`) silently truncates 50+-page confirmation statements.

**Why P1.** Silent truncation is a correctness-of-omission bug in a KYC system —
the most dangerous kind, because the output looks complete.

**Scope (three slices, ship 1+2 first).**
1. **Surface truncation explicitly (must-have, S).** When a document has more
   pages than `OCR_PAGE_CAP`, add a red flag *and* a structured field:
   "OCR truncated: processed 5 of 52 pages — shareholder list may be
   incomplete." This is distinct from the existing failed-doc red flag.
2. **Page-relevance selection before OCR (M).** Instead of OCR-ing the first 5
   pages, score pages cheaply (text-layer keyword hits like "shareholder",
   "subscriber", "allotment", "capital") and OCR the **most relevant** 5. For a
   confirmation statement the shareholder table is often not on page 1.
3. **Second-pass on disagreement (deferred to post-eval-harness).** Re-extract
   when two passes disagree — only worth building once R3 can measure it.

**Files.**
- `server/graph/nodes/processDocuments.js` — `OCR_PAGE_CAP` logic; add truncation
  detection + the page-relevance scorer.
- `server/services/pdf.js` — `extractText`/`rasterizePages` already expose page
  text; add a `pageTextHints(pdfPath)` returning per-page keyword scores from
  the text layer (cheap, no LLM).
- `server/graph/state.js` `DocumentSchema` — add
  `truncated: z.boolean().optional()`, `pagesProcessed`, `pagesTotal`.
- `server/graph/nodes/synthesizeCard.js` — turn `truncated` into a red flag
  string (it already lifts failed docs to red flags).
- `web/src/components/KycCard.vue` / `LiveEvidenceCard.vue` — show the truncation
  notice prominently (not buried in red flags).

**Steps.**
1. **Slice 1:** detect `pagesTotal > OCR_PAGE_CAP`, set `truncated` + counts,
   emit the red flag, render it. Smallest correctness win — do first.
2. **Slice 2:** implement `pageTextHints`, pick top-N pages by score (fall back
   to first-N when the text layer is empty / scanned), feed those page indices to
   the rasteriser/OCR. Keep the cap at 5 but make *which* 5 smart.
3. Leave Slice 3 as a documented follow-up gated on the eval harness.

**Testing.** New `scripts/extraction-truncation-smoke.js` with a >5-page fixture:
assert `truncated:true`, `pagesProcessed:5`, red flag present. For Slice 2, a
fixture whose shareholder table is on page 7 should now be captured.

**Risk/rollback.** Slice 1 is safe (additive metadata + a red flag). Slice 2
changes *which* pages get OCR'd — guard behind `OCR_PAGE_SELECTION=relevance|first`
(default `relevance`, fall back to `first` if the scorer returns all-zero).

---

## G1 — GDELT cost: party-level cache + non-blocking adverse media (M)

**Goal.** Cut the dominant wall-clock cost (N individuals × ≥6 s serial GDELT)
without losing screening coverage.

**Why P1.** Per CLAUDE.md, adverse media is "the dominant wall-clock cost on
large boards." The current cache key is `name + ISO-week`; the serial 6 s
semaphore is unavoidable against a single free endpoint.

**Three levers from §16.2 (do (b) then (c); (a) is optional).**
- **(b) Party-level cache (M, do first).** Cache adverse-media results keyed on
  `partyId` (cross-dossier), not just `name+week`. Since `resolve_parties` runs
  before screening and stamps `subject.partyId`, the same John Smith across three
  dossiers reuses one GDELT fetch. This is the highest-leverage, lowest-risk win.
- **(c) Async / non-blocking (M).** Make adverse media a post-step that doesn't
  block case routing: sanctions (fast, local) + risk + QA proceed on the
  sanctions signal; adverse media completes asynchronously and *updates* the
  screening report + can re-route if it surfaces serious confirmed media. Bigger
  change — touches graph topology and the "deterministic risk rule" timing.
- **(a) Second provider (optional, S–M).** Add a second adverse-media source
  behind the `services/adverseMedia` interface to parallelise within rate limits.
  Lower priority; the interface already supports it.

**Files.**
- `server/services/adverseMedia/cache.js` — add a party-keyed cache layer
  (`partyId + ISO-week`) alongside the existing name-keyed one; party key wins
  when `partyId` is present.
- `server/services/adverseMedia/index.js` — accept `partyId` in the screen call;
  check party cache → name cache → GDELT.
- `server/graph/nodes/screening/screenAdverseMedia.js` — pass `subject.partyId`
  through (subjects are already party-keyed when the resolver ran).
- **(c) only:** `server/graph/build.js` — restructure so adverse media is a
  trailing branch; `server/graph/nodes/screening/compileScreeningReport.js` and
  `assessRisk` — support a "report updated after risk" path (re-derive overall
  risk + flag a re-route when serious confirmed media lands late). This is the
  invasive part — scope it as a **second PR** after (b) ships and is measured.

**Steps.**
1. **(b)** Add party-level cache + plumb `partyId`. Ship + measure GDELT call
   reduction across a multi-dossier fixture (expect a big drop on shared
   individuals).
2. **(c)** Only if (b) isn't enough: design the async post-step. Decide the
   product question first — *may a case auto-approve before adverse media
   returns, then re-open if media is serious?* That's a routing/compliance
   decision (note it in `SCREENING_PLAN.md` and surface to the architect
   session's open question #2). Do not build (c) until that's answered.

**Testing.** Extend `screening-smoke` with two dossiers sharing an individual;
assert the second run's adverse-media GDELT fetch count is 0 (party cache hit).
The existing 6 s serial spacing + 429 soft-skip behaviour must be unchanged.

**Risk/rollback.** (b) is cache-only → safe, rollback = ignore `partyId`. (c)
changes when routing sees the adverse-media signal — **compliance-sensitive**;
gate behind a flag and the answered product question. Party-cache staleness:
keep the 7-day ISO-week TTL so a watchlisted party still re-fetches weekly.

---

## Cross-cutting notes

- **No new infra that the POC bans.** No Docker, no external collectors, no
  message broker. Metrics is an in-process endpoint; "CI" is an npm script;
  the job-queue answer to run durability is P0 R2, deliberately not here.
- **Prompt changes go through the registry.** R6 and X1 touch `extract.*` /
  `ocr.page` — create new prompt versions via `services/prompts.js`, never
  hard-code (CLAUDE.md convention).
- **Twins stay in lock-step.** R6's state-schema additions don't have twins, but
  if any decision/match schema changes, **C1's `npm run parity` must pass** — so
  land C1 first.
- **Migrations.** Only R4b (`runs.resume_owed_at`) needs a new migration
  (`00XX`, next after 0019). Everything else is code/prompt/UI.
- **Eval-harness dependency.** R6's model-confidence calibration and X1's
  second-pass slice are only *verifiable* once P0 R3 (eval harness) exists —
  build the honest/structural parts now, defer the parts that need measurement.

## Effort roll-up

| Item | Effort | New migration | Compliance-sensitive | Gated by P0 |
|------|--------|---------------|----------------------|-------------|
| C1 | S | no | no | no |
| R7 | M | no | no | no |
| R4a | M | no | no | no |
| R4b | M | yes | no | no |
| R5 | M | no | yes (dedup posture) | no |
| R6 | M | no | no | calibration → R3 |
| X1 | M | no | yes (omission) | 2nd-pass → R3 |
| G1 | M | no | yes (routing timing) | no |
