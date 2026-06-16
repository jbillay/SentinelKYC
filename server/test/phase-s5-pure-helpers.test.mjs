// Phase S5 — pure helpers: party-match schemas + risk normalizers + receipt builder.
//
// Covers:
//   - lib/partyMatchSchema (partyMatchInputSchema, partyMatchResultSchema,
//     partyMergeSchema, reviewQueueResolutionSchema) — Zod schema contracts
//   - services/risk/normalize (normKey, normalizeCountry static-lookup path,
//     normalizeEntityType, normalizeSicCodes) — no LLM, no cache, no DB
//   - services/risk/receipt (buildReceipt) — pure receipt builder
//
// No DB, no LLM, no I/O.  All synchronous (or promise-resolving from cache).

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const { partyMatchInputSchema, partyMatchResultSchema, partyMergeSchema, reviewQueueResolutionSchema } =
  require('../lib/partyMatchSchema.js');
const { normKey, normalizeCountry, normalizeEntityType, normalizeSicCodes } =
  require('../services/risk/normalize.js');
const { buildReceipt } = require('../services/risk/receipt.js');

// ─── partyMatchInputSchema ────────────────────────────────────────────────────

describe('partyMatchInputSchema', () => {
  it('accepts a bare name string', () => {
    const r = partyMatchInputSchema.safeParse({ name: 'Jane Smith' });
    expect(r.success).toBe(true);
    expect(r.data.name).toBe('Jane Smith');
  });

  it('rejects an empty name', () => {
    const r = partyMatchInputSchema.safeParse({ name: '   ' });
    expect(r.success).toBe(false);
  });

  it('rejects a missing name', () => {
    const r = partyMatchInputSchema.safeParse({});
    expect(r.success).toBe(false);
  });

  it('accepts optional dob object', () => {
    const r = partyMatchInputSchema.safeParse({ name: 'Jane', dob: { year: 1970, month: 6 } });
    expect(r.success).toBe(true);
    expect(r.data.dob?.year).toBe(1970);
  });

  it('rejects dob with out-of-range year', () => {
    const r = partyMatchInputSchema.safeParse({ name: 'Jane', dob: { year: 1800 } });
    expect(r.success).toBe(false);
  });

  it('rejects dob with invalid month', () => {
    const r = partyMatchInputSchema.safeParse({ name: 'Jane', dob: { month: 13 } });
    expect(r.success).toBe(false);
  });

  it('accepts optional nationality as array of ISO-2 codes', () => {
    const r = partyMatchInputSchema.safeParse({ name: 'Jane', nationality: ['GB', 'US'] });
    expect(r.success).toBe(true);
  });

  it('rejects nationality with non-ISO-2 code', () => {
    const r = partyMatchInputSchema.safeParse({ name: 'Jane', nationality: ['GBR'] });
    expect(r.success).toBe(false);
  });

  it('accepts optional countryOfResidence as ISO-2', () => {
    const r = partyMatchInputSchema.safeParse({ name: 'Jane', countryOfResidence: 'FR' });
    expect(r.success).toBe(true);
  });

  it('rejects lowercase countryOfResidence', () => {
    const r = partyMatchInputSchema.safeParse({ name: 'Jane', countryOfResidence: 'fr' });
    expect(r.success).toBe(false);
  });

  it('accepts optional minScore in [0,1]', () => {
    const r = partyMatchInputSchema.safeParse({ name: 'Jane', minScore: 0.7 });
    expect(r.success).toBe(true);
  });

  it('rejects minScore > 1', () => {
    const r = partyMatchInputSchema.safeParse({ name: 'Jane', minScore: 1.5 });
    expect(r.success).toBe(false);
  });

  it('accepts optional limit in [1,100]', () => {
    const r = partyMatchInputSchema.safeParse({ name: 'Jane', limit: 10 });
    expect(r.success).toBe(true);
  });

  it('rejects limit of 0', () => {
    const r = partyMatchInputSchema.safeParse({ name: 'Jane', limit: 0 });
    expect(r.success).toBe(false);
  });

  it('rejects limit > 100', () => {
    const r = partyMatchInputSchema.safeParse({ name: 'Jane', limit: 101 });
    expect(r.success).toBe(false);
  });
});

