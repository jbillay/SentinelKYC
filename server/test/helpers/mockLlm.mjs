// Test helper — a deterministic stand-in for services/llm.
//
// The LLM is the one boundary we never call for real in CI (no Ollama on the
// runners). This builds a mock with the exact public surface of
// services/llm/index.js — ocrPage / extractStructured / checkProviders — so
// node, extractor, and route tests exercise the deterministic logic AROUND the
// model without depending on it. See docs/architecture/TEST_STRATEGY.md §5.1.
//
// vi.mock is hoisted, so install it at the top of a test file like this:
//
//   import { vi } from 'vitest';
//   import { createLlmMock } from './helpers/mockLlm.js';
//   const llm = createLlmMock({
//     extract: { 'kyc.synthesis': { identity: { name: 'ACME LTD' } } },
//   });
//   vi.mock('../services/llm', () => llm.module);   // CJS path the code requires
//
// Then assert against llm.calls / llm.extractStructured.mock in the test body.
import { vi } from 'vitest';

/**
 * @param {object} [opts]
 * @param {Record<string, any> | ((input:any, schema:any, prompt:string)=>any)} [opts.extract]
 *   Scripted extractStructured responses. A function gets (input, schema, prompt)
 *   and returns the parsed object. An object is keyed by a substring of the
 *   prompt — the first key found in the prompt wins; `default` is the fallback.
 * @param {string|((imagePath:string)=>string)} [opts.ocr]  OCR text to return.
 * @param {boolean} [opts.healthy]  checkProviders().ok value (default true).
 */
export function createLlmMock(opts = {}) {
  const { extract = {}, ocr = 'mock ocr text', healthy = true } = opts;
  const calls = { ocrPage: [], extractStructured: [], checkProviders: [] };

  function resolveExtract(input, schema, prompt) {
    if (typeof extract === 'function') return extract(input, schema, prompt);
    const key = Object.keys(extract).find((k) => k !== 'default' && String(prompt).includes(k));
    if (key) return extract[key];
    if ('default' in extract) return extract.default;
    return {}; // benign empty object — caller can override
  }

  const ocrPage = vi.fn(async (imagePath, _o = {}) => {
    calls.ocrPage.push({ imagePath });
    const text = typeof ocr === 'function' ? ocr(imagePath) : ocr;
    return { text, cached: false, hash: 'mockhash' };
  });

  const extractStructured = vi.fn(async (input, schema, prompt, _o = {}) => {
    calls.extractStructured.push({ input, prompt });
    const out = resolveExtract(input, schema, prompt);
    // Mirror the real boundary: validate against the provided zod schema when
    // one is given, so a malformed scripted response fails loudly in tests.
    if (schema && typeof schema.parse === 'function') return schema.parse(out);
    return out;
  });

  const checkProviders = vi.fn(async () => ({
    ok: healthy,
    ocr: { provider: 'mock', model: 'mock', ok: healthy },
    reasoning: { provider: 'mock', model: 'mock', ok: healthy },
  }));

  return {
    calls,
    ocrPage,
    extractStructured,
    checkProviders,
    // Pass straight to vi.mock('../services/llm', () => mock.module)
    module: { ocrPage, extractStructured, checkProviders },
  };
}
