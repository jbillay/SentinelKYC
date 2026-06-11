# Screening Agent — detailed plan (locked-in)

This is the source-of-truth design doc for the screening phase, agreed on 2026-05-03. Any change to scope or shape goes here first, then propagates to `IMPLEMENTATION.md` (tasks) and `CLAUDE.md` (architecture).

Out-of-scope items in §11 are deferred to v2.

---

## 1. Architecture summary

- **Sub-graph inside the main graph**, runs after `synthesize_card`, blocks `done`.
- **Two parallel screening branches** for POC (sanctions + adverse media; PEP deferred). Each branch is a `screen_*` node followed by an `evaluate_*` node, joining at `compile_screening_report`.
- **Refresh re-runs screening** end-to-end. New `POST /api/dossiers/:cn/rescreen` triggers screening only — replays `profile/officers/psc/documents` from the most recent successful run, jumps directly to `compile_screening_list`. Implemented as a second compiled graph (`screeningOnlyGraph`) that takes those four state fields as input and skips the CH/doc phase.
- **Sanctions sources**: OFAC SDN + UK HMT, locally cached in Postgres. Refreshed via CLI, never on the run path.
- **Adverse media**: live GDELT 2.0 DOC API news search per individual subject (free, no API key — replaced the retired Bing News API). Cached in `kv_cache` keyed by `name + ISO-week` so re-runs within a week are free.
- **Human overrides**: per-run, with a "carry forward" toggle on refresh / rescreen.
- **PEP screening**: out of scope (no free authoritative data source). Provider interface designed so it can be wired in later behind the same shape as sanctions.

Graph shape:

```
… → synthesize_card
       → compile_screening_list
            ┌─→ screen_sanctions     → evaluate_sanctions_hits ─┐
            └─→ screen_adverse_media → evaluate_adverse_media   ┘
                                                                → compile_screening_report → END
```

---

## 2. Data model

### 2.1 New Postgres tables (migration `0003_screening.sql`)

```
sanctions_lists
  id              uuid pk
  source          text not null         -- 'ofac_sdn' | 'uk_hmt'
  version         text not null         -- source-provided version or fetched_at ISO
  fetched_at      timestamptz not null
  record_count    int not null
  unique (source, version)

sanctions_entries
  id              uuid pk
  list_source     text not null         -- 'ofac_sdn' | 'uk_hmt'
  list_entry_id   text not null         -- the source's own id (SDN_uid, HMT group_id)
  entry_type      text not null         -- 'individual' | 'entity' | 'unknown'
  primary_name    text not null
  normalized_name text not null         -- uppercase, ASCII-folded, punctuation-stripped
  aliases         jsonb not null default '[]'::jsonb
                                         -- [{ name, normalized, type? }]
  dob             text                  -- ISO or partial 'YYYY' / 'YYYY-MM' if available
  nationality     text[]
  identifiers     jsonb                 -- passport, national id, registration number, etc
  programs        text[]                -- sanction programs (SDGT, IRAN-EO13599, etc)
  raw             jsonb not null        -- original record for the audit trail
  created_at      timestamptz default now()
  unique (list_source, list_entry_id)

  index on (list_source)
  index on (normalized_name)
  gin index on aliases jsonb_path_ops

screening_hits
  id                  uuid pk
  run_id              uuid not null references runs(id) on delete cascade
  subject_id          text not null         -- e.g. 'psc:JOHN-SMITH'; stable within the run
  subject_name        text not null
  subject_kind        text not null         -- 'company' | 'individual' | 'corporate'
  subject_source      text not null         -- 'profile' | 'officer' | 'psc' | 'shareholder'
  list_source         text not null         -- 'ofac_sdn' | 'uk_hmt' | 'adverse_media'
  list_entry_id       text                  -- null for adverse_media
  match_score         numeric(4,3)          -- 0..1 (sanctions); LLM severity for adverse media
  matched_fields      jsonb                 -- { name, alias, dob, nationality, ... }
  raw_entry           jsonb not null
  created_at          timestamptz default now()

  index on (run_id)
  index on (run_id, subject_id)

screening_evaluations
  id                uuid pk
  hit_id            uuid not null references screening_hits(id) on delete cascade
  decision          text not null            -- 'confirmed' | 'dismissed' | 'needs_review'
  category          text                     -- adverse media only
  llm_reasoning     text not null
  llm_score         numeric(4,3)
  fragment_id       uuid                     -- decision fragment that captured this evaluation
  human_override    text                     -- null | 'confirmed' | 'dismissed'
  override_reason   text
  override_at       timestamptz
  created_at        timestamptz default now()
  updated_at        timestamptz default now()

  unique (hit_id)
  index on (hit_id)

dossier_screening_overrides
  id                uuid pk
  dossier_id        uuid not null references dossiers(id) on delete cascade
  subject_id        text not null
  list_source       text not null
  list_entry_id     text                     -- null for adverse_media; uses `evidence_url` instead
  evidence_url      text                     -- adverse media identity (canonical url)
  decision          text not null            -- 'confirmed' | 'dismissed'
  reason            text
  created_at        timestamptz default now()
  updated_at        timestamptz default now()
  unique (dossier_id, subject_id, list_source, list_entry_id, evidence_url)
```