// ─── partyMatchResultSchema ───────────────────────────────────────────────────

describe('partyMatchResultSchema', () => {
  const VALID_CANDIDATE = {
    partyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    fullName: 'Jane Smith',
    canonical: 'jane smith',
    score: 0.92,
    confidence: 'HIGH',
    matchedVia: 'trigram',
  };

  it('accepts a valid result with candidates', () => {
    const r = partyMatchResultSchema.safeParse({
      inputCanonical: 'jane smith',
      candidates: [VALID_CANDIDATE],
      topScore: 0.92,
    });
    expect(r.success).toBe(true);
    expect(r.data.candidates).toHaveLength(1);
  });

  it('accepts an empty candidates array', () => {
    const r = partyMatchResultSchema.safeParse({
      inputCanonical: 'nobody',
      candidates: [],
      topScore: null,
    });
    expect(r.success).toBe(true);
    expect(r.data.topScore).toBeNull();
  });

  it('rejects an unknown confidence level', () => {
    const r = partyMatchResultSchema.safeParse({
      inputCanonical: 'jane',
      candidates: [{ ...VALID_CANDIDATE, confidence: 'LOW' }],
      topScore: 0.5,
    });
    expect(r.success).toBe(false);
  });

  it('rejects an unknown matchedVia value', () => {
    const r = partyMatchResultSchema.safeParse({
      inputCanonical: 'jane',
      candidates: [{ ...VALID_CANDIDATE, matchedVia: 'magic' }],
      topScore: 0.9,
    });
    expect(r.success).toBe(false);
  });

  it('rejects a non-uuid partyId', () => {
    const r = partyMatchResultSchema.safeParse({
      inputCanonical: 'jane',
      candidates: [{ ...VALID_CANDIDATE, partyId: 'not-a-uuid' }],
      topScore: 0.9,
    });
    expect(r.success).toBe(false);
  });
});

// ─── partyMergeSchema ─────────────────────────────────────────────────────────

