import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { resolveTask, VALID_PROVIDERS, TASKS } from '../services/llm/config.js'

// resolveTask reads process.env at call time, so we snapshot and restore the
// LLM-relevant vars around every test. dotenv has already populated whatever
// server/.env carries; we override explicitly so the assertions are stable.
const LLM_VARS = [
  'LLM_OCR_PROVIDER',
  'LLM_REASONING_PROVIDER',
  'LLM_PROVIDER',
  'OLLAMA_HOST',
  'OLLAMA_OCR_MODEL',
  'OLLAMA_REASONING_MODEL',
  'NVIDIA_API_KEY',
  'NVIDIA_BASE_URL',
  'NVIDIA_OCR_MODEL',
  'NVIDIA_OCR_ENDPOINT',
  'NVIDIA_REASONING_MODEL',
  'NVIDIA_STRUCTURED_METHOD',
]

let saved
beforeEach(() => {
  saved = {}
  for (const k of LLM_VARS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of LLM_VARS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
})

describe('resolveTask — exports', () => {
  it('exposes the valid providers and tasks', () => {
    expect(VALID_PROVIDERS).toEqual(['ollama', 'nvidia'])
    expect(TASKS).toEqual(['ocr', 'reasoning'])
  })
})

describe('resolveTask — guard rails', () => {
  it('throws on an unknown task', () => {
    expect(() => resolveTask('translation')).toThrow(/unknown task/)
  })

  it('throws on an unknown provider', () => {
    process.env.LLM_PROVIDER = 'openai'
    expect(() => resolveTask('reasoning')).toThrow(/unknown provider "openai"/)
  })
})

describe('resolveTask — ollama (default)', () => {
  it('defaults both tasks to ollama with default models when nothing is set', () => {
    const ocr = resolveTask('ocr')
    expect(ocr).toMatchObject({ task: 'ocr', provider: 'ollama', model: 'glm-ocr' })
    expect(ocr.baseUrl).toBe('http://127.0.0.1:11434')

    const reasoning = resolveTask('reasoning')
    expect(reasoning).toMatchObject({ task: 'reasoning', provider: 'ollama', model: 'llama3.1:8b' })
  })

  it('rewrites localhost to 127.0.0.1 in OLLAMA_HOST', () => {
    process.env.OLLAMA_HOST = 'http://localhost:9999'
    expect(resolveTask('ocr').baseUrl).toBe('http://127.0.0.1:9999')
  })

  it('honours explicit ollama model overrides', () => {
    process.env.OLLAMA_OCR_MODEL = 'custom-ocr'
    process.env.OLLAMA_REASONING_MODEL = 'custom-reason'
    expect(resolveTask('ocr').model).toBe('custom-ocr')
    expect(resolveTask('reasoning').model).toBe('custom-reason')
  })
})

describe('resolveTask — per-task provider precedence', () => {
  it('LLM_OCR_PROVIDER overrides LLM_PROVIDER for the ocr task only', () => {
    process.env.LLM_PROVIDER = 'ollama'
    process.env.LLM_OCR_PROVIDER = 'nvidia'
    process.env.NVIDIA_API_KEY = 'k'
    expect(resolveTask('ocr').provider).toBe('nvidia')
    expect(resolveTask('reasoning').provider).toBe('ollama')
  })

  it('treats a blank/whitespace task var as unset and falls through to LLM_PROVIDER', () => {
    process.env.LLM_REASONING_PROVIDER = '   '
    process.env.LLM_PROVIDER = 'ollama'
    expect(resolveTask('reasoning').provider).toBe('ollama')
  })
})

describe('resolveTask — nvidia', () => {
  it('requires NVIDIA_API_KEY', () => {
    process.env.LLM_PROVIDER = 'nvidia'
    expect(() => resolveTask('reasoning')).toThrow(/NVIDIA_API_KEY is not set/)
  })

  it('returns the ocr shape with default model, base url and null endpoint', () => {
    process.env.LLM_OCR_PROVIDER = 'nvidia'
    process.env.NVIDIA_API_KEY = 'secret'
    const r = resolveTask('ocr')
    expect(r).toMatchObject({
      task: 'ocr',
      provider: 'nvidia',
      model: 'nvidia/nemotron-ocr-v2',
      baseUrl: 'https://integrate.api.nvidia.com/v1',
      apiKey: 'secret',
      ocrEndpoint: null,
    })
  })

  it('honours NVIDIA ocr endpoint + base url overrides', () => {
    process.env.LLM_OCR_PROVIDER = 'nvidia'
    process.env.NVIDIA_API_KEY = 'secret'
    process.env.NVIDIA_BASE_URL = 'https://example.test/v1'
    process.env.NVIDIA_OCR_ENDPOINT = 'https://ocr.example.test'
    process.env.NVIDIA_OCR_MODEL = 'my-ocr'
    const r = resolveTask('ocr')
    expect(r.baseUrl).toBe('https://example.test/v1')
    expect(r.ocrEndpoint).toBe('https://ocr.example.test')
    expect(r.model).toBe('my-ocr')
  })

  it('returns the reasoning shape with default model and structured method', () => {
    process.env.LLM_REASONING_PROVIDER = 'nvidia'
    process.env.NVIDIA_API_KEY = 'secret'
    const r = resolveTask('reasoning')
    expect(r).toMatchObject({
      task: 'reasoning',
      provider: 'nvidia',
      model: 'meta/llama-3.1-8b-instruct',
      structuredMethod: 'functionCalling',
    })
  })

  it('honours a NVIDIA_STRUCTURED_METHOD override', () => {
    process.env.LLM_REASONING_PROVIDER = 'nvidia'
    process.env.NVIDIA_API_KEY = 'secret'
    process.env.NVIDIA_STRUCTURED_METHOD = 'jsonMode'
    expect(resolveTask('reasoning').structuredMethod).toBe('jsonMode')
  })

  it('lowercases a mixed-case provider', () => {
    process.env.LLM_PROVIDER = 'NVIDIA'
    process.env.NVIDIA_API_KEY = 'secret'
    expect(resolveTask('reasoning').provider).toBe('nvidia')
  })
})
