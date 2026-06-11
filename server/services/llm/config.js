// Single source of truth for which LLM backend each task uses.
//
// resolveTask('ocr' | 'reasoning') → { task, provider, model, baseUrl?, apiKey?, ocrEndpoint?, structuredMethod? }
//
// Provider selection (per task, env-driven, restart to apply):
//   LLM_OCR_PROVIDER / LLM_REASONING_PROVIDER  →  LLM_PROVIDER  →  'ollama'
//
// An unset / fully-commented .env behaves exactly as before: Ollama for both tasks.
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const VALID_PROVIDERS = ['ollama', 'nvidia'];
const TASKS = ['ocr', 'reasoning'];

function firstNonEmpty(...vals) {
  for (const v of vals) {
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return undefined;
}

function ollamaHost() {
  return (process.env.OLLAMA_HOST || 'http://127.0.0.1:11434').replace('://localhost', '://127.0.0.1');
}

function resolveTask(task) {
  if (!TASKS.includes(task)) {
    throw new Error(`resolveTask: unknown task "${task}" (expected one of: ${TASKS.join(', ')})`);
  }

  const taskVar = task === 'ocr' ? 'LLM_OCR_PROVIDER' : 'LLM_REASONING_PROVIDER';
  const provider = (firstNonEmpty(process.env[taskVar], process.env.LLM_PROVIDER) || 'ollama').toLowerCase();

  if (!VALID_PROVIDERS.includes(provider)) {
    throw new Error(
      `LLM config: unknown provider "${provider}" for ${task} task — set ${taskVar} (or LLM_PROVIDER) to one of: ${VALID_PROVIDERS.join(', ')}`
    );
  }

  if (provider === 'ollama') {
    const model =
      task === 'ocr'
        ? process.env.OLLAMA_OCR_MODEL || 'glm-ocr'
        : process.env.OLLAMA_REASONING_MODEL || 'llama3.1:8b';
    return { task, provider, model, baseUrl: ollamaHost() };
  }

  // provider === 'nvidia'
  const apiKey = firstNonEmpty(process.env.NVIDIA_API_KEY);
  if (!apiKey) {
    throw new Error(
      `LLM config: ${task} task provider is "nvidia" but NVIDIA_API_KEY is not set in server/.env`
    );
  }
  const baseUrl = process.env.NVIDIA_BASE_URL || 'https://integrate.api.nvidia.com/v1';

  if (task === 'ocr') {
    return {
      task,
      provider,
      model: process.env.NVIDIA_OCR_MODEL || 'nvidia/nemoretriever-ocr-v2',
      baseUrl,
      apiKey,
      ocrEndpoint: firstNonEmpty(process.env.NVIDIA_OCR_ENDPOINT) || null,
    };
  }

  return {
    task,
    provider,
    model: process.env.NVIDIA_REASONING_MODEL || 'meta/llama-3.1-8b-instruct',
    baseUrl,
    apiKey,
    structuredMethod: process.env.NVIDIA_STRUCTURED_METHOD || 'functionCalling',
  };
}

module.exports = { resolveTask, VALID_PROVIDERS, TASKS };
