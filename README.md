# SentinelKYC

Agentic KYC (Know Your Customer) for UK companies — with a complete, reviewable audit trail.

SentinelKYC resolves a company against the Companies House register, pulls its filings, runs OCR and structured extraction over them, screens every identified party (officers, PSCs, shareholders) against sanctions lists (OFAC SDN, UK HMT) and live adverse media, computes a deterministic weighted-factor risk assessment, QA-gates the case, and routes it — auto-approving low-risk cases and pausing for a human reviewer otherwise. Every LLM decision is persisted as an inspectable, overridable decision fragment; successive runs can be diffed.

> **Status**: transitioning from a validated proof of concept to v0.1. Expect rapid restructuring. The architecture target is a suite of independently deployable agents (entity resolution, UBO/ownership structure, document management, screening, risk, QA) behind a pluggable data-vendor layer.

## Highlights

- **Human-in-the-loop by design** — two graph interrupts (entity confirmation, final decision); reviewers can override any screening hit or LLM judgement, with an immutable audit log.
- **Cross-dossier party master** — every officer/PSC/shareholder is resolved into a master record, so "the same John Smith on three dossiers" is one screened identity.
- **Deterministic where it matters** — entity scoring, screening risk rules, the risk matrix, and QA routing are pure engines; LLMs draft rationales and judge hits, they never decide alone.
- **Local-first LLMs** — Ollama (vision OCR + reasoning) by default, hosted NVIDIA NIM as a per-task alternative, via a pluggable provider abstraction.

## Stack

Vue 3 + Vite + Pinia + Cytoscape.js · Node.js + Express 5 + LangGraph.js · Postgres (Drizzle ORM) + pg-boss · Ollama / NVIDIA NIM.

## Getting started

Prerequisites: Node ≥ 20.19, native PostgreSQL ≥ 16 (see [server/db/SETUP.md](server/db/SETUP.md)), [Ollama](https://ollama.com) with `glm-ocr` and `llama3.1:8b` pulled, and a free [Companies House API key](https://developer.company-information.service.gov.uk/).

```bash
# 1. configure
cp server/.env.example server/.env   # fill in CH_API_KEY, DATABASE_URL, SESSION_SECRET, seed passwords

# 2. database (one-time)
cd server && npm install
npm run db:migrate
npm run lists:refresh      # load OFAC SDN + UK HMT sanctions lists
npm run users:seed         # create analyst / reviewer / admin users

# 3. run
npm run dev                # API on :3000
cd ../web && npm install && npm run dev   # UI on :5173 (proxies /api)
```

```bash
# tests
cd server
npm test            # node-only smoke tier (no DB / LLM)
npm run smoke:all   # + Postgres tier
npm run smoke:full  # + LLM / Companies House / booted-app tier
npm run eval        # golden-set quality scoring for LLM steps
```

## Documentation

| Doc | Contents |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | Authoritative system architecture + improvement backlog |
| [BUSINESS_PROCESS.md](BUSINESS_PROCESS.md) | Case lifecycle and business view |
| [SCREENING_PLAN.md](SCREENING_PLAN.md) | Screening subsystem design |
| [server/db/SETUP.md](server/db/SETUP.md) | One-time native Postgres setup |

(Documentation is being restructured into `docs/` as part of the v0.1 effort.)

## License

[The Unlicense](LICENSE) — public domain.
