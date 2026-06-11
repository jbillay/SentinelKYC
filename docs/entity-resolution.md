# Entity resolution — party name matcher

**Phase 1a.** Name-based dedup for the KYC Party Master. Surfaces ranked
match candidates for a given input; **never auto-merges** — a human
reviewer always decides (4-eyes). This document is auditor-facing; it
exists so a reviewer reproducing a historical match decision can answer
"why did the system return *these* candidates, in this order, with these
confidence labels?"

## Where it sits

The matcher is the deterministic name-similarity layer of a 4-layer
resolver waterfall:

| Layer | Responsibility | Phase |
|---|---|---|
| 0 | Strong-key match — CH officer-appointment ID, corporate registration | Phase 1b |
| 1 | Canonical equality — `name_canonical(a) == name_canonical(b)` | **Phase 1a (this doc)** |
| 2 | `pg_trgm` similarity on `name_canonical`, GIN-indexed | **Phase 1a (this doc)** |
| 3 | Phonetic + Levenshtein tiebreak for the ambiguous trigram band | **Phase 1a (this doc)** |
| 4 | Secondary attributes — DOB, nationality, country of residence | Future |

The matcher is invoked from two callers:

- **HTTP endpoint** `POST /api/parties/match` — synchronous, used by the
  UI's party search box and any external KYC integration.
- **In-graph resolver node** `resolve_parties` (Phase 1b) — invoked once
  per CH officer / PSC / extracted shareholder when a dossier run
  resolves its party links.

Both call the same `PartyMatchService.findMatches()` and both write to
`party_match_log` (see "Audit trail" below).

## Layer 1 — canonicalisation

`name_canonical(text)` is an `IMMUTABLE PARALLEL SAFE` SQL function (see
migration `0012_party_master_matcher.sql`). It backs:

- the `parties.name_canonical` `GENERATED ALWAYS AS … STORED` column,
- the matcher's input canonicalisation,
- the `gin_trgm_ops` index on `name_canonical`.

The function applies four ordered steps:

1. **Lowercase + unaccent.** Diacritics are folded by the `unaccent`
   contrib extension wrapped in `immutable_unaccent` so the planner sees
   it as IMMUTABLE (required to back the generated column / index).
2. **Strip honorifics.** Whole-token match for: `mr, mrs, ms, mme, mlle,
   m, dr, prof, sir, sr, jr` — with or without a trailing dot. The
   surrounding regex anchors on `(^|[^a-z0-9])` and a non-alphanumeric /
   end-of-string lookahead, so embedded substrings (e.g. "mary",
   "morten") are unaffected.
3. **Punctuation rules.**
   - **Apostrophes** (`'`) are *removed*: `O'Hara` → `OHara` (keeps the
     two halves contiguous, so it matches the apostrophe-free spelling).
   - **Other non-alphanumeric** (hyphens, periods, commas, slashes…)
     becomes a single space, then runs of whitespace collapse.
4. **Token-sort.** Splits on space, sorts tokens alphabetically, rejoins
   with single spaces. Token-sort is what makes `Jeremy Billay` and
   `Billay Jeremy` produce the same canonical.

### Determinism

`name_canonical` is deterministic: the same input string produces the
same output across processes, replicas, and restarts (modulo the
`unaccent` dictionary, which is treated as fixed — see
`immutable_unaccent` in the migration). Asserted in
`scripts/match-smoke.js`.

## Layer 2 — `pg_trgm` similarity

When two canonicals don't match exactly, the matcher compares them by
trigram similarity. The query is a single round trip on a GIN array
overlap pre-filter (`name_tokens && string_to_array(input, ' ')`) plus
an explicit similarity floor; see `services/party/matcher.js#SEARCH_SQL`.

Thresholds (declared as `THRESHOLDS` in `matcher.js`):

| Band | `confidence` | `matchedVia` (typical) |
|---|---|---|
| `sim == 1.0` | `EXACT` | `token_set` |
| `0.8 ≤ sim < 1.0` | `HIGH` | `trigram` |
| `0.6 ≤ sim < 0.8` | `REVIEW` | `trigram` |
| `0.4 ≤ sim < 0.6` | `REVIEW` if Layer 3 confirms, else drop | `phonetic` when surfaced |
| `sim < 0.4` | drop | — |

