# Business process — KYC dossier POC

**Audience.** This document is written for the Business Process Owner and other non-technical reviewers who need to understand *what the solution does, in what order, and why*, in order to assess whether the process matches policy and where it should be improved.

**Status.** Describes the system as it stands today (proof-of-concept, single user, runs locally). Each functional section ends with **Open questions for review** — points the author noticed during write-up that seem worth a conscious decision before the solution leaves POC.

**Scope.** End-to-end: from "analyst opens a new case" through to "case is finalised and audit-logged", including the supporting back-office processes (risk-matrix governance, prompt tuning, sanctions-list refresh, manual overrides).

---

## 1. Purpose of the solution

The solution helps a KYC analyst build a defensible "know-your-customer" dossier on a **UK limited company**, by automating four tasks that today are done manually:

1. **Identity & ownership discovery** — pulling the company's registry record, officers, persons with significant control (PSCs), and shareholders from filed documents.
2. **Sanctions and adverse-media screening** — checking the company and every identified individual against published sanctions lists and recent news.
3. **Risk scoring** — assigning a tier (Low / Medium / High) and an outcome recommendation based on a configurable risk matrix.
4. **Quality assurance & routing** — checking the dossier is complete and internally consistent, then routing it to the right reviewer tier (auto-approve / streamlined / standard).

The analyst remains in control. The system makes recommendations; the reviewer decides. Every machine-made decision is logged, can be overridden, and the override is auditable.

---

## 2. Glossary (business terms used throughout)

| Term | Meaning |
|---|---|
| **Dossier** | The full KYC record for one company. Lives across multiple runs over time. |
| **Run** | A single attempt to produce or refresh a dossier. A dossier accumulates many runs. |
| **Subject** | An entity being screened: the company itself, an officer, a PSC, or an extracted shareholder. |
| **KYC card** | The structured summary at the heart of the dossier (identity, officers, PSCs, shareholders, financials, red flags). |
| **Hit** | A potential match returned by sanctions matching or adverse-media search. Always evaluated before being treated as confirmed. |
| **Evaluation** | The judgement on a hit: `confirmed`, `dismissed`, or `needs_review`. Produced by an LLM with a documented prompt; can be overridden by the analyst. |
| **Knockout** | A rule that forces the risk tier or outcome regardless of the calculated score (e.g. a confirmed sanctions hit forces High). |
| **Case status** | The reviewer-facing state of the dossier: `pending → auto_approved / streamlined_review / standard_review → approved / rejected / escalated / info_requested`. Terminal states cannot be silently overwritten by a new run. |
| **Override** | An analyst-recorded decision that supersedes the system's judgement. Per-run (one hit) or per-dossier (carries forward to future runs). |
| **Refresh / Rescreen / Recalculate** | Three different ways to update an existing dossier; they differ in *what* gets recomputed. See §10. |

---

## 3. Actors and responsibilities

| Actor | What they do in the process |
|---|---|
| **KYC analyst** | Initiates new cases, confirms entity matches, reviews machine output, applies overrides where appropriate. |
| **Reviewer** | Renders the final decision on a case (approve / reject / escalate / request info). May be the same person as the analyst in this POC — there is no two-person rule today. |
| **Risk policy owner** | Owns the risk matrix (weights, thresholds, country tiers, knockout rules). Reviews and activates new matrix versions. |
| **Prompt owner** | Owns the LLM prompts used for extraction, synthesis, hit evaluation, and risk rationale. Reviews and activates new prompt versions. |
| **Data steward** | Refreshes the sanctions lists from official sources. Today this is a manual command. |

> **Open questions for review**
> - There is no enforced separation between analyst, reviewer, and policy/prompt owner. Should the target solution require a different person to approve vs. analyse?
> - There is no permissions model. Anyone using the tool can edit the risk matrix, change prompts, or finalise a case. What is the target governance model?

---

## 4. The big picture — case lifecycle