### 2.2 `decision_fragments` — one new column

```
parent_fragment_id uuid references decision_fragments(id) on delete cascade
```

Drives nested rendering of per-hit evaluations under their parent `evaluate_*` fragment in `AgentTrail.vue`. Backwards-compatible (nullable).

### 2.3 `runs` — one new column

```
final_screening_report jsonb
```

So a frozen run renders its screening tab without joining `screening_hits`.

### 2.4 Singleton config table (migration `0004_screening_config.sql`)

```
screening_config
  id                       int primary key default 1 check (id = 1)
  match_threshold          numeric(4,3) not null default 0.85
  bing_results_per_subject int not null default 20
  updated_at               timestamptz not null default now()
```

### 2.5 LangGraph state additions (`server/graph/state.js`)

```js
screeningSubjects: z.array(SubjectSchema).default(() => [])
screeningHits: z.array(HitSchema).default(() => []) // concat-reducer
screeningEvaluations: z.array(EvaluationSchema).default(() => []) // concat-reducer
screeningReport: ScreeningReportSchema.optional()
```

Concat reducers on the two arrays so the parallel branches merge cleanly.

---

## 3. Sanctions list ingestion — offline-only

### 3.1 New module `server/services/sanctions/`

```
sanctions/
  index.js               refresh(source?), search(normalizedName, opts), getEntry(id)
  sources/
    ofac.js              download SDN_ENHANCED.XML, parse, yield entries
    uk_hmt.js            download HMT consolidated CSV, parse, yield entries
  parsers/
    ofac_xml.js          streaming parser (file is ~40MB)
    uk_hmt_csv.js        CSV parser
  normalize.js           normalizeName(s), foldDiacritics, expandCorpAbbrev
  matcher.js             tokenSetRatio + doubleMetaphone + score combiner
  store.js               drizzle queries — upsert lists/entries, search by normalized_name
```

`normalize.js`: uppercase → strip punctuation → fold Latin diacritics → collapse whitespace → token sort. Corp abbreviations expanded per a small lookup (LTD↔LIMITED, CO↔COMPANY, &↔AND, INC↔INCORPORATED).

`matcher.js`: per candidate vs. every entry alias:

1. `tokenSetRatio(normalizedSubject, normalizedEntry)` via `fastest-levenshtein`.
2. Phonetic fallback: if token-set < threshold, compute Double Metaphone codes and bump the score by a small constant if codes match.
3. Take the **max score across all aliases**.
4. Filter at threshold (default 0.85, single global value from `screening_config.match_threshold`).

### 3.2 Refresh CLI

`npm run lists:refresh` → `server/scripts/refresh-sanctions.js`:

- Downloads OFAC SDN enhanced XML + UK HMT consolidated CSV.
- Streams parse → upserts into `sanctions_entries` keyed on `(list_source, list_entry_id)`.
- Inserts a new `sanctions_lists` version row.
- Logs `n inserted, m updated, k unchanged` per source.
- Idempotent. No side effects during a run.

`server/db/SETUP.md` updated to require this once after `db:migrate`.

---

## 4. Adverse media — live GDELT news search with caching

> v1 originally used the Bing News Search v7 API; Microsoft retired it, so the
> provider is now the **GDELT 2.0 DOC API** (free, no API key). The provider
> interface (`adverseMedia.search`) is unchanged — only the implementation file
> swapped (`bing.js` → `gdelt.js`).

### 4.1 Provider interface (`server/services/adverseMedia/`)

```
adverseMedia/
  index.js          search(name, opts) → [{ title, snippet, url, publishedAt, source }]
  gdelt.js          GDELT 2.0 DOC API implementation (mode=ArtList&format=json)
  cache.js          kvGet/kvSet wrapper, key = sha256(name|isoWeek)
```

