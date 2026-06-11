// Public LLM API — the only thing the rest of the codebase imports.
//
// Same signatures as the old services/ollama.js so callers don't change beyond
// the require path:
//   ocrPage(imagePath, { force, forceFresh })  → { text, cached, hash }
//   extractStructured(input, zodSchema, prompt, opts)  → parsed object
//   checkProviders()  → { ok, ocr:{…}, reasoning:{…} }
//
// Everything provider-agnostic lives here: the OCR file-read + kv_cache cache
// (key now provider+model-suffixed), the extract.json_strict_retry retry wrapper,
// forceFresh plumbing. Per-task provider selection comes from ./config.
const fsp = require('fs/promises');

const { kvGet, kvSet } = require('../cache');
const { fileHash } = require('../pdf');
const { loadPrompt } = require('../prompts');
const { resolveTask } = require('./config');
const metrics = require('../metrics');

const PROVIDERS = {
  ollama: require('./providers/ollama'),
  nvidia: require('./providers/nvidia'),  // reasoning in P2; OCR half lands in P3
};

function providerFor(id) {
  const p = PROVIDERS[id];
  if (!p) throw new Error(`LLM: provider "${id}" is not implemented yet`);
  return p;
}

async function ocrPage(imagePath, { force = false, forceFresh = false } = {}) {
  const cfg = resolveTask('ocr');
  const provider = providerFor(cfg.provider);
  const skipCache = force || forceFresh;

  const hash = await fileHash(imagePath);
  const cacheKey = `${hash}:${cfg.provider}:${cfg.model}`;

  if (!skipCache) {
    const cached = kvGet('ocr', cacheKey);
    if (cached) {
      metrics.inc('cache_hit_total', { cache: 'ocr' });
      return { text: cached.text, cached: true, hash };
    }
  }
  metrics.inc('cache_miss_total', { cache: 'ocr' });

  // Load the per-page OCR prompt at the boundary, not inside the provider, so
  // the prompt registry remains the single read path and providers stay
  // unaware of it. NVIDIA's nemoretriever ignores the prompt — that asymmetry
  // is real and expressed at the boundary (we pass it anyway; the provider
  // chooses whether to use it). See CODE_REVIEW §4.1.
  const ocrPrompt = await loadPrompt('ocr.page');

  const imageBytes = await fsp.readFile(imagePath);
  const t0 = Date.now();
  const text = await provider.ocr({
    imageBytes,
    prompt: ocrPrompt,
    model: cfg.model,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    ocrEndpoint: cfg.ocrEndpoint,
  });
  metrics.observe('llm_latency_ms', Date.now() - t0, { task: 'ocr', provider: cfg.provider });

  kvSet('ocr', cacheKey, { text, provider: cfg.provider, model: cfg.model });
  return { text, cached: false, hash };
}

// Per-call ceiling for a single structured-extraction generation. Generous —
// local reasoning models can legitimately take minutes — but finite: a wedged
// provider must fail the node, not hang it (and in queue mode burn the job
// until pg-boss's 2h expiry). Override via LLM_CALL_TIMEOUT_MS. §4.5.
const LLM_CALL_TIMEOUT_MS = Number(process.env.LLM_CALL_TIMEOUT_MS || 10 * 60 * 1000);

// Only output-shaped failures deserve the json_strict_retry second attempt —
// a stricter prompt cannot fix a network error or a timeout, and re-running a
// multi-minute generation on those just doubles the damage. §4.5.
function isRetryableExtractError(err) {
  if (!err) return false;
  if (err.name === 'AbortError' || err.name === 'TimeoutError') return false;
  if (err.message === 'fetch failed') return false;
  const code = err.cause?.code || err.code;
  if (code === 'ECONNRESET' || code === 'ECONNREFUSED' || code === 'UND_ERR_SOCKET' || code === 'UND_ERR_HEADERS_TIMEOUT' || code === 'ABORT_ERR') {
    return false;
  }
  if (err.name === 'ZodError' || /OutputParser/i.test(err.constructor?.name || '')) return true;
  return /json|parse|schema|validat|structured output|tool call|function call/i.test(err.message || '');
}

async function extractStructured(input, zodSchema, prompt, opts = {}) {
  const cfg = resolveTask('reasoning');
  const provider = providerFor(cfg.provider);

  const args = {
    input,
    schema: zodSchema,
    prompt,
    model: opts.model || cfg.model,
    temperature: opts.temperature ?? 0,
    baseUrl: cfg.baseUrl,
    apiKey: cfg.apiKey,
    structuredMethod: cfg.structuredMethod,
  };

  const t0 = Date.now();
  try {
    return await provider.chatStructured({ ...args, signal: AbortSignal.timeout(LLM_CALL_TIMEOUT_MS) });
  } catch (err) {
    if (!isRetryableExtractError(err)) throw err;
    metrics.inc('llm_extract_retry_total', { provider: cfg.provider });
    const strictPrefix = await loadPrompt('extract.json_strict_retry');
    return await provider.chatStructured({
      ...args,
      prompt: `${strictPrefix}${prompt}`,
      signal: AbortSignal.timeout(LLM_CALL_TIMEOUT_MS),
    });
  } finally {
    metrics.observe('llm_latency_ms', Date.now() - t0, { task: 'reasoning', provider: cfg.provider });
  }
}

async function checkProviders() {
  const out = {};
  for (const task of ['ocr', 'reasoning']) {
    try {
      const cfg = resolveTask(task);
      const provider = providerFor(cfg.provider);
      const h = await provider.health({
        task,
        model: cfg.model,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        ocrEndpoint: cfg.ocrEndpoint,
      });
      out[task] = { provider: cfg.provider, model: cfg.model, ...h };
    } catch (err) {
      out[task] = { provider: 'unknown', model: null, ok: false, detail: err.message || 'config error' };
    }
  }
  out.ok = !!(out.ocr?.ok && out.reasoning?.ok);
  return out;
}

module.exports = { ocrPage, extractStructured, checkProviders };