```
   ┌──────────────────────────────────────────────────────────────────────────┐
   │ Analyst                                                                  │
   │  ▼                                                                       │
   │ Search company ──► Confirm match ──► (system runs phases automatically)  │
   │                                          │                               │
   │                                          ▼                               │
   │                              ┌─────────────────────┐                     │
   │                              │ 1. Dossier build    │  (CH + OCR)         │
   │                              │ 2. Screening        │  (sanctions + news) │
   │                              │ 3. Risk assessment  │                     │
   │                              │ 4. QA gating        │                     │
   │                              └─────────┬───────────┘                     │
   │                                        ▼                                 │
   │                            Routed case_status:                           │
   │                              • auto_approved  ◀── Low risk, all checks   │
   │                              • streamlined_review     pass               │
   │                              • standard_review                           │
   │                                        ▼                                 │
   │ Reviewer ── decides: approve / reject / escalate / request_info          │
   │                                        ▼                                 │
   │                                Terminal state                            │
   │                                                                          │
   │  At any later point: refresh, rescreen, recalculate-risk, recompute-QA   │
   └──────────────────────────────────────────────────────────────────────────┘
```

The four automated phases (build → screen → risk → QA) run as a single connected workflow. They share one piece of state — the in-flight case — and emit a continuous live trail of "decision fragments" to the analyst's screen so the work is visible as it happens.

---

## 5. Phase 1 — Case initiation and entity confirmation

### What the analyst does
The analyst opens the search page and types a company name (or company number) plus, optionally, a postcode or incorporation year as disambiguators.

### What the system does
1. **Searches the UK Companies House registry.** The search uses Companies House's own fuzzy-name matching as the first pass.
2. **Scores each candidate deterministically.** A base score derived from the registry's ranking is then adjusted for:
   - exact match on company number (hard match, +1.00),
   - matching registered-office postcode (+0.30),
   - matching incorporation year (+0.20),
   - shared legal-form keyword such as *ltd*, *plc*, *llp* (+0.15).
3. **Decides what to show the analyst.**
   - If the top candidate scores ≥ 0.85 *and* is at least 0.20 ahead of the next, it is presented as an **auto-match** — but the analyst still has to confirm.
   - Otherwise, the top 5 candidates are shown side-by-side for the analyst to pick.
   - If nothing returns, the system asks for more information.
4. **Pauses the run** at this point. No further calls to Companies House or any other external system happen until the analyst confirms a choice.

### Why this matters to the process
Picking the wrong entity is the most expensive mistake the system can make — every downstream check would be on the wrong company. The deterministic scoring is designed to make that pick traceable: every signal it used to rank candidates is visible.

> **Open questions for review**
> - The auto-match threshold (0.85 with a 0.20 gap) was chosen by the project team without an explicit policy mandate. Does it match the business's risk appetite?
> - Even on an auto-match, the system always asks the analyst to confirm. Is that intentional friction (good for audit), or is it slowing analysts down on the obvious cases?
> - Only postcode and incorporation year are exposed as disambiguators. Should director name, SIC code (industry), or registered-address town also be supported?
> - The LLM is **not** used at this step — selection is purely deterministic. Should the LLM be used as a tie-breaker on ambiguous near-matches?
> - There is no record of *why* the analyst picked a particular candidate when the system was ambiguous. Should the analyst be required to record a one-line justification when the auto-match threshold isn't met?

---

## 6. Phase 2 — Dossier build (registry data + documents + OCR)

Once the analyst confirms the entity, the system builds the dossier in two parallel streams.

### Stream A — Registry data
Four endpoints are called in parallel:
- **Company profile** — official name, registered office, incorporation date, company type, SIC codes, status (active / dissolved / etc.).
- **Officers** — directors, secretaries; current and historical. Resigned officers are dropped from the entity graph but kept in the dossier.
- **Persons with Significant Control (PSCs)** — people or entities that, per the CH register, control 25%+ of shares or voting rights.
- **Filing history** — the list of every filing the company has submitted.

This stream is fast (seconds), uses cached responses by default to stay well below the 600-requests-per-5-minutes rate limit, and produces structured data directly.

### Stream B — Document pipeline
The system picks **at most three documents** — the latest filing in each of three categories:
- **Confirmation statement** — the annual disclosure that lists shareholders.
- **Accounts** — the annual financial statements.
- **Incorporation** — the founding document with initial subscribers.

For each document:
1. The PDF is downloaded.
2. The system tries plain text extraction first (faster, cheaper).
3. If text extraction yields too little (or the policy says "always OCR" — currently the case for confirmation statements, which are table-heavy), the document is rasterised page-by-page and each page is sent to an OCR-trained model. **OCR is capped at 5 pages** (configurable) — large confirmation statements may have 50+ pages.
4. The OCR text (or extracted plain text) is then sent to a reasoning model with a category-specific prompt that returns structured JSON: shareholders, financial headlines, initial subscribers.