- **Env**: none required — GDELT is free and keyless. Optional overrides: `GDELT_DOC_ENDPOINT` (default `https://api.gdeltproject.org/api/v2/doc/doc`), `GDELT_TIMESPAN` (default `12m`).
- **Query template**: `"<name>" ("money laundering" OR sanction OR sanctions OR fraud OR corruption OR bribery OR embezzlement OR investigation OR indicted OR convicted OR fined OR "regulatory action")`, sorted most-recent-first over the rolling timespan.
- **Result shape note**: GDELT ArtList returns **headlines only — no `snippet`** (always `''`). The `screening.evaluate_adverse_media` prompt judges from title + source domain + date.
- **Cache**: keyed on `name + ISO-week`, 7-day TTL. Re-runs within a week are free.
- **Pagination**: top 20 results (clamped to GDELT's 250 max).
- **Rate limiting**: in-process semaphore, strictly serial (1 concurrent), 5s spacing — GDELT's public limit is one request / 5s (HTTP 429 otherwise); the per-subject error handling in `screen_adverse_media` absorbs the occasional 429.
- **Scope**: only **individuals** (officers, PSCs, individual shareholders) screened in v1. Companies generate too-noisy results without entity disambiguation.

---

## 5. Graph nodes

All wrapped in `withFragment`. New file per node under `server/graph/nodes/screening/`.

### 5.1 `compile_screening_list` (deterministic, no LLM)

**Input** (read from state): `profile`, `officers.items`, `psc.items`, `documents` (extracted shareholders).

**Logic**:
- Subject for the company itself (`kind: 'company'`, `source: 'profile'`).
- One per officer (`kind: 'individual'`, `source: 'officer'`, dob month+year if present, nationality if present).
- One per PSC (`kind` mapped from `psc.kind`).
- One per extracted shareholder not covered by a PSC (deduplicated by normalized name).

**Subject id**: `${source}:${normalizedName}` — stable within a run.

**Fragment**: `summary: "Compiled N subjects (1 company, K officers, M PSCs, L shareholders)"`, full subject list in `outputs`.

### 5.2 `screen_sanctions` (deterministic; parallel inside)

For each subject × `(ofac_sdn, uk_hmt)`:
- Pre-filter candidate set by first token of normalized name (Postgres trigram or `LIKE` prefix), then run full matcher.
- Emit hit row for every entry where score ≥ threshold.

**Fragment** (audit, single): `summary: "Screened N subjects against 2 lists — H potential hits"`.

### 5.3 `evaluate_sanctions_hits` (LLM, nested fragments)

**Parent fragment** (decision): created upfront. Children's `parent_fragment_id` = this id.

**Per hit**: `extractStructured(input, EvalSchema, prompt('screening.evaluate_sanctions_hit'))`:

```
EvalSchema = {
  decision: 'confirmed' | 'dismissed' | 'needs_review',
  llmScore: number 0..1,
  reasoning: string,        // 1–3 sentences, references matched/conflicting fields
  matchedFields: string[],
  conflictingFields: string[]
}
```

Inputs to LLM: subject name + dob (month/year) + nationality (if any) + entry's primary_name + aliases + dob + nationalities + programs + identifiers. The prompt explicitly biases toward `needs_review` when identifiers absent.

Persist `screening_evaluations` row + child fragment with `kind: 'decision'`, `parent_fragment_id` set.

### 5.4 `screen_adverse_media` (live, parallel over individual subjects)

Per individual (semaphore 3):
- `adverseMedia.search(name)`.
- Convert each top-N result to a hit row with `list_source: 'adverse_media'`, `match_score: null` (set by LLM later), `raw_entry: { title, snippet, url, publishedAt, source }`.

**Fragment** (audit): timing, total articles fetched, cache hits.

### 5.5 `evaluate_adverse_media` (LLM, nested)

Per hit: `extractStructured` with `screening.evaluate_adverse_media`:

```
{
  decision: 'confirmed' | 'dismissed' | 'needs_review',
  category: 'financial_crime' | 'fraud' | 'corruption' | 'tax_evasion'
          | 'regulatory_action' | 'litigation' | 'other',
  severity: 'low' | 'medium' | 'high',
  llmScore: number 0..1,
  reasoning: string
}
```

Inputs: subject name + role + headline + snippet + URL host. Prompt biases toward `dismissed` for clearly-different-named-entity / wrong-context articles.

### 5.6 `compile_screening_report`

**Output** (`screeningReport`):

```
{
  summary: {
    subjectCount: n,
    confirmedHits: n,
    needsReview: n,
    dismissedHits: n,
    overallRisk: 'low' | 'medium' | 'high'
  },
  perSubject: [
    {
      subjectId, name, kind, source,
      hits: { sanctions: { confirmed, needsReview, dismissed }, adverseMedia: {...} },
      worstStatus: 'confirmed' | 'needs_review' | 'dismissed' | 'clean'
    }
  ],
  byList: { ofac_sdn: {...}, uk_hmt: {...}, adverse_media: {...} }
}
```

**Risk rule** (deterministic):
- Any confirmed sanctions hit → `high`.
- Any confirmed adverse-media hit (financial_crime / corruption / fraud / money laundering at severity ≥ medium) OR any sanctions hit at `needs_review` → `medium`.
- Otherwise → `low`.

Persists `runs.final_screening_report`. Single decision fragment summarising the report.

---

## 6. Prompts (registered in `services/prompts.js`)

New keys:

- `screening.evaluate_sanctions_hit` — weighs name similarity, dob (partial OK), nationality, identifiers; prefer `needs_review` when identifiers absent.
- `screening.evaluate_adverse_media` — relevance + category + severity; explicit "dismiss if obviously different person/context" guidance.

Skipped: `screening.compile_report_summary` (deterministic risk rule is enough for v1).

---

## 7. HTTP API additions

- `POST /api/dossiers/:cn/rescreen` → new thread, replays prior run's `profile/officers/psc/documents`, jumps directly to `compile_screening_list` (uses `screeningOnlyGraph`).
- `GET /api/dossiers/:cn/runs/:runId/screening` → full screening detail (hits + evaluations) for the run.
- `PATCH /api/dossiers/:cn/runs/:runId/hits/:hitId` → set `human_override` (`confirmed` | `dismissed` | `null`) + optional `override_reason`. Re-derives report's `summary`. Re-emits via SSE if thread is live.
- `POST /api/dossiers/:cn/runs/:runId/carry-overrides-forward` → copy current run's overrides into `dossier_screening_overrides`. Applied at evaluate time on subsequent runs.
- `GET /api/screening/lists` → `[{ source, version, fetched_at, record_count }]` for Settings.
- `POST /api/screening/lists/refresh` → triggers same path as CLI, async with progress over a separate SSE channel. Optional for v1 (CLI is enough).

New SSE event types during a screening run:
- `screening_subject_started` — subject id + currently-screening list.
- `screening_hit` — hit found (pre-evaluation).
- `screening_hit_evaluated` — decision + reasoning.

---

## 8. UI

### 8.1 Live evidence card (`web/src/components/ScreeningEvidenceCard.vue`)

Rendered on `RunPage.vue` once the thread enters the screening phase. Pinia slice extends `agent.js` with a `screening` substate consuming the new SSE events.

- **Header**: "Screening — N subjects identified".
- **Per-list progress bars**: OFAC SDN, UK HMT, Adverse Media. Bar = subjects evaluated / total.
- **Live counters**: confirmed / needs review / dismissed (single-row chips).
- **Currently evaluating**: subject + list. Updated on `screening_subject_started`.
- **Recent hits feed**: last 5 hits with subject, list, score, decision (or "evaluating…"). Auto-scrolling.

Visual language consistent with existing `LiveEvidenceCard.vue`.

### 8.2 Dossier Screening tab (`DossierViewPage.vue`)

Tab order: **Card · Graph · Documents · Screening**.

- **Top strip**: overall risk pill, totals, last screened at, rescreen button.
- **Filters**: hit status (default = confirmed + needs_review), list source, subject role.
- **Subject rows** — name + role + hit summary chips. Click to expand.
- **Expanded panel** — per-hit cards:
  - List + match score + `matched_fields` chips.
  - LLM reasoning (collapsed to 2 lines).
  - For adverse media: title + snippet + category + severity + outbound link.
  - Status pill (`confirmed` / `needs_review` / `dismissed`) with "human override" badge if overridden.
  - Action buttons: Confirm as true / Dismiss as false / Clear override. Modal for `override_reason`.

Dismissed hits hidden by default; toggle "Show dismissed" reveals them.

### 8.3 `RunDetailPage.vue` — frozen Screening tab

Read-only version of the same panel, from `runs.final_screening_report`. Override actions disabled.

### 8.4 Settings page

New section: **Screening sources**.
- Per source: name, version, fetched_at, record_count, "Refresh now" button.
- Editable: match threshold (default 0.85), news results per subject (default 20).
- Adverse-media provider note: GDELT 2.0 DOC API — free, no API key (optional `GDELT_*` overrides in `.env`).

### 8.5 Run-diff page

Screening **not** included in v1. Deferred to v2.

---

## 9. Files added / changed

```
server/
  db/
    migrations/
      0003_screening.sql
      0004_screening_config.sql
    schema.js                         + new Drizzle definitions
    repo.js                           + screening reads/writes, override helpers
  graph/
    state.js                          + Subject/Hit/Evaluation/Report schemas + concat reducers
    build.js                          + screening sub-graph; compile screeningOnlyGraph
    nodes/screening/
      compileScreeningList.js
      screenSanctions.js
      evaluateSanctionsHits.js
      screenAdverseMedia.js
      evaluateAdverseMedia.js
      compileScreeningReport.js
  services/
    sanctions/{index,normalize,matcher,store}.js + sources/* + parsers/*
    adverseMedia/{index,gdelt,cache}.js
    prompts.js                        + 2 new prompt keys
  scripts/
    refresh-sanctions.js
    screening-smoke.js
  index.js                            + 4–5 new endpoints; emit screening SSE events
  package.json                        + fastest-levenshtein, double-metaphone,
                                       fast-xml-parser, papaparse

web/
  src/
    pages/{DossierViewPage,RunDetailPage,RunPage,SettingsPage}.vue   updates
    components/{ScreeningEvidenceCard,ScreeningTab,ScreeningHitPanel}.vue   new
    components/AgentTrail.vue                                        + nested rendering
    composables/useScreening.js                                      new
    stores/agent.js                                                  + screening substate

CLAUDE.md   + Screening section
```

Total new server files: ~22. New web files: ~4. Migrations: 2.

---

## 10. Milestones (5 PRs against the same branch)

1. **M1 — Data foundation** (1–2 days): migrations, Drizzle schema, repo helpers, `screening_config`, refresh-sanctions CLI, OFAC + HMT parsers, `sanctions_entries` populated and queryable. Smoke script proves search works.
2. **M2 — Screening graph (sanctions only, no LLM)** (1 day): state additions, `compile_screening_list`, `screen_sanctions`, hits persisted, no evaluation yet. Run shows "N hits, awaiting evaluation."
3. **M3 — LLM evaluation + nested fragments** (1–2 days): `evaluate_sanctions_hits`, prompt registered, `parent_fragment_id` plumbing, `AgentTrail` nested rendering. Decision fragments visible in trail.
4. **M4 — Adverse media branch + parallelism** (1–2 days): adverse-media news provider (Bing originally; now GDELT), `screen_adverse_media`, `evaluate_adverse_media`, `compile_screening_report`, parallel branches in graph, risk rule, `final_screening_report` persisted.
5. **M5 — UI** (2 days): `ScreeningEvidenceCard`, Screening tab on dossier + run detail, override flow, rescreen endpoint, Settings page section.

Total: ~7–9 dev days for v1.

---

## 11. Out of scope for v1 (deferred to v2)

- Recursive ownership-chain walking (PSC corporate → CH search → screen → repeat).
- Authorized signatories.
- PEP screening (no chosen data source).
- Historical sanctions-list versioning / re-screen-as-of-date.
- Vector-similarity name matching.
- Real Dow Jones / WorldCheck PEP feeds.
- Multilingual name matching beyond Latin transliteration.
- Screening into the run-diff view.
- Alias generation by LLM.
- **Async / non-blocking adverse media (P1 G1 lever c)** — making adverse media
  a trailing branch so sanctions + risk + QA route the case without waiting on
  GDELT, with a post-hoc report update + re-route when serious confirmed media
  lands late. **Blocked on a product/compliance decision, not code**: *may a
  case auto-approve before adverse media returns, and be re-opened if serious
  media surfaces afterwards?* Do not build until that is answered "yes"
  (gate behind `ADVERSE_MEDIA_ASYNC`, default off). Note: in queue mode
  (`WORKER_CONCURRENCY=1`) the win is *routing not waiting*, not parallel
  GDELT. The shipped G1 mitigation is the party-level adverse-media cache
  (`services/adverseMedia/cache.js#buildPartyKey`) — a shared individual costs
  one GDELT fetch per ISO week across all dossiers.

---

## 12. Locked-in assumptions

- **OFAC SDN format**: `SDN_ENHANCED.XML` (~40MB), aliases as structured records.
- **HMT format**: consolidated CSV.
- **Levenshtein library**: `fastest-levenshtein` (pure JS, MIT, zero deps).
- **Phonetic library**: `double-metaphone` (small, MIT).
- **Adverse-media news API**: GDELT 2.0 DOC API (`mode=ArtList&format=json`) — free, no API key. (Originally Bing News Search v7; retired by Microsoft.)
- **`screening_config` is a singleton**: one row, `CHECK (id = 1)`.
- **Fragment count blast radius**: worst-case ~200 child fragments per run. AgentTrail virtualises the nested list when count crosses ~50 (added in M3).
- **Sanctions sources never OCR'd** — they ship structured.
- **Match threshold scope**: one global default (`screening_config.match_threshold`).
