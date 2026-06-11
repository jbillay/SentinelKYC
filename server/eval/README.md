# Eval harness (R3)

A small, frozen golden-set harness that scores the LLM-judgement quality of the
pipeline so prompt changes stop being blind changes. It calls the **exact
production code paths** — `extractStructured` with the real extractor
schema/prompt, and the screening evaluators factored into
`services/screening/evaluate{Sanctions,AdverseMedia}Hit.js` (the graph nodes call
the same functions).

It is **not** a general test framework (CLAUDE.md warns against that). The corpus
is deliberately small (~3–10 cases per type) and offline.

## Layout

```
eval/
  golden/
    extraction/      *.json — frozen OCR/text + known-correct extracted records
    sanctions/       *.json — subject + sanctions entry + known confirm/dismiss truth
    adverse_media/   *.json — subject + article + known relevance/category/severity
  labels.schema.js   Zod schemas — a malformed golden case fails fast (the gate)
  score.js           pure scoring (no I/O): extraction P/R/F1 + field/exact,
                     sanctions confusion + confirmed P/R/F1, adverse-media acc + cat F1
  run.js             CLI runner: load corpus → call production path → score → report
```

## Commands

```bash
npm run eval                      # all types, active prompts → JSON report + human summary
npm run eval -- --type sanctions  # one type
npm run eval -- --json out/report.json
npm run eval:ab -- screening.evaluate_sanctions_hit=42
                                  # A/B: score prompt version 42 vs the active baseline (per-metric delta)
npm run eval:score-smoke          # pure scorer + corpus-validity smoke (node-only, always runnable)
npm run eval:smoke                # integration smoke (needs Postgres + reasoning LLM)
```

Requirements: `npm run eval` and `eval:smoke` need `DATABASE_URL` (prompt
registry) and a reachable reasoning LLM (Ollama by default). `eval:score-smoke`
needs neither.

## A/B a candidate prompt before activation

1. Create a new prompt version in the registry (Settings UI or
   `POST /api/prompts/:key/versions`) — note its `versionId`.
2. `npm run eval:ab -- <key>=<versionId>` — the runner scores the candidate
   against the active baseline and prints a per-metric delta.
3. Only `setActive` the version if the delta is favourable.

## Adding a golden case

Drop a `*.json` file in the matching `golden/<type>/` directory following the
shape in `labels.schema.js`. `eval:score-smoke` validates every committed case,
so a malformed file fails the smoke immediately. Keep inputs small and synthetic
(no real PII in sanctions/adverse-media subjects).