### Synthesis — the KYC card
Once both streams complete, a final synthesis step merges everything into the **KYC card**:
- Identity (name, number, address, incorporation date, status, country of incorporation — defaults to "United Kingdom").
- Officers, PSCs, extracted shareholders.
- Financial headlines from accounts.
- Red flags (e.g. dissolved status, unusually old, foreign address).
- A **Cytoscape entity graph** — nodes for the company, every officer, every PSC, every shareholder, with edges marked as *owns* or *officer of*. Used for the shareholder-graph view.

A strict rule applies: *registry data is authoritative*. Where the registry and the documents disagree, registry wins. The LLM is instructed to follow this rule and the prompt is versioned (see §13).

> **Open questions for review**
> - **Document selection is hard-coded** to three categories, latest-only. Should other categories matter for KYC (e.g. *change of share class*, *charges/mortgages*, *resolutions*)?
> - The 5-page OCR cap means large confirmation statements may yield an **incomplete shareholder list**. Is that an acceptable trade-off, or should the cap be raised (cost) or made dynamic?
> - **iXBRL** (the structured data format that Companies House publishes alongside accounts PDFs) is not consumed today — we rely on OCR of the PDF, which is less accurate. Is the simplification justified?
> - **Country of incorporation defaults to "United Kingdom".** This is safe in 99% of cases (the registry is the UK one) but a UK-registered subsidiary of a foreign group may have a different *operational* jurisdiction. Should we capture both registered and operational country?
> - **Resigned officers are dropped from the entity graph** but kept in the dossier. Should they be screened? They may be historically significant.
> - **Authorized signatories** are explicitly out of scope. Is this a real KYC gap in practice?
> - The synthesis step is a single LLM call. There is no second pass to verify the KYC card against the underlying evidence. Should we add a checker step?

---

## 7. Phase 3 — Screening (sanctions and adverse media)

Screening is the most policy-sensitive part of the process. It runs in two parallel branches.

### Subject compilation
First, the system assembles the list of **subjects** to screen:
- The company itself.
- Every officer.
- Every PSC.
- Every shareholder extracted from the confirmation statement.

Subjects are de-duplicated by normalised name. The same person appearing as both an officer and a PSC is screened once.

### Branch A — Sanctions screening
- **Lists used (v1):** OFAC SDN (US) and UK HMT Consolidated list.
- **Matching method:** token-set similarity (a fuzzy-string algorithm) combined with phonetic matching ("Double Metaphone") as a fallback. Aliases on each sanctions entry are matched alongside the primary name.
- **Threshold:** a single global similarity threshold (currently 0.85) — same for company names and individual names, same for all sources.
- **Source-of-truth:** the lists are downloaded from the official sources and stored locally. A refresh is a **manual command** today — there is no automatic schedule.

For each potential match (a "hit"), an LLM evaluator reads the candidate and the sanctioned entity record and decides: **confirmed**, **dismissed**, or **needs_review**. The prompt is biased toward `needs_review` when identifying details (date of birth, nationality, address) are absent — i.e. the system prefers human review over a false confidence call.

### Branch B — Adverse media screening
- **Source:** GDELT (a free public news aggregator). No API key required.
- **Scope:** **individuals only** — the company itself is not screened for adverse media. (Companies are too noisy to screen at name-only level without entity-disambiguation infrastructure.)
- **Time window:** 12 months by default.
- **Returns:** headline-only matches (no article body) — the LLM evaluator works from the headline.
- **Rate limit:** GDELT throttles to one request every 5 seconds; the system queues subjects serially to respect that.

For each article, an LLM evaluator classifies it as: confirmed adverse / dismissed (clearly unrelated context) / needs_review. It also tags the category (financial crime, corruption, fraud, money laundering, other) and severity (low / medium / high).

### Screening report
Once both branches are evaluated, a deterministic rule (no LLM) assigns an overall screening risk:
- Any **confirmed sanctions hit** → `high`.
- A **confirmed adverse-media hit** in {financial_crime, corruption, fraud, money_laundering} at severity ≥ medium → `medium`.
- Sanctions matches still in `needs_review` → `medium`.
- Otherwise → `low`.

This screening risk is **one of the inputs** to the risk assessment (Phase 4) and can trigger knockouts there.

