// Phase S3 — pure screening-service helpers.
//
// Covers:
//   - evaluateSanctionsHit.buildSanctionsInput (pure JSON builder)
//   - SanctionsEvalSchema Zod parsing (schema contract)
//   - evaluateAdverseMediaHit.buildAdverseMediaInput (pure JSON builder)
//   - AdverseMediaEvalSchema Zod parsing (schema contract)
//   - evaluateSanctionsHit / evaluateAdverseMediaHit top-level calls with
//     mocked LLM (tests the loadPrompt + extractStructured integration)
//
// No DB.

// Phase S3 covers the PURE (no LLM, no DB) helpers only.
// The LLM-calling paths (evaluateSanctionsHit / evaluateAdverseMediaHit top-level)
// are covered by graph-nodes-llm.int.test.mjs which sets OLLAMA_HOST to a dead
// port via appHarness. Pure data tests here don't need mocks at all.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { SanctionsEvalSchema, buildSanctionsInput } =
  require('../services/screening/evaluateSanctionsHit.js');
const { AdverseMediaEvalSchema, buildAdverseMediaInput } =
  require('../services/screening/evaluateAdverseMediaHit.js');

// ─── buildSanctionsInput ──────────────────────────────────────────────────────

describe('buildSanctionsInput', () => {
  const SUBJECT = { name: 'John Smith', kind: 'individual', role: 'director', dob: '1970-01-01', nationality: 'GB' };
  const HIT = {
    listSource: 'OFAC_SDN',
    matchScore: 0.91,
    subjectName: 'John Smith',
    subjectKind: 'individual',
    rawEntry: {
      primaryName: 'SMITH, John',
      entryType: 'individual',
      aliases: [{ name: 'JSmith' }, { name: 'Johnny Smith' }],
      dob: '1970-01-01',
      nationality: 'US',
      programs: ['GLOBAL-MAGNITSKY'],
      identifiers: [{ type: 'passport', id: 'P1234' }],
    },
  };

  it('returns valid JSON string', () => {
    const json = buildSanctionsInput(SUBJECT, HIT);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('includes subject name, kind, and dob', () => {
    const parsed = JSON.parse(buildSanctionsInput(SUBJECT, HIT));
    expect(parsed.subject.name).toBe('John Smith');
    expect(parsed.subject.kind).toBe('individual');
    expect(parsed.subject.dob).toBe('1970-01-01');
  });

  it('includes entry listSource, primaryName, and aliases', () => {
    const parsed = JSON.parse(buildSanctionsInput(SUBJECT, HIT));
    expect(parsed.entry.listSource).toBe('OFAC_SDN');
    expect(parsed.entry.primaryName).toBe('SMITH, John');
    expect(parsed.entry.aliases).toEqual(['JSmith', 'Johnny Smith']);
  });

  it('includes matchScore', () => {
    const parsed = JSON.parse(buildSanctionsInput(SUBJECT, HIT));
    expect(parsed.matchScore).toBe(0.91);
  });

  it('falls back to hit.subjectName when subject is null', () => {
    const parsed = JSON.parse(buildSanctionsInput(null, HIT));
    expect(parsed.subject.name).toBe('John Smith');
  });

  it('caps aliases at 20 entries', () => {
    const manyAliases = Array.from({ length: 30 }, (_, i) => ({ name: `Alias${i}` }));
    const parsed = JSON.parse(buildSanctionsInput(SUBJECT, { ...HIT, rawEntry: { ...HIT.rawEntry, aliases: manyAliases } }));
    expect(parsed.entry.aliases.length).toBeLessThanOrEqual(20);
  });

  it('handles missing rawEntry gracefully', () => {
    const parsed = JSON.parse(buildSanctionsInput(SUBJECT, { ...HIT, rawEntry: null }));
    expect(parsed.entry.primaryName).toBeNull();
    expect(parsed.entry.aliases).toEqual([]);
  });
});

// ─── SanctionsEvalSchema ──────────────────────────────────────────────────────

describe('SanctionsEvalSchema', () => {
  it('parses a valid confirmed decision', () => {
    const result = SanctionsEvalSchema.safeParse({
      decision: 'confirmed',
      llmScore: 0.95,
      reasoning: 'High similarity across name, dob and nationality',
      matchedFields: ['name', 'dob'],
      conflictingFields: [],
    });
    expect(result.success).toBe(true);
    expect(result.data.decision).toBe('confirmed');
  });

  it('parses needs_review', () => {
    const result = SanctionsEvalSchema.safeParse({
      decision: 'needs_review',
      llmScore: 0.6,
      reasoning: 'Name matches but DOB absent',
      matchedFields: ['name'],
      conflictingFields: [],
    });
    expect(result.success).toBe(true);
  });

  it('defaults matchedFields and conflictingFields to empty arrays', () => {
    const result = SanctionsEvalSchema.safeParse({
      decision: 'dismissed',
      llmScore: 0.1,
      reasoning: 'Different person entirely',
    });
    expect(result.success).toBe(true);
    expect(result.data.matchedFields).toEqual([]);
    expect(result.data.conflictingFields).toEqual([]);
  });

  it('rejects unknown decision values', () => {
    const result = SanctionsEvalSchema.safeParse({
      decision: 'maybe',
      llmScore: 0.5,
      reasoning: 'Uncertain',
    });
    expect(result.success).toBe(false);
  });

  it('rejects llmScore outside [0,1]', () => {
    const result = SanctionsEvalSchema.safeParse({
      decision: 'confirmed',
      llmScore: 1.5,
      reasoning: 'Over-confident',
    });
    expect(result.success).toBe(false);
  });
});

// ─── buildAdverseMediaInput ───────────────────────────────────────────────────

describe('buildAdverseMediaInput', () => {
  const SUBJECT = { name: 'Jane Doe', kind: 'individual', role: 'director', nationality: 'GB' };
  const HIT = {
    subjectName: 'Jane Doe',
    subjectKind: 'individual',
    rawEntry: {
      title: 'Jane Doe implicated in fraud',
      snippet: '',
      url: 'https://news.example.com/1',
      publishedAt: '2024-01-15',
      source: 'NewsExample',
    },
  };

  it('returns valid JSON string', () => {
    const json = buildAdverseMediaInput(SUBJECT, HIT);
    expect(() => JSON.parse(json)).not.toThrow();
  });

  it('includes subject name and kind', () => {
    const parsed = JSON.parse(buildAdverseMediaInput(SUBJECT, HIT));
    expect(parsed.subject.name).toBe('Jane Doe');
    expect(parsed.subject.kind).toBe('individual');
  });

  it('includes article title and source', () => {
    const parsed = JSON.parse(buildAdverseMediaInput(SUBJECT, HIT));
    expect(parsed.article.title).toBe('Jane Doe implicated in fraud');
    expect(parsed.article.source).toBe('NewsExample');
  });

  it('falls back to hit.subjectName when subject is null', () => {
    const parsed = JSON.parse(buildAdverseMediaInput(null, HIT));
    expect(parsed.subject.name).toBe('Jane Doe');
  });

  it('handles missing rawEntry gracefully', () => {
    const parsed = JSON.parse(buildAdverseMediaInput(SUBJECT, { ...HIT, rawEntry: null }));
    expect(parsed.article.title).toBeNull();
    expect(parsed.article.source).toBeNull();
  });
});

// ─── AdverseMediaEvalSchema ───────────────────────────────────────────────────

describe('AdverseMediaEvalSchema', () => {
  it('parses a valid confirmed decision with category and severity', () => {
    const result = AdverseMediaEvalSchema.safeParse({
      decision: 'confirmed',
      category: 'financial_crime',
      severity: 'high',
      llmScore: 0.85,
      reasoning: 'Article directly names the subject in a fraud scheme',
    });
    expect(result.success).toBe(true);
    expect(result.data.category).toBe('financial_crime');
    expect(result.data.severity).toBe('high');
  });

  it('defaults category to other and severity to low when omitted', () => {
    const result = AdverseMediaEvalSchema.safeParse({
      decision: 'dismissed',
      llmScore: 0.2,
      reasoning: 'Different Jane Doe — context is sport',
    });
    expect(result.success).toBe(true);
    expect(result.data.category).toBe('other');
    expect(result.data.severity).toBe('low');
  });

  it('rejects invalid category', () => {
    const result = AdverseMediaEvalSchema.safeParse({
      decision: 'confirmed',
      category: 'gossip',
      severity: 'low',
      llmScore: 0.5,
      reasoning: 'Test',
    });
    expect(result.success).toBe(false);
  });

  it('accepts all valid decision values', () => {
    for (const decision of ['confirmed', 'dismissed', 'needs_review']) {
      const r = AdverseMediaEvalSchema.safeParse({ decision, llmScore: 0.5, reasoning: 'test' });
      expect(r.success).toBe(true);
    }
  });
});

// LLM-calling integration paths (evaluateSanctionsHit / evaluateAdverseMediaHit)
// are covered by graph-nodes-llm.int.test.mjs via the dead-OLLAMA_HOST harness.