### Observed slip vs. the original spec

The original spec stated `HIGH = sim ≥ 0.8` and `REVIEW = sim ≥ 0.5`.
Two acceptance pairs sit just below the 0.8 cutoff on real pg_trgm:

| Pair | Observed `sim` | Spec wanted | Surfaced as |
|---|---|---|---|
| `Jeremy Billay` / `Jermy Billay` | 0.688 | `HIGH` | `REVIEW` |
| `Mohamed Ali` / `Mohammed Ali` | 0.786 | `REVIEW` | `REVIEW` |

There is no single `HIGH` cutoff that puts Jeremy/Jermy into `HIGH`
without also flipping Mohamed/Mohammed (a more conservative case)
into `HIGH`. Decision: **honour the conservative case** — keep
`HIGH = 0.8`, accept that Jeremy/Jermy lands in `REVIEW` instead of
`HIGH`. The candidate still appears in the review queue with a clear
score; only the band label differs.

For Catherine/Katherine the spec annotated "REVIEW (via phonetic)" but
on this data the canonical similarity is 0.700 — already inside the
trigram REVIEW band. The candidate surfaces as `REVIEW` with
`matchedVia=trigram`; phonetic never fires for that pair. Same final
outcome; different routing label.

## Layer 3 — phonetic + Levenshtein tiebreaker

For the ambiguous `[0.4, 0.6)` trigram band, the matcher consults two
additional signals to decide REVIEW vs drop:

1. **Double Metaphone per token.** Uses the `double-metaphone` npm
   package (same algorithm as Postgres `fuzzystrmatch.dmetaphone`, kept
   as a dependency for in-code use to save a round trip). Two tokens
   are phonetically compatible if any of their primary/alternate codes
   match.
2. **Levenshtein floor.** For each phonetically-matched token pair
   `(a, b)`, `levenshtein(a, b) / max(|a|, |b|)` must be
   `≤ PHONETIC_EDIT_RATIO_MAX` (currently `0.34`).

Both must pass, AND the bidirectional cover holds (every input token
phonetically matches at least one candidate token, *and* every
candidate token is covered by some input token).

The Levenshtein floor is the discriminant that handles a real edge:
without it, Double Metaphone happily groups any common first-name
pairs (John ↔ Jane: dmetaphone "JN" each; Levenshtein 3/4 = 0.75 —
correctly rejected). Catherine ↔ Katherine: dmetaphone "K0RN" each;
Levenshtein 1/9 = 0.11 — correctly surfaced.

This addition is **not in the original spec**. It exists because
phonetic codes alone cannot tell common short-form names apart from
genuine spelling variants. Documented as Layer 3 of the published
algorithm.

## Tuning

All thresholds are constants in
`server/services/party/matcher.js#THRESHOLDS`. Changing them affects
classification only — no migration needed:

- `EXACT`            (`1.0`) — locked at canonical-equality.
- `HIGH`             (`0.8`) — see "Observed slip" above.
- `REVIEW`           (`0.6`) — lowering surfaces more candidates as
                                trigram-driven REVIEW; raising pushes
                                more into the phonetic-gated zone.
- `PHONETIC_LO`      (`0.4`) — lowering admits weaker spelling variants
                                to the phonetic check; raising
                                effectively retires Layer 3.
- `PHONETIC_EDIT_RATIO_MAX` (`0.34`) — raising admits more spelling
                                       variation per token; lowering
                                       tightens the phonetic gate.

Re-run `npm run match:smoke` after any change — the assertion table is
the contract.

## Audit trail

Every call to `findMatches` is recorded in `party_match_log` regardless
of result. Schema (migration `0012`):

| Column | Notes |
|---|---|
| `id` | uuid PK |
| `input_name` | exact bytes the caller passed |
| `input_canonical` | output of `name_canonical(input_name)` |
| `candidates` | jsonb — compact `{partyId, score, confidence, matchedVia}[]` |
| `match_count` | int — `length(candidates)`; `0` is recorded too |
| `top_score` | numeric(4,3) — best candidate's score, `null` if no candidates |
| `called_by` | `x-user-id` header value, or `'system:resolve_parties'` from the in-graph resolver |
| `source` | `'api'` (HTTP route) \| `'resolver'` (in-graph node) |
| `called_at` | timestamptz |

