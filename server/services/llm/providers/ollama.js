// Ollama LLM provider — today's behaviour, unchanged, behind the provider interface.
//
//   { id, ocr({ imageBytes, prompt, model, baseUrl }),
//        chatStructured({ input, schema, prompt, model, temperature, baseUrl }),
//        health({ model, baseUrl }) }
//
// Keeps verbatim: glm-ocr's num_ctx:16384; the long-timeout undici Agent (headers/body
// timeouts disabled — some OCR pages take many minutes); stream:true for OCR (Ollama
// withholds headers until first token); retry-once on ECONNRESET / UND_ERR_HEADERS_TIMEOUT;
// the localhost → 127.0.0.1 rewrite (Ollama listens IPv4-only); the /api/tags probe.
//
// The extract.json_strict_retry wrapper lives in ../index.js so every provider gets it.
const { Ollama } = require('ollama');
const { Agent, fetch: undiciFetch } = require('undici');
const { ChatOllama } = require('@langchain/ollama');
const { log } = require('../../log');

const longTimeoutAgent = new Agent({
  headersTimeout: 0,
  bodyTimeout: 0,
  connectTimeout: 30 * 1000,
  keepAliveTimeout: 60 * 1000,
  keepAliveMaxTimeout: 10 * 60 * 1000,
  pipelining: 0,
});

const longFetch = (url, init = {}) => undiciFetch(url, { ...init, dispatcher: longTimeoutAgent });

function isFetchError(err) {
  if (!err) return false;
  if (err.message === 'fetch failed') return true;
  const code = err.cause?.code || err.code;
  return code === 'ECONNRESET' || code === 'UND_ERR_SOCKET' || code === 'UND_ERR_HEADERS_TIMEOUT';
}

function hostFor(baseUrl) {
  return (baseUrl || process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace(
    '://localhost',
    '://127.0.0.1'
  );
}

async function runOcrOnce(client, model, imageBytes, prompt) {
  const stream = await client.generate({
    model,
    prompt,
    images: [imageBytes],
    stream: true,
    options: { num_ctx: 16384 },
  });

  let text = '';
  for await (const chunk of stream) {
    if (chunk.response) text += chunk.response;
  }
  return text;
}

async function ocr({ imageBytes, prompt, model, baseUrl }) {
  if (!prompt) throw new Error('llm/ollama: ocr.prompt is required (loaded by ../index.js#ocrPage)');
  const client = new Ollama({ host: hostFor(baseUrl), fetch: longFetch });
  try {
    return await runOcrOnce(client, model, imageBytes, prompt);
  } catch (err) {
    if (!isFetchError(err)) throw err;
    log.warn(`[llm/ollama] OCR retry after ${err.message} (cause=${err.cause?.code})`);
    return await runOcrOnce(client, model, imageBytes, prompt);
  }
}

async function chatStructured({ input, schema, prompt, model, temperature = 0, baseUrl, signal }) {
  const chat = new ChatOllama({
    model,
    baseUrl: hostFor(baseUrl),
    temperature,
    fetch: longFetch,
    format: 'json',
  });
  const userMessage = `${prompt}\n\n--- INPUT ---\n${input}\n--- END INPUT ---`;
  // signal: per-call timeout/abort from ../index.js — a wedged Ollama must
  // fail the node instead of hanging it forever (CODE_REVIEW §4.5).
  return chat.withStructuredOutput(schema).invoke(userMessage, signal ? { signal } : undefined);
}

async function health({ model, baseUrl }) {
  const host = hostFor(baseUrl);
  try {
    const res = await undiciFetch(`${host}/api/tags`, {
      dispatcher: new Agent({ headersTimeout: 3000, bodyTimeout: 3000, connectTimeout: 3000 }),
    });
    if (!res.ok) {
      return { ok: false, host, detail: `HTTP ${res.status}`, installed: [], missing: model ? [model] : [] };
    }
    const data = await res.json();
    const installed = (data?.models || []).map((m) => m.name);
    const present = !model || installed.some((i) => i === model || i.startsWith(`${model}:`));
    return {
      ok: true,
      host,
      installed,
      missing: present ? [] : [model],
      detail: present ? 'ready' : `model "${model}" not installed`,
    };
  } catch (err) {
    return {
      ok: false,
      host,
      installed: [],
      missing: model ? [model] : [],
      detail: err.cause?.code || err.message || 'unreachable',
    };
  }
}

module.exports = { id: 'ollama', ocr, chatStructured, health };