> **Open questions for review**
> - **A single similarity threshold (0.85) governs all sanctions matching.** It is the same number for "John Smith" (very common name → many false positives) and "Atanasios Polychroniou" (rare → fuzzy match strongly indicative). Should the threshold be name-rarity-aware?
> - **Only OFAC SDN and UK HMT are loaded today.** EU sanctions, UN consolidated list, and other national lists are not. Which lists are policy-mandatory for the target solution?
> - **PEP (Politically Exposed Person) screening is entirely absent.** No data source has been chosen. What is the business position?
> - **Adverse media is on individuals only.** Should the company itself be screened? If yes, what disambiguation tooling do we need to avoid drowning in noise?
> - **GDELT returns headlines only, no article body.** The LLM is told this and asked to be cautious — but the operational reality is that *the model is judging relevance from a headline alone*. Is this acceptable for the target solution?
> - **12-month adverse-media window** is the default. Is that the right window? For ongoing monitoring it may be too short; for fresh onboarding it may be too long.
> - **Recursive ownership-chain walking is out of scope.** If the company's 30% shareholder is itself a company, that parent is not separately screened. Is this a real KYC gap?
> - **Latin-script-only.** A subject named in Cyrillic, Arabic, or Chinese characters on a sanctions list will not match its Latinised form unless the list itself carries the Latin alias. Should we add transliteration normalisation?
> - **Same person, multiple roles.** Subjects are deduplicated by normalised name. This is correct in most cases but fails for very common names (two "John Smith"s on the board would be merged). Should we de-dupe by name + a secondary signal (DoB if known, nationality)?

---

## 8. Phase 4 — Risk assessment