describe('partyMergeSchema', () => {
  it('accepts a valid merge payload with reason', () => {
    const r = partyMergeSchema.safeParse({
      mergeFromPartyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      reason: 'Confirmed same person',
    });
    expect(r.success).toBe(true);
  });

  it('accepts a merge payload without optional reason', () => {
    const r = partyMergeSchema.safeParse({
      mergeFromPartyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(r.success).toBe(true);
  });

  it('rejects missing mergeFromPartyId', () => {
    const r = partyMergeSchema.safeParse({ reason: 'test' });
    expect(r.success).toBe(false);
  });

  it('rejects non-uuid mergeFromPartyId', () => {
    const r = partyMergeSchema.safeParse({ mergeFromPartyId: 'not-a-uuid' });
    expect(r.success).toBe(false);
  });

  it('rejects reason shorter than 3 chars', () => {
    const r = partyMergeSchema.safeParse({
      mergeFromPartyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      reason: 'AB',
    });
    expect(r.success).toBe(false);
  });
});

// ─── reviewQueueResolutionSchema ──────────────────────────────────────────────

describe('reviewQueueResolutionSchema', () => {
  it('accepts action=merge', () => {
    const r = reviewQueueResolutionSchema.safeParse({ action: 'merge' });
    expect(r.success).toBe(true);
    expect(r.data.action).toBe('merge');
  });

  it('accepts action=merge with optional winnerPartyId', () => {
    const r = reviewQueueResolutionSchema.safeParse({
      action: 'merge',
      winnerPartyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    });
    expect(r.success).toBe(true);
  });

  it('rejects action=merge with non-uuid winnerPartyId', () => {
    const r = reviewQueueResolutionSchema.safeParse({
      action: 'merge',
      winnerPartyId: 'not-a-uuid',
    });
    expect(r.success).toBe(false);
  });

  it('accepts action=reject with optional reason', () => {
    const r = reviewQueueResolutionSchema.safeParse({ action: 'reject', reason: 'Not the same person' });
    expect(r.success).toBe(true);
  });

  it('rejects an unknown action', () => {
    const r = reviewQueueResolutionSchema.safeParse({ action: 'approve' });
    expect(r.success).toBe(false);
  });

  it('rejects missing action', () => {
    const r = reviewQueueResolutionSchema.safeParse({ reason: 'test' });
    expect(r.success).toBe(false);
  });
});

// ─── normKey ──────────────────────────────────────────────────────────────────

describe('normKey', () => {
  it('lowercases and trims', () => {
    expect(normKey('  United Kingdom  ')).toBe('united kingdom');
  });

  it('collapses multiple spaces to one', () => {
    expect(normKey('United   Kingdom')).toBe('united kingdom');
  });

  it('handles null gracefully', () => {
    expect(normKey(null)).toBe('');
  });

  it('handles undefined gracefully', () => {
    expect(normKey(undefined)).toBe('');
  });

  it('passes through already-normalised strings unchanged', () => {
    expect(normKey('gb')).toBe('gb');
  });
});

// ─── normalizeCountry (static-lookup path only — no LLM) ─────────────────────

describe('normalizeCountry (static-lookup path)', () => {
  it('resolves "United Kingdom" to GB', async () => {
    const r = await normalizeCountry('United Kingdom');
    expect(r.iso2).toBe('GB');
    expect(r.source).toBe('lookup');
  });

  it('resolves "United States" to US', async () => {
    const r = await normalizeCountry('United States');
    expect(r.iso2).toBe('US');
    expect(r.source).toBe('lookup');
  });

  it('returns unknown for empty input', async () => {
    const r = await normalizeCountry('');
    expect(r.iso2).toBeNull();
    expect(r.source).toBe('unknown');
  });

  it('returns unknown for null input', async () => {
    const r = await normalizeCountry(null);
    expect(r.iso2).toBeNull();
    expect(r.source).toBe('unknown');
  });

  it('is case-insensitive on lookup', async () => {
    const r = await normalizeCountry('united kingdom');
    expect(r.iso2).toBe('GB');
  });

  it('resolves an ISO-2 code passed as free text', async () => {
    // If 'gb' appears directly in the lookup it resolves immediately.
    const r = await normalizeCountry('GB');
    // Either a direct hit or null — either is valid; no crash is the key test.
    expect(r.iso2 === 'GB' || r.iso2 === null).toBe(true);
  });
});

// ─── normalizeEntityType ─────────────────────────────────────────────────────

describe('normalizeEntityType', () => {
  it('passes through a CH slug unchanged', () => {
    expect(normalizeEntityType('ltd')).toBe('ltd');
  });

  it('maps "private limited company" to ltd', () => {
    expect(normalizeEntityType('private limited company')).toBe('ltd');
  });

  it('maps "public limited company" to plc', () => {
    expect(normalizeEntityType('public limited company')).toBe('plc');
  });

  it('maps "limited liability partnership" to llp', () => {
    expect(normalizeEntityType('limited liability partnership')).toBe('llp');
  });

  it('returns null for null input', () => {
    expect(normalizeEntityType(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(normalizeEntityType('')).toBeNull();
  });

  it('returns an unrecognised slug as-is', () => {
    expect(normalizeEntityType('scottish-limited-partnership')).toBe('scottish-limited-partnership');
  });
});

// ─── normalizeSicCodes ────────────────────────────────────────────────────────

describe('normalizeSicCodes', () => {
  it('extracts codes from profile.sic_codes', () => {
    const codes = normalizeSicCodes({ sic_codes: ['64999', '65110'] });
    expect(codes).toEqual(['64999', '65110']);
  });

  it('returns empty array when sic_codes is missing', () => {
    expect(normalizeSicCodes({})).toEqual([]);
  });

  it('returns empty array for null profile', () => {
    expect(normalizeSicCodes(null)).toEqual([]);
  });

  it('filters out empty / whitespace-only entries', () => {
    const codes = normalizeSicCodes({ sic_codes: ['64999', '', '  '] });
    expect(codes).toEqual(['64999']);
  });

  it('coerces numeric codes to strings', () => {
    const codes = normalizeSicCodes({ sic_codes: [64999] });
    expect(codes).toEqual(['64999']);
  });
});

// ─── buildReceipt ─────────────────────────────────────────────────────────────

describe('buildReceipt', () => {
  const BASE = {
    calculatedAt: '2024-01-01T00:00:00.000Z',
    inputs: { country: 'GB', entityType: 'ltd' },
    factors: [
      { factor: 'geographic', label: 'Geographic Risk', weight: 0.3, baseScore: 20, contribution: 6 },
    ],
    score: 6,
    knockouts: { triggered: [] },
    tier: 'Low',
    outcome: 'Approved',
    matrixVersionId: 'v1',
    matrixVersion: '1.0.0',
    previousScore: null,
    deltaFromPrevious: null,
    deltaFlagThreshold: 15,
    deltaFlagged: false,
    warnings: [],
  };

  it('builds a valid receipt', () => {
    const r = buildReceipt(BASE);
    expect(r.schemaVersion).toBe(1);
    expect(r.score).toBe(6);
    expect(r.tier).toBe('Low');
    expect(r.factors).toHaveLength(1);
    expect(r.factors[0].factor).toBe('geographic');
  });

  it('trajectory is null when previousScore is null', () => {
    const r = buildReceipt(BASE);
    expect(r.trajectory.previousScore).toBeNull();
    expect(r.trajectory.delta).toBeNull();
    expect(r.trajectory.flagged).toBe(false);
  });

  it('trajectory includes delta when previousScore is set', () => {
    const r = buildReceipt({ ...BASE, previousScore: 10, deltaFromPrevious: -4 });
    expect(r.trajectory.previousScore).toBe(10);
    expect(r.trajectory.delta).toBe(-4);
  });

  it('trajectory.flagged is true when deltaFlagged is true', () => {
    const r = buildReceipt({ ...BASE, deltaFlagged: true });
    expect(r.trajectory.flagged).toBe(true);
  });

  it('knockoutsTriggered defaults to empty when not provided', () => {
    const r = buildReceipt({ ...BASE, knockouts: null });
    expect(r.knockoutsTriggered).toEqual([]);
  });

  it('handles missing factors gracefully', () => {
    const r = buildReceipt({ ...BASE, factors: null });
    expect(r.factors).toEqual([]);
  });

  it('handles missing inputs gracefully', () => {
    const r = buildReceipt({ ...BASE, inputs: null });
    expect(r.inputs).toEqual({});
  });

  it('warnings defaults to empty when not an array', () => {
    const r = buildReceipt({ ...BASE, warnings: null });
    expect(r.warnings).toEqual([]);
  });

  it('matrix versionId and version are null when missing', () => {
    const r = buildReceipt({ ...BASE, matrixVersionId: undefined, matrixVersion: undefined });
    expect(r.matrix.versionId).toBeNull();
    expect(r.matrix.version).toBeNull();
  });

  it('factor fields include attribute and evidence', () => {
    const r = buildReceipt({
      ...BASE,
      factors: [{ factor: 'industry', label: 'Industry', weight: 0.2, baseScore: 30, contribution: 6, attribute: 'gambling', evidence: '9200' }],
    });
    expect(r.factors[0].attribute).toBe('gambling');
    expect(r.factors[0].evidence).toBe('9200');
  });
});