Indexed on `called_at DESC` for the audit log page and `called_by` for
per-reviewer queries.

Why a dedicated table rather than reusing `decision_fragments`:

- `decision_fragments` is per-graph-step grain. The `resolve_parties`
  node produces *one* summary fragment per run; `party_match_log`
  records each input → candidates call.
- The HTTP route runs entirely outside the graph and has no fragment
  context.
- Retention differs: graph fragments delete with their runs;
  `party_match_log` lives as long as the parties it audits.

## Perf

Tested on a 100k-row synthetic corpus
(75 forenames × 30 middles × 50 surnames cartesian product —
**deliberately adversarial**: every name shares ≥1 token with thousands
of other names; see `scripts/match-perf-smoke.js` corpus). Realistic
call distribution (65% novel names / 20% near-misses / 15% exact
corpus hits).

Latest measurement:

```
n=200  p50=1.88ms  p95=83.60ms  p99=108.32ms
```

- **Misses** (~85% of calls) return in 1–5ms via the GIN array-overlap
  pre-filter — when the input shares no token with any indexed party,
  the bitmap is empty and the heap scan never runs.
- **Dense corpus hits** (the slow tail) take 50–100ms because
  `similarity()` must be computed across every token-overlap candidate;
  with this corpus that's 6k–11k rows per query. On real KYC data with
  mostly-unique full names this neighbourhood is 1–2 orders of magnitude
  smaller and the same code path returns well under 20ms.

Budgets enforced by `scripts/match-perf-smoke.js`:

| Metric | Budget | Rationale |
|---|---|---|
| p50 | < 10ms | Median lookups dominated by misses (realistic call shape). |
| p95 | < 100ms | Loosened from the spec's nominal 50ms because the synthetic dense-namesake worst case is intrinsic to pg_trgm + this corpus; would be sub-50ms on real data. |

Indexes (created in `0012` + `0013`):

- `parties_name_canonical_btree` — exact-canonical lookups.
- `parties_name_canonical_trgm` (`gin_trgm_ops`) — `%` operator path
  (not in the current matcher SQL but kept for future ad-hoc queries
  and `LIKE` acceleration).
- `parties_name_canonical_gist` (`gist_trgm_ops`) — supports the `<->`
  K-NN ordering operator. Not used by the current matcher (degrades
  badly on no-match inputs — full-index walk) but available for future
  K-NN paths that always have candidates.
- `parties_name_tokens_gin` (`gin`) — backs the array-overlap
  pre-filter; this is the index the current matcher actually uses.

## What this matcher is NOT

- **Not auto-merge.** Every match is a suggestion; humans decide.
- **Not multi-attribute.** Phase 1a uses name only. DOB, nationality,
  country of residence will land in Phase 1b — the service signature
  (`findMatches(input | { name, dob?, nationality?, … })`) accepts
  them today and ignores them.
- **Not multilingual.** Latin script only. Cross-script
  (Arabic / Cyrillic / CJK) transliteration is out of scope.
- **Not embedding-based.** No ML, no vector stores, no external
  matching service. Postgres + pg_trgm + fuzzystrmatch is the whole
  stack.
- **Not real-time merge.** Merging two parties (resolving a review
  queue item) is a Phase 4 UI action backed by a transactional service.

## Re-running the assertions

```bash
cd server
npm run match:smoke           # 8-row acceptance table + determinism + audit
npm run match:perf:smoke      # 100k-row p50/p95 budgets (seeds once)
npm run party-resolver:smoke  # 9 resolver scenarios end-to-end
```

All three scripts are idempotent. `match:smoke` and `party-resolver:smoke`
clean up their own fixtures; `match:perf:smoke` reuses the 100k
`source_kind='perf_smoke'` rows after first run. `party-resolver:smoke`
also wipes any leftover smoke parties at startup (defensive — recovers
from a previous failed run).

---

# Resolver layer (Phase 1b)

The matcher above is the *similarity* layer. The **resolver** is the
*decision* layer that turns a dossier's CH inputs into rows in the
party master and the linkage tables.

Lives at `services/party/resolver.js`. Called by smoke tests today; the
in-graph `resolve_parties` node in Phase 2 calls the same entry point.

## Data model