### What it produces
A risk receipt with:
- A numeric **score** (0–100, weighted sum of factor contributions),
- A **tier** (Low / Medium / High),
- An **outcome** recommendation (Approve / Enhanced Due Diligence / Prohibited),
- A **rationale** (a short, regulator-defensible narrative — headline + up to 3 drivers + a sanctions note),
- The **trajectory** (the delta vs. the previous run's score, flagged if material),
- The **receipt** — a complete breakdown of every input, weight, base score, and contribution per factor, plus any knockouts triggered.

### How the score is calculated
Four factors are evaluated, each with a configurable weight in the risk matrix:

| Factor | What it measures | Where the input comes from |
|---|---|---|
| **Geographic** | Risk of the registered country | Companies House profile (country defaults to UK) |
| **Entity type** | Risk associated with the legal form | Companies House `company_type` (mapped via matrix aliases) |
| **Structural complexity** | Number of corporate PSCs and heuristic ownership-layer depth | PSC data + extracted shareholders |
| **Industry** | Risk associated with the SIC code(s) | Companies House SIC codes, longest-prefix matched |

Each factor produces:
- A **base score** (0–100) from the matrix's per-attribute scoring tables.
- A **contribution** = `weight × baseScore`.
- The **total score** = the sum of contributions.

The score is then mapped to a tier using the matrix thresholds. Tier is then mapped to an outcome.

### Knockouts
After the deterministic score, three knockouts (all read from the screening report only) can escalate the result:
- **Screening medium floor** — confirmed adverse media or sanctions `needs_review` → tier floor of Medium.
- **Screening high override** — any confirmed sanctions hit → tier forced to High.
- **Screening prohibited** — confirmed sanctions hit → outcome forced to `Prohibited`.

Knockouts **only escalate**. They never reduce a high score back down.

### Rationale
The numeric score is enriched with a short narrative generated by an LLM, using the risk receipt as input. The prompt (`risk.rationale`) is versioned in the prompt registry. If the LLM call fails for any reason, the system falls back to a template-based rationale and tags the receipt so reviewers know the rationale was not LLM-generated.

### Trajectory
The system compares the new score to the previous run's score. If the delta is ≥ a configurable threshold (default 15 points), the change is flagged as material on the dossier card.

### Risk matrix governance
The matrix lives in the database as **versioned, append-only** records. Editing the matrix means creating a new version, then activating it. The "active" pointer is a singleton. Every risk receipt records the matrix version it was calculated against, so historical runs remain traceable even after the matrix changes.

> **Open questions for review**
> - **Only four factors.** UBO nationality, distribution channel, financial health, and PEP exposure are not yet inputs. Is the resulting score actionable enough to support a real decision, or is it indicative-only at this point?
> - **Linear weighted sum.** All factors are combined by weighted sum. A company that is highly risky on one factor but neutral on three others may not reach a tier that reflects the single red flag. Should there be a "maximum factor" override?
> - **Knockouts only escalate.** A confirmed-as-false-positive sanctions hit (after human override) won't pull the risk back down. Is that desired?
> - **Trajectory threshold (15) is a default with no policy basis.** What is the right number?
> - **The LLM rationale is shown to reviewers as evidence.** It is generated from the receipt JSON, not from the underlying documents, so it cannot hallucinate facts — but it can phrase things misleadingly. Is rationale governance (versioned prompt, fall-back template) sufficient?
> - **Same matrix is used for every case.** No segmentation by product line, customer type, or onboarding channel. Is that a real limitation?
> - **Matrix activation is a single-click operation.** Anyone with access can switch the active matrix version. Should this require a second approval?

---

## 9. Phase 5 — QA gating and case routing

After the risk assessment, the system runs a **quality assurance check** before handing the dossier to a reviewer. QA does not change any underlying data; it produces a verdict on whether the dossier is fit to be reviewed.

### Two kinds of check

**Completeness checks** — *is the required data there?* Examples:
- Identity fields populated.
- At least one officer present.
- At least one PSC present (or an explicit "no PSC" status).
- A screening report exists.
- A risk assessment exists.

Document-quality issues (e.g. OCR returned little text) are flagged as **warnings**, not gating failures.

**Consistency checks** — *do the parts of the dossier agree with each other?* Examples:
- *UBO not screened* — every PSC has an evaluation in the screening report.
- *Tier too low for sanctions hit* — if there is a confirmed sanctions hit, the tier must be High.
- *Tier too low for knockout* — if a knockout fired, the tier must reflect it.
- *Status contradicts registry* — proposed outcome shouldn't be "Approve" if the company is dissolved.
- *Status contradicts document evidence* — proposed outcome shouldn't be "Approve" if a critical document failed to extract.

### Routing decision

The result is a single routing call:
- **Failed checks** → `standard_review` (a human must look at everything).
- **All checks passed, tier = Low** → `auto_approved`.
- **All checks passed, tier = Medium** → `streamlined_review`.
- **All checks passed, tier = High** → `standard_review`.

The routed case status is mirrored onto the dossier — but **only if the dossier is currently in a non-terminal state**. A new run cannot un-approve or un-reject a dossier that has already been finalised by a reviewer.

### Visibility for the analyst
The reviewer's screen shows the routing tier and a list of any issues highlighted by QA (each linked to the relevant section of the dossier).

> **Open questions for review**
> - **Low + all checks pass → auto-approval.** This means a company can be approved without any human ever clicking "approve" — only confirming the entity match at the start. Is auto-approval acceptable, and if so under what minimum conditions?
> - **Document warnings don't gate.** If the confirmation statement OCR returned nothing useful (shareholders unknown), the case can still be `auto_approved`. Should that combination be an automatic step-up to standard review?
> - **Completeness criteria are coded into the engine.** They are not configurable by the policy owner today. Should they be a policy-owned configuration?
> - **No second-line approver for auto-approve.** The system auto-approves without any human confirmation at the approval step. Is that the target operating model?
> - **The QA verdict is shown alongside the data, not as a gate.** A reviewer doing standard review still sees all the data even on failed checks. Should some failures hide the "Approve" button entirely?

---

## 10. Phase 6 — Reviewer final decision

For everything that is not `auto_approved`, the reviewer renders a final decision. There are four possible actions:

| Action | What the reviewer provides | New case status |
|---|---|---|
| **Approve** | Confirmation (no free text required) | `approved` |
| **Reject** | A reason code + free-text justification (≥ 10 characters) | `rejected` |
| **Escalate** | Free-text notes (≥ 10 characters) + optionally a suggested action | `escalated` |
| **Request info** | A list of items needed (each with category + description, ≥ 1 item) | `info_requested` |

### Audit & immutability
Every decision is written to the audit log as an immutable record. The record carries the user identifier, timestamp, the previous case status, the new case status, and the full payload (reason code, justification, items requested, etc.).

The audit fragment is marked `human_action` and **cannot be edited or deleted by any subsequent run or API call**.

### Terminal states
`approved` and `rejected` are terminal — they remain on the dossier even if a new run produces a different recommendation. A new run will write its updated risk assessment and screening report but **will not overwrite the case status**. The reviewer must explicitly re-open the case (out of scope for v1).

> **Open questions for review**
> - **`Approve` requires no free-text justification.** Reject does, escalate does, request-info does. Is asymmetric justification intentional, or should approvals also carry a one-line rationale for audit?
> - **No two-eyes rule.** A single reviewer can approve, reject, escalate, or request information. Is the target solution single-eyes, or should some tiers require maker-checker?
> - **No re-open flow.** Once a case is `approved` or `rejected`, there is no in-product way to re-open it for periodic review or in light of new information. What is the policy expectation here?
> - **The reviewer's reason codes are a fixed list.** Where should the list be governed?
> - **`request_info` items are free text.** There is no link from a requested item back to where it would fix the dossier (e.g. "missing UBO" → opens the screening tab). Should there be a structured mapping?

---

## 11. Re-run flows — refresh, rescreen, recalculate, recompute

The dossier evolves over time. There are four distinct ways to update it, each touching a different part of the pipeline.

| Flow | What it re-runs | What it preserves | Typical use case |
|---|---|---|---|
| **Refresh** | Everything (registry, documents, OCR, screening, risk, QA) | Previous runs; reviewer overrides if explicitly carried-forward | "It's been a year, run the case again from scratch." |
| **Rescreen** | Screening, risk, QA — using **cached** registry data and documents | Previous runs, registry, documents, KYC card | "Sanctions list was updated; re-screen against the new list." |
| **Recalculate risk** | Risk only — replays the latest run's data against the *currently active* matrix | Everything else | "We changed the matrix; what does the latest run look like now?" |
| **Recompute QA** | QA only — re-evaluates the gates against the same data | Everything else | "We changed the QA rules; what would the routing be now?" |

All four flows append to the dossier's run history. None of them silently overwrite a terminal case status.

### Cached vs. fresh registry data
**Important to understand:** *rescreen* uses cached Companies House data. If the company's officers or PSCs have changed at the registry but no full *refresh* has been done, *rescreen* will work from stale officers/PSCs.

### Latest-only screening
There is no historical re-screen — every screening run uses whatever is currently in the local sanctions store. We do not "screen against the list as of X date".

> **Open questions for review**
> - **Four update flows is a lot.** Will the analyst understand which to use when? Is there a need for a single "smart update" button that picks the right flow?
> - **There is no scheduled or automatic refresh trigger.** A dossier could stay stale indefinitely unless the analyst manually refreshes. What is the target operating cadence for ongoing monitoring?
> - **Rescreen on stale registry data is a real failure mode.** A company added a sanctioned individual as a director three months ago; if we have not refreshed, our latest rescreen will not see them. Should rescreen be allowed only after a recent refresh?
> - **There is no incremental update** ("just refresh the filings, not everything"). Is that a real gap or a non-issue?
> - **Historical sanctions list versioning is out of scope.** We cannot answer "what would screening have shown if we'd run it on the lists as of January?" Is this OK for v1?

---

## 12. Overrides and the audit trail

The system makes many sub-decisions during a run: which entity matched, which sanctions hits are real, which adverse-media articles are relevant, what the risk tier should be. The analyst can override each of these.

### Per-hit override (per run)
On any sanctions hit or adverse-media article, the analyst can:
- Mark a hit `confirmed` that the LLM had `dismissed`.
- Mark a hit `dismissed` that the LLM had `confirmed` or marked `needs_review`.
- Clear an override (restore the LLM's call).

The LLM's original evaluation **is preserved** — overrides are layered on top, not replacing the original record. The screening report's overall risk is then re-derived using the override-adjusted hits.

### Per-dossier carry-forward
After an analyst has overridden hits on a run, they can apply a single action: **"carry these overrides forward"**. This copies the current overrides into the dossier's permanent override table; on future runs (refresh / rescreen), the same hits get the same override automatically. The LLM still runs (audit trail), but the override decides the final status.

### Audit log
The Audit Log page shows:
- Every reviewer final-decision action (`approve` / `reject` / `escalate` / `request_info`).
- (Optionally, when filtered) every decision fragment ever recorded — every machine decision is also there.

Each row links back to the dossier and the run that produced it. `human_action` fragments are immutable.

> **Open questions for review**
> - **Per-hit overrides have no structured reason field.** An analyst can set the override and optionally type a reason; there is no taxonomy of *why* an override is appropriate. Should there be?
> - **Carry-forward is dossier-level, not "list-level".** If the analyst decides "this John Smith is not the sanctioned John Smith", that judgement is recorded only on this dossier — if the same person appears on another dossier, they're a hit again. Should there be a global "known-not-this-person" list?
> - **No second-line review of overrides.** An analyst can override any LLM call and immediately use it as audit-trail-of-record. Should overrides be subject to maker-checker?
> - **Override governance.** Who is allowed to override what? Today: anyone with access. Is that the target?
> - **Audit log retention.** No retention policy is configured. What is required by the business?
> - **The LLM's original judgement is preserved, but the prompt used to produce it is not snapshotted on the hit record.** Re-running with a new prompt version may give a different result. Should each evaluation snapshot the prompt version it used?

---

## 13. Admin and governance processes

The Settings page hosts three governance functions. They are open to anyone with access today (no permissions model).

### 13.1 Risk matrix governance
- **What it is:** the configurable file that defines per-country risk scores, per-entity-type scores, per-SIC-prefix scores, weights, tier thresholds, and knockout rules.
- **Edit flow:** the policy owner opens the matrix as JSON in the Settings page, makes changes, validates, and saves as a **new version**. Versions are append-only. A separate "activate" action makes a version the live one.
- **What is recorded:** every risk receipt records the matrix version it was calculated against. Activating a new matrix does not retroactively change past runs.
- **Recalculate flow:** after activating a new matrix, the policy owner can use *Recalculate risk* on a dossier to see the latest run under the new matrix. This does not create a new run; it rewrites the latest run's risk assessment in place.

### 13.2 Prompt registry
- **What it is:** the LLM instructions used at every step of the pipeline (synthesis, document extraction by category, OCR-page instruction, hit evaluation prompts, risk rationale, country normalisation).
- **Edit flow:** the prompt owner opens a prompt in the Settings page, edits, saves as a **new version**, activates.
- **What is recorded:** the active version is loaded on each call. Changing a prompt does not retroactively change past runs.
- **What is *not* recorded:** the specific prompt version used by a given evaluation is **not** snapshotted on the evaluation record. (See open question in §12.)

### 13.3 Sanctions list refresh
- **What it is:** a command-line operation that fetches the latest OFAC SDN and UK HMT lists from their official sources, parses them, and writes them to the local sanctions store.
- **Edit flow:** today, **a person at a keyboard** runs `npm run lists:refresh`. There is no automated schedule.
- **What is recorded:** each list source has a version and a "fetched at" timestamp shown on the Settings page.

### 13.4 Screening configuration (singleton)
A single record holds the global matching threshold (0.85) and a few small configuration values. Editable from the Settings page.

> **Open questions for review**
> - **No permissions.** Anyone using the tool can change the risk matrix, edit prompts, refresh lists, or change the matching threshold. Is that acceptable?
> - **No approval workflow for matrix / prompt changes.** New versions can be activated immediately by the same person who wrote them. Should activation require a different approver?
> - **List refresh is manual.** It needs to be scheduled and monitored. What cadence does policy require? How do we alert if a refresh fails or the source format changes?
> - **No staging environment** for changes. A new matrix or prompt version goes live immediately for the next run. Should there be a sandbox / preview mode?
> - **Single global threshold.** Per the §7 question — should this be per-list or name-rarity-aware?
> - **Prompt-version snapshotting on evaluations** would let us reproduce any historical machine decision exactly. Is that a hard audit requirement?

---

## 14. Known limitations and explicit out-of-scope items

The following are *deliberately* not in v1 of the POC. Each is a candidate for the target solution.

| Area | What's missing |
|---|---|
| **PEP screening** | No data source chosen, no implementation. |
| **Recursive ownership-chain walking** | We screen the immediate PSCs, not the people behind a corporate PSC. |
| **Authorized signatories** | Not collected. |
| **Historical sanctions versioning** | We can't say "what would the screening have looked like 6 months ago?". |
| **Multi-language name matching** | Latin script only. No transliteration normalisation. |
| **LLM-generated aliases for matching** | Only the aliases on the sanctions list itself are matched. |
| **Two-eyes / maker-checker** | No second-line approval at any step. |
| **Permissions / multi-user** | Single user. No auth. |
| **Periodic review triggers** | No alerts when a dossier should be re-run. |
| **Screening included in run-diff view** | The diff view compares the KYC card across runs but not the screening report. |
| **iXBRL parsing** | Accounts data comes from PDF OCR. |
| **Vector / semantic similarity** | Not used anywhere (matching, retrieval, or otherwise). |
| **Production observability** | No metrics, no dashboards, no SLO tracking. |
| **Retry / backoff** | One retry on a malformed JSON extraction; no other resilience infrastructure. |

---

## 15. Cross-cutting observations and improvement candidates

Beyond the section-by-section open questions, the following themes seem worth a focused discussion with the business process owner.

### 15.1 Where the LLM is — and isn't — used
LLMs are used for: document extraction (per category), KYC card synthesis, sanctions hit evaluation, adverse-media article evaluation, country normalisation on a miss, risk rationale generation.

LLMs are **not** used for: entity resolution (deterministic only), risk scoring (deterministic — only the rationale is LLM-generated), QA checks (pure engine), document selection (rule-based), name matching (string-similarity algorithm).

This split is mostly correct — but worth a deliberate review with the business: are there steps where the LLM is doing too much (e.g. sole evaluator on a hit, with a headline only)? Are there steps where it should be doing more (e.g. entity-resolution tie-breaks, ambiguous-document interpretation)?

### 15.2 Governance maturity
Several pieces are in place: versioned matrix, versioned prompts, append-only audit fragments, immutable human-action records. Several pieces are not: permissions, approval workflows for config changes, automated list refresh, retention policy, two-eyes on decisions, periodic review triggers.

A clear maturity-curve discussion (which gaps must be closed before pilot? Which can wait?) would help prioritise.

### 15.3 The "auto-approve" question
The single biggest policy decision baked into the current solution is **the existence of auto-approval at all**. A Low-risk, all-checks-passed case can complete with the analyst's only intervention being the entity confirmation at the start. Whether this is acceptable depends entirely on the business's risk appetite — but it should be a conscious choice, not a default.

### 15.4 The "what's a subject" question
Subjects are the company, officers, PSCs, and extracted shareholders. They are **not**:
- Beneficial owners further up the chain.
- Authorized signatories.
- Resigned officers.
- The company's customers, counterparties, or group affiliates.

For a real KYC programme, the definition of *subject* is a foundational policy decision. The current scope is narrow but explicit — confirming or extending it would change what the system needs to do everywhere downstream.

### 15.5 Data freshness
Three data sources go stale at different rates: registry data (changes whenever the company files), sanctions lists (changes weekly or more), adverse media (changes daily). The system has different freshness mechanisms for each (cache, manual refresh, 12-month window) but no single coherent "as-of" model. A unified freshness story would make audit easier ("on date X, the dossier was built using registry data as of A, sanctions list as of B, adverse media spanning C–D").

### 15.6 Reviewer ergonomics
The reviewer screen surfaces the KYC card, the screening evidence, the risk receipt, the QA findings, and the decision controls. As features grew the UI has accumulated layers. A walkthrough with an actual reviewer — *can you get to a decision in N minutes? what blocks you?* — would surface concrete pain points the development team can't see from the inside.

---

## 16. Appendix — quick reference

### 16.1 Case status states
- `pending` — created, not yet QA-routed.
- `auto_approved` — QA passed + risk Low.
- `streamlined_review` — QA passed + risk Medium.
- `standard_review` — QA failed, or QA passed + risk High.
- `approved` / `rejected` — terminal, reviewer-rendered.
- `escalated` / `info_requested` — non-terminal, reviewer-rendered.

### 16.2 Hit evaluation states
- `confirmed` — the LLM believes this is a real match.
- `dismissed` — the LLM believes this is a false positive.
- `needs_review` — insufficient information to judge.

### 16.3 Override states
- Per-hit: any of `confirmed` / `dismissed` / `null` (no override).
- Per-dossier: a saved set of (hit-identifier → override) pairs that auto-apply on future runs.

### 16.4 Risk tier and outcome
- Tier: `Low` / `Medium` / `High`.
- Outcome: `Approve` / `EnhancedDueDiligence` / `Prohibited`.
- Tier maps to outcome via matrix thresholds; knockouts can override.

---

*End of document. Please raise comments, disagreements, or additional concerns on this draft before the review session.*
