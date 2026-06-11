#!/usr/bin/env node
// LLM provider smoke. Prints the resolved provider+model per task, pings
// checkProviders(), and does one tiny structured-output round-trip against
// whatever's configured. Fast sanity check before a 30-minute Companies House run.
//
//   npm run llm:smoke
//
// Covers the `ollama` path out of the box; with `LLM_REASONING_PROVIDER=nvidia`
// (plus a real `nvapi-` key) it exercises the NVIDIA NIM reasoning path and
// surfaces a clear error if the key is missing or rejected.
require('dotenv').config();

const { z } = require('zod');
const { resolveTask, TASKS } = require('../services/llm/config');
const { checkProviders, extractStructured } = require('../services/llm');
const { pool } = require('../db/client');

let failures = 0;
function ok(msg) {
  console.log(`  ok   ${msg}`);
}
function fail(msg) {
  console.error(`  FAIL ${msg}`);
  failures += 1;
}

async function main() {
  console.log('[llm-smoke] resolved config:');
  for (const task of TASKS) {
    try {
      const cfg = resolveTask(task);
      let extra = cfg.baseUrl ? ` baseUrl=${cfg.baseUrl}` : '';
      if (cfg.provider === 'nvidia') {
        extra += ` apiKey=${cfg.apiKey ? 'present' : 'MISSING'}`;
        if (task === 'reasoning') extra += ` structuredMethod=${cfg.structuredMethod}`;
        if (task === 'ocr') extra += ` ocrEndpoint=${cfg.ocrEndpoint || '(unset — P3)'}`;
      }
      console.log(`  ${task.padEnd(9)} provider=${cfg.provider} model=${cfg.model}${extra}`);
    } catch (err) {
      // resolveTask throws a clear startup error for an unknown provider or a
      // `nvidia` task with no NVIDIA_API_KEY — make it loud here.
      fail(`resolveTask('${task}') threw: ${err.message}`);
    }
  }

  console.log('[llm-smoke] provider health:');
  const health = await checkProviders();
  console.log(JSON.stringify(health, null, 2));
  if (health.ocr?.ok) ok('ocr provider reachable');
  else fail(`ocr provider not reachable: ${health.ocr?.detail}`);
  if (health.reasoning?.ok) ok('reasoning provider reachable');
  else fail(`reasoning provider not reachable: ${health.reasoning?.detail}`);
  for (const task of TASKS) {
    for (const m of health[task]?.missing || []) fail(`${task} model missing: ${m}`);
  }

  console.log('[llm-smoke] structured round-trip (reasoning provider):');
  try {
    const Schema = z.object({ ok: z.boolean(), word: z.string() });
    const out = await extractStructured(
      'Set ok to true and word to "pong".',
      Schema,
      'You are a test harness. Return JSON only, matching the requested schema.'
    );
    if (out && typeof out.word === 'string' && typeof out.ok === 'boolean') {
      ok(`structured output: ${JSON.stringify(out)}`);
    } else {
      fail(`unexpected structured output: ${JSON.stringify(out)}`);
    }
  } catch (err) {
    // A bad/missing NVIDIA_API_KEY shows up here as an auth error or a config throw.
    fail(`extractStructured threw: ${err.message}`);
  }

  console.log(`[llm-smoke] ${failures === 0 ? 'all checks passed' : `${failures} FAILED`}`);
  if (failures) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error('[llm-smoke] crashed:', err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
