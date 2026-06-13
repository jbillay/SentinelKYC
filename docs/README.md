# SentinelKYC documentation

## Architecture (live)

| Doc | Contents |
|---|---|
| [ARCHITECTURE.md](architecture/ARCHITECTURE.md) | Authoritative system-architecture view + consolidated improvement backlog |
| [SCREENING_PLAN.md](architecture/SCREENING_PLAN.md) | Screening subsystem design (sanctions, adverse media, overrides) |
| [IMPLEMENTATION.md](architecture/IMPLEMENTATION.md) | Phase tracker; detailed risk-assessment ("Phase 3") and QA/decision ("Phase 5") design |
| [entity-resolution.md](architecture/entity-resolution.md) | Per-run entity confirmation scoring |
| [server/db/SETUP.md](../server/db/SETUP.md) | One-time native Postgres setup (Windows) |
| [server/eval/README.md](../server/eval/README.md) | R3 eval harness — golden-set quality scoring |
| [CI.md](CI.md) | CI gate (`ci.yml`) + label-driven auto-merge + branch ruleset |

## Business

| Doc | Contents |
|---|---|
| [BUSINESS_PROCESS.md](business/BUSINESS_PROCESS.md) | Case lifecycle and business-process view |

## Archive (point-in-time, historical)

Executed build plans and code reviews kept for traceability. Section citations
in code comments (e.g. `CODE_REVIEW §6.4`, `P0_IMPLEMENTATION_PLAN.md §R2`)
refer to these files.

| Doc | Was |
|---|---|
| [P0_IMPLEMENTATION_PLAN.md](archive/P0_IMPLEMENTATION_PLAN.md) | P0 backlog build plan (R0 docs, R1 auth, R3 eval harness, R2 durable runs) |
| [P1_IMPLEMENTATION_PLAN.md](archive/P1_IMPLEMENTATION_PLAN.md) | P1 backlog build plan |
| [P1_EXECUTION_PLAN.md](archive/P1_EXECUTION_PLAN.md) | P1 execution sequencing |
| [CODE_REVIEW.md](archive/CODE_REVIEW.md) | Full-codebase review (pre-P0) |
| [CODE_REVIEW_2026-05-15.md](archive/CODE_REVIEW_2026-05-15.md) | Follow-up review, 2026-05-15 |
