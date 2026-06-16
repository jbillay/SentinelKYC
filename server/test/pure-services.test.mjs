// Phase 1 — remaining genuinely-pure services (no DB, no LLM, no network):
// the party corroboration gate, LLM provider selection, GDELT query/parse
// helpers, and the agent definition registry.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { corroborate } from '../services/party/corroborate.js';
import { resolveTask, VALID_PROVIDERS, TASKS } from '../services/llm/config.js';
import { buildQuery, normalizeArticle, parseSeenDate } from '../services/adverseMedia/gdelt.js';
import { AGENTS, getAgentDef, listAgentDefs, secretFieldKeys } from '../agents/defs.js';

describe('party corroborate', () => {
  it('auto-links when DOB year+month and nationality agree', () => {
    const r = corroborate(
      { dateOfBirthYear: 1975, dateOfBirthMonth: 4, nationality: ['British'] },
      { dateOfBirthYear: 1975, dateOfBirthMonth: 4, nationality: ['british', 'irish'] },
    );
    expect(r.ok).toBe(true);
    expect(r.signalsUsed).toEqual(['dob_year', 'dob_month', 'nationality']);
  });

  it('rejects on a DOB year mismatch', () => {
    expect(corroborate({ dateOfBirthYear: 1975 }, { dateOfBirthYear: 1980 })).toMatchObject({
      ok: false,
      reason: 'dob_mismatch',
    });
  });

  it('rejects on a DOB month mismatch when both months are present', () => {
    expect(
      corroborate(
        { dateOfBirthYear: 1975, dateOfBirthMonth: 4 },
        { dateOfBirthYear: 1975, dateOfBirthMonth: 9 },
      ),
    ).toMatchObject({ ok: false, reason: 'dob_mismatch' });
  });

  it('uses year alone when only one side carries the month', () => {
    const r = corroborate({ dateOfBirthYear: 1975, dateOfBirthMonth: 4 }, { dateOfBirthYear: 1975 });
    expect(r).toMatchObject({ ok: true, signalsUsed: ['dob_year'] });
  });

  it('rejects when nationalities are disjoint', () => {
    expect(corroborate({ nationality: ['British'] }, { nationality: ['French'] })).toMatchObject({
      ok: false,
      reason: 'nationality_disjoint',
    });
  });

  it('returns no_corroborating_signal for a bare-name match', () => {
    expect(corroborate({}, {})).toMatchObject({ ok: false, reason: 'no_corroborating_signal' });
    expect(corroborate({ nationality: 'notarray' }, {})).toMatchObject({ reason: 'no_corroborating_signal' });
  });
});

describe('llm resolveTask', () => {
  const SAVED = {};
  const VARS = ['LLM_PROVIDER', 'LLM_OCR_PROVIDER', 'LLM_REASONING_PROVIDER', 'NVIDIA_API_KEY', 'OLLAMA_HOST', 'OLLAMA_REASONING_MODEL'];
  beforeEach(() => {
    for (const v of VARS) { SAVED[v] = process.env[v]; delete process.env[v]; }
  });
  afterEach(() => {
    for (const v of VARS) { if (SAVED[v] === undefined) delete process.env[v]; else process.env[v] = SAVED[v]; }
  });

  it('defaults to ollama for both tasks with sensible models', () => {
    expect(resolveTask('ocr')).toMatchObject({ provider: 'ollama', model: 'glm-ocr' });
    expect(resolveTask('reasoning')).toMatchObject({ provider: 'ollama', model: 'llama3.1:8b' });
  });

  it('normalizes localhost to 127.0.0.1 in the ollama base url', () => {
    process.env.OLLAMA_HOST = 'http://localhost:11434';
    expect(resolveTask('reasoning').baseUrl).toBe('http://127.0.0.1:11434');
  });

  it('lets a per-task override beat LLM_PROVIDER', () => {
    process.env.LLM_PROVIDER = 'nvidia';
    process.env.LLM_OCR_PROVIDER = 'ollama';
    process.env.NVIDIA_API_KEY = 'k';
    expect(resolveTask('ocr').provider).toBe('ollama');
    expect(resolveTask('reasoning').provider).toBe('nvidia');
  });

  it('throws for an unknown provider', () => {
    process.env.LLM_PROVIDER = 'openai';
    expect(() => resolveTask('reasoning')).toThrow(/unknown provider/);
  });

  it('throws when nvidia is selected without an API key', () => {
    process.env.LLM_REASONING_PROVIDER = 'nvidia';
    expect(() => resolveTask('reasoning')).toThrow(/NVIDIA_API_KEY/);
  });

  it('builds the nvidia reasoning config when the key is present', () => {
    process.env.LLM_REASONING_PROVIDER = 'nvidia';
    process.env.NVIDIA_API_KEY = 'secret';
    const cfg = resolveTask('reasoning');
    expect(cfg).toMatchObject({ provider: 'nvidia', apiKey: 'secret', structuredMethod: 'functionCalling' });
  });

  it('throws on an unknown task', () => {
    expect(() => resolveTask('translation')).toThrow(/unknown task/);
  });

  it('exposes the provider/task constants', () => {
    expect(VALID_PROVIDERS).toContain('ollama');
    expect(TASKS).toEqual(['ocr', 'reasoning']);
  });
});

describe('gdelt pure helpers', () => {
  it('builds a quoted-phrase query AND-ed with the risk terms, stripping query metachars', () => {
    const q = buildQuery('ACME (Holdings) "Ltd"');
    expect(q.startsWith('"ACME Holdings Ltd"')).toBe(true);
    expect(q).toContain('money laundering');
  });

  it('normalizes an article with an empty snippet and parsed date', () => {
    const a = normalizeArticle({ title: 'T', url: 'u', seendate: '20240115T123000Z', domain: 'x.com' });
    expect(a).toEqual({ title: 'T', snippet: '', url: 'u', publishedAt: '2024-01-15T12:30:00Z', source: 'x.com' });
  });

  it('defaults missing article fields', () => {
    const a = normalizeArticle({});
    expect(a).toMatchObject({ title: '', url: '', source: null, publishedAt: null });
  });

  it('parseSeenDate returns null for malformed input', () => {
    expect(parseSeenDate('not-a-date')).toBeNull();
    expect(parseSeenDate(12345)).toBeNull();
  });
});

describe('agents/defs', () => {
  it('every agent default validates against its own schema', () => {
    for (const a of AGENTS) {
      expect(() => a.schema.parse(a.defaults)).not.toThrow();
    }
  });

  it('exposes the six pipeline agents with exactly one required', () => {
    expect(listAgentDefs()).toHaveLength(6);
    expect(AGENTS.filter((a) => a.required).map((a) => a.id)).toEqual(['entity-resolution']);
  });

  it('getAgentDef returns by id and throws on an unknown id', () => {
    expect(getAgentDef('screening').name).toBe('Screening');
    expect(() => getAgentDef('nope')).toThrow(/Unknown agent id/);
  });

  it('rejects unknown config keys (strict schema)', () => {
    expect(() => getAgentDef('qa').schema.parse({ enabled: true, extra: 1 })).toThrow();
  });

  it('reports no secret fields yet', () => {
    for (const a of AGENTS) expect(secretFieldKeys(a)).toEqual([]);
  });
});