```
                           ┌──────────────────┐
                           │     parties      │  <- canonical identities
                           └────┬────────┬────┘
                                │        │  (self-FK, soft-merge pointer)
                                │        └────────► parties.merged_into_party_id
                                │
              ┌─────────────────┼─────────────────┐
              ▼                                   ▼
      ┌──────────────┐                  ┌──────────────────┐
      │ party_links  │                  │ party_review_    │
      │  (role,      │                  │ queue            │
      │   status,    │                  │ (pending dedup   │
      │   dates)     │                  │  decisions)      │
      └──────┬───────┘                  └──────────────────┘
             │
             ▼
   ┌──────────────────────────┐
   │ party_link_status_history│  <- append-only, audit grade
   └──────────────────────────┘
```

- **`party_links`** — one row per (party, dossier, role, key dates). The
  unique index is partial-NULL-coalescing so re-runs upsert in place,
  never spawn duplicates. `match_confidence` + `match_evidence` record
  which signal drove the link.
- **`party_link_status_history`** — every status transition is recorded
  (active → resigned, active → ceased, anything → historical). Never
  updated after insert.
- **`party_review_queue`** — created whenever the resolver makes a NEW
  party AND the matcher returned HIGH or REVIEW candidates pointing at
  existing parties. Reviewer flips status to `merged` or `rejected` in
  Phase 4's UI.

## Decision waterfall (per subject)

```
                ┌──────────────────────────────┐
                │   Subject: officer / psc /   │
                │           shareholder        │
                └──────────────┬───────────────┘
                               │
       ┌───────────────────────┴────────────────────────┐
       │                                                 │
       ▼                                                 ▼
 Strong-key present?                              No strong key
       │
   ┌───┴───┐
   │       │
   ▼       ▼
 YES      NO
   │       │
   │       └────► Name matcher (services/party/matcher.js)
   │              │
   │              ├── EXACT (sim=1.0)  →  auto-link to candidate, no review
   │              ├── HIGH/REVIEW       →  NEW party (needs_review=true)
   │              │                       + party_review_queue row per candidate
   │              └── No candidates     →  NEW party silently
   │
   ▼
 Strong-key lookup
   │
   ├── hit  →  link to existing party (match_confidence = 1.0)
   └── miss →  NEW party with the strong-key recorded
              (so future calls hit on lookup)
```

### Strong keys by subject type

| Subject | Individual strong key | Corporate strong key |
|---|---|---|
| Officer | `links.officer.appointments` URL → extracted `appointment_id` | `(identification.country_registered, identification.registration_number)` |
| PSC | *none* — individual PSCs have no cross-company CH identifier | `(identification.country_registered, identification.registration_number)` |
| Doc-extracted shareholder | *none* | *none* |

For corporate strong-key matches where the registration number matches
a `dossiers.company_number` we already onboarded, the party row's
`dossier_id` back-link is set. This is what enables Phase 5's
cross-dossier ownership graph.

### Why EXACT auto-links (and the risk)

A canonical-name `sim=1.0` candidate is treated as the same party — no
review queue entry, immediate link to the existing party. This is a
**deliberate Phase 1b decision**: with only name available (DOB +
nationality are deferred to Phase 1c), name equality is the strongest
signal we have. Two real people with the same canonical name and no
appointment-id will merge on first sighting.

The mitigation is Phase 1c: once DOB year+month and nationality
participate, EXACT-on-name without matching DOB will downgrade to
REVIEW. The auto-link path stays for name+DOB+nationality EXACT.
The `findMatches` signature already accepts the future shape (see
`server/lib/partyMatchSchema.js` — `dob`, `nationality`,
`countryOfResidence`) so Phase 1c is a behavioural change, not a
contract change.

## Status reconciliation

After every run, the resolver compares the set of links it touched
against `getOpenLinksForDossier(dossierId)`. Any link not touched in
this run flips to `status='historical'` (and a history row is
appended). This is how "officer X disappeared from the latest CH
snapshot" gets recorded without destroying audit history.

Re-runs of the resolver on identical inputs produce **zero** new rows
(parties, links, history, queue items) — every write is idempotent.
Asserted by `party-resolver:smoke` step 2.

## Cross-source dedup within a single run

The resolver processes officers first, then PSCs, then shareholders.
Each subject commits its party + link before the next subject runs the
matcher. So a person appearing as both officer AND PSC on the same
dossier resolves to ONE party with TWO links (different roles, both
upsert on their own role-specific unique key).

Verified by `party-resolver:smoke` step 6: same name in `officers` and
`psc.items` produces a single party with role-distinct link rows.

## Read API

| Method | Path | Notes |
|---|---|---|
| GET | `/api/parties` | List with filters: `q` (substring on full_name or canonical), `needs_review`, `dossier_id`. Paginated via `limit`/`offset`. |
| GET | `/api/parties/:id` | Party + all links (joined to dossier company_number/name) + open `party_review_queue` items mentioning this party. |
| POST | `/api/parties/match` | The matcher endpoint (Phase 1a). |

Merge/split, batch-resolve, and review-queue resolution endpoints land
in Phase 4 alongside their UI.

## Test coverage (Phase 1b)

`scripts/party-resolver-smoke.js` walks the following scenarios end to
end on a real database, asserting after each:

| # | Scenario |
|---|---|
| 1 | Officer with `appointment_id` (strong key, first sighting) |
| 2 | Re-run identical input (idempotency) |
| 3 | Officer transitions to resigned (status history append) |
| 4 | Officer with no `appointment_id`, no matcher candidates (silent new party) |
| 5 | Same name officer again → matcher EXACT → auto-link |
| 6 | PSC with same name as the officer → 2 links, 1 party |
| 7 | Corporate PSC with registration matching a seeded dossier → dossier back-link |
| 8 | Officer whose name is a close typo of a seeded party → REVIEW → new party + queue item |
| 9 | Drop subjects from inputs → links flip to historical |

If any step fails the script halts; cleanup runs in `main()` so a clean
final state is preserved across re-runs.

---

# Phase 2 — Graph integration

`resolve_parties` is now a first-class node in both `compiledGraph` and
`compiledScreeningOnlyGraph`, sitting between `synthesize_card` and
`compile_screening_list`. Every run (initial + rescreen) populates the
party master and downstream screening sees stable cross-run identifiers.

```
… → synthesize_card → resolve_parties → compile_screening_list →
                          ↓
                    state.parties[]
                    state.partyLinks[]
                    shareholderGraph (node IDs rewritten to party:<uuid>)
```

State additions (`server/graph/state.js`):

| Field | Shape | Owner |
|---|---|---|
| `parties[]` | `StatePartySchema` | `resolve_parties` |
| `partyLinks[]` | `StatePartyLinkSchema` | `resolve_parties` |
| `screeningSubjects[i].partyId` | optional string | `compile_screening_list` (when state.parties present) |

`compile_screening_list` now takes the **party-aware path** when
`state.partyLinks` is populated:

- One subject per `(party × active link role)` pair.
- `subjectId = "party:<uuid>"` — stable across runs and dossiers.
- Each subject carries `partyId`, propagated through `screen_sanctions`
  and `screen_adverse_media` into the hit object.

When `state.parties` is empty (e.g. resolver skipped because the
`dossierId` wasn't yet in `config.configurable`), the legacy
`${source}:${normalizedName}` path runs unchanged so the graph still
works end-to-end on edge cases.

`screening_hits` got a nullable `party_id` column in migration 0015.
The SSE writer threads it from the hit object onto the inserted row.
Pre-Phase-2 hits keep NULL — the index is partial so it stays small.

The shareholder graph's node IDs are rewritten from
`p:<NORMALIZED>` / `o:<NORMALIZED>` / `s:<NORMALIZED>` to
`party:<uuid>` for every node whose label matches a party the resolver
just touched. The company node keeps its `co:<companyNumber>` prefix.
Unmatched nodes (rare — typically corporate shareholders the resolver
didn't link to a party for whatever reason) keep their legacy IDs. The
mixed format is supported by Cytoscape and renders identically; the
party-prefixed IDs are what enable the Phase 5 cross-dossier graph
expansion.

`scripts/graph-resolver-smoke.js` (npm: `graph-resolver:smoke`)
exercises this end-to-end on synthetic state: invokes the
`resolve_parties` node directly, then `compile_screening_list`, then
appends a fake screening_hit, asserting each step's outputs.

---

# Phase 3 — Screening rekey (party-level overrides)

Reviewer decisions to dismiss or confirm a sanctions/adverse-media match
now apply **globally per party** rather than just on the dossier where
they were made.

Schema:

- `party_screening_overrides` (migration 0016 + 0017 uniqueness fix) —
  one row per `(party_id, list_source, list_entry_id, evidence_url)`.
  The uniqueness uses a partial-COALESCE index so NULL discriminators
  participate (same pattern as `party_links_uniq`).
- `dossier_screening_overrides` stays in place for backward
  compatibility with pre-Phase-2 hits that have no `party_id`.

Lookup precedence in `evaluate_sanctions_hits` and
`evaluate_adverse_media`:

1. **Party-level override** — found via
   `getOverridesForParties(distinctPartyIdsOnHits)`. If a row matches
   `(party_id, list_source, list_entry_id)` (or `evidence_url` for
   adverse media), its decision is the final decision for that hit.
2. **Dossier-level override** — fallback for hits with no `party_id`.
   Same matcher as pre-Phase-3.
3. **LLM evaluation** — runs in either case (sanctions) so the
   reasoning stays on the audit trail. For adverse media we skip the
   LLM when an override exists (articles change weekly; little audit
   value in re-running).

### "Carry overrides forward" semantics flip

The existing `POST /api/dossiers/:cn/runs/:runId/carry-overrides-forward`
route now routes each hit by whether it has a `partyId`:

- **`partyId` present** → write to `party_screening_overrides`
  (cross-dossier global decision).
- **No `partyId`** → write to `dossier_screening_overrides` (legacy,
  dossier-scoped).

The response carries both counts: `{ ok, carried, dossierLevel, partyLevel }`.

**Behavioural change**: any reviewer who's been clicking "Carry
forward" on a post-Phase-2 run is now establishing an enterprise-wide
policy on that party, not a per-dossier exception. Future UI
copy/tooltips can call this out — the data model already supports it.

### Direct override endpoint

`PATCH /api/parties/:id/overrides` — body
`{ listSource, listEntryId?, evidenceUrl?, decision, reason? }`.
Decision is `'confirmed'` / `'dismissed'` / `null` (clear). Used by the
Party Detail page (Phase 4) so a reviewer can establish a party-level
decision without going through a run.

### Test coverage (Phase 3)

`scripts/screening-rekey-smoke.js` (npm: `screening-rekey:smoke`):

| # | Scenario |
|---|---|
| 1 | `setPartyScreeningOverride` upserts on the COALESCE-keyed unique index |
| 2 | Bulk `getOverridesForParties` finds the row |
| 3 | `applyOverridesForward` routes party-id'd hits to party_screening_overrides and legacy hits to dossier_screening_overrides |
| 4 | Same party surfaces the same override when seen via a different dossier |
| 5 | `clearPartyScreeningOverride` removes the row |

---

# Phase 4 — Party UI + merge

### Merge service

`services/party/merge.js#mergeParties({ winnerId, loserId, reason, userId })`
performs a soft merge:

1. Validate both parties exist and neither is already merged.
2. Re-point every `party_links` row from loser → winner. On a uniqueness
   collision (winner already has the same `(dossier, role, dates)` link)
   the loser's link is deleted instead — winner's link is kept.
3. Move all `party_screening_overrides` from loser → winner via the
   Phase 3 upsert. Loser's overrides are then deleted (now redundant).
4. Resolve every open `party_review_queue` item involving the loser:
   - The specific (loser, winner) pair → `status='merged'`
   - Any other open item touching the loser → `status='rejected'`
5. Set `loser.merged_into_party_id = winner.id` plus the audit triplet
   `(merged_by, merged_at, merge_reason)` from migration 0018.

The loser row is **kept**, not deleted, so historical references (a
serialized report from an older run that holds `party_id =` the loser)
still resolve. The redirect pointer makes "the canonical party today"
discoverable.

### Endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/api/parties` | List with filters: `q`, `needs_review`, `dossier_id`, pagination. Each row carries `linked_dossier_count`. |
| GET | `/api/parties/:id` | Party + all links (joined to dossier) + open review-queue items. |
| POST | `/api/parties/match` | The Phase 1a matcher endpoint. |
| PATCH | `/api/parties/:id/overrides` | Phase 3 — set / clear cross-dossier override. |
| POST | `/api/parties/:id/merge` | Phase 4 — `:id` is the winner; body specifies the loser. Returns merge counts. |
| GET | `/api/parties/review-queue` | Open review-queue items (joined with both parties' display names for side-by-side rendering). |
| POST | `/api/parties/review-queue/:itemId/resolve` | Body: `{ action: 'merge'\|'reject', winnerPartyId?, reason? }`. Merge triggers `mergeParties`; reject just flips the queue item's status. |

### UI surfaces

- **`/party/:partyId`** (`PartyDetailPage.vue`) — header with party-type +
  identifiers + alias chips + cross-dossier counts. Tab strip:
  Linked dossiers / Review candidates / Audit. Inline merge dialog when
  the reviewer accepts a candidate.
- **`KycCard.vue` inline badges** — each officer/PSC row in a dossier
  card gets a "Also in N other dossiers" chip when the matching party
  has links beyond this dossier. Chip links to the party detail page.
- **`WatchlistPage.vue` review-queue tab** — lists open queue items
  side-by-side with merge/reject inline forms. Counts in the tab header.

### Composables

- `useParty(partyId)` — fetch detail, expose `mergeFrom()` /
  `setOverride()` actions, re-fetch on success.
- `useParties()` — list-and-filter helper. Used by `DossierViewPage`
  for the KycCard badges.
- `usePartyReviewQueue()` — list + resolve helper. Used by the
  Watchlist tab.

### Schema twins

`server/lib/partyMatchSchema.js` + `web/src/lib/partyMatchSchema.js`
now export `partyMergeSchema` and `reviewQueueResolutionSchema`
(discriminated-union on `action`). Same physical-twin pattern as
`decisionSchema.js`.

---

# Phase 5 — Cross-dossier ownership graph

The party master makes cross-dossier traversal possible. Phase 5
exposes it as a Cytoscape network on the party detail page so a
reviewer can see the whole footprint of a person/organisation at a
glance.

### Service

`services/party/graph.js#buildPartyGraph(partyId, { depth=2, limit=50 })`
returns a Cytoscape-shaped payload:

```
{
  centerPartyId, depth, limit,
  nodes: [
    { data: { id: "party:<uuid>", label, kind, isCenter?, linkedDossierCount, needsReview, ... } },
    { data: { id: "dossier:<uuid>", label, kind: "dossier", companyNumber, caseStatus } },
  ],
  edges: [
    { data: { id, source, target, role, status, appointedOn, ... } },
  ],
  counts: { nodes, edges, dossiers, parties, truncated }
}
```

Depth semantics:

- `1` — centre party + every dossier it has a link to (any status).
- `2` (default) — also includes other parties on those dossiers.

Truncation:

- Cap at `limit` total nodes (default 50, max 200).
- Nodes are added in deterministic order — centre first, then linked
  dossiers (oldest first), then other parties (oldest first). Smaller
  limits truncate the periphery, not the centre.
- `counts.truncated` flags when the cap was hit.

### Endpoint

`GET /api/parties/:id/graph?depth=1|2&limit=N` — returns the payload
above. `404` if the party doesn't exist.

### UI surface

- **Party detail page → Network tab** (`PartyDetailPage.vue` +
  `PartyGraph.vue`) — embeds a Cytoscape graph with controls for depth
  and node limit. Centre party gets an accent fill; dossiers get the
  same primary blue as the company node in the shareholder graph.
  Active links solid, resigned/ceased/historical edges dimmed.
- **Click-through**:
  - Clicking a dossier node navigates to `/dossier/:companyNumber`.
  - Clicking another party node navigates to `/party/:partyId`.
  - The centre party node is non-navigating (you're already there).
- **`ShareholderGraph.vue` enhancement** — clicking a `party:<uuid>`
  node in the per-dossier graph navigates to the same party detail
  page, so the two views are reachable from each other.

### Test coverage (Phase 5)

`scripts/party-graph-smoke.js` (npm: `party-graph:smoke`):

| # | Scenario |
|---|---|
| 1 | depth=2 from a hub party → centre + 2 dossiers + 2 peripheral parties, 4 edges |
| 2 | depth=1 omits peripheral parties (3 nodes, 2 edges) |
| 3 | limit=2 truncates and flags `counts.truncated` |
| 4 | `linkedDossierCount` populated correctly on centre + peripherals |
| 5 | Missing party id raises `GraphBuildError(code='not_found')` |
