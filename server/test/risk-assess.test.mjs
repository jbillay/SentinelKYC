// Phase 1 — the risk engine orchestration (index.js#assessRisk), receipt
// builder, normalize helpers (lookup + unknown paths, no LLM), the pure
// rationale formatter, and matrix validation. The LLM-backed paths
// (normalizeCountry miss, generateRationale) are covered in risk-llm.test.mjs.
import { describe, it, expect } from 'vitest';
import { assessRisk, buildReceipt, round2 } from '../services/risk/index.js';
import { normalizeCountry, normalizeEntityType, normalizeSicCodes } from '../services/risk/normalize.js';
import { formatRationale } from '../services/risk/rationale.js';
import { validateMatrix, defaultMatrixBody } from '../services/risk/matrix.js';
import MATRIX from '../services/risk/defaults/matrix.json';

describe('assessRisk (end to end, lookup country, no LLM)', () => {
  it('scores a clean UK ltd as Low with a full receipt', async () => {
    const r = await assessRisk({
      profile: {
        type: 'ltd',
        registered_office_address: { country: 'United Kingdom' },
        sic_codes: ['62012'],
      },
      psc: { items: [{ name: 'Jane', kind: 'individual-person-with-significant-control' }] },
      kycCard: { shareholders: [] },
      screeningReport: { summary: { overallRisk: 'low' } },
      matrix: MATRIX,
    });
    expect(r.tier).toBe('Low');
    expect(r.factors).toHaveLength(4);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.receipt.inputs.country.iso2).toBe('GB');
    expect(r.receipt.factors).toHaveLength(4);
    expect(r.matrixVersionId).toBeNull();
  });

  it('drives the tier up for a high-risk country + complex structure + sanctions hit', async () => {
    const r = await assessRisk({
      profile: {
        type: 'oversea-company',
        registered_office_address: { country: 'Russia' },
        sic_codes: ['64999'],
      },
      psc: { items: [{ name: 'Parent', kind: 'corporate-entity-person-with-significant-control' }] },
      kycCard: { shareholders: [{ name: 'X', type: 'corporate' }] },
      screeningReport: { summary: { overallRisk: 'high' } },
      matrix: MATRIX,
    });
    expect(r.tier).toBe('High');
    expect(r.knockoutsTriggered).toContain('screeningHighOverride');
  });

  it('accepts a wrapped { body, versionId, version } matrix and records the version', async () => {
    const r = await assessRisk({
      profile: { type: 'ltd', registered_office_address: { country: 'United Kingdom' } },
      matrix: { body: MATRIX, versionId: 7, version: 3 },
    });
    expect(r.matrixVersionId).toBe(7);
    expect(r.matrixVersion).toBe(3);
  });

  it('computes a trajectory delta and flags large swings', async () => {
    const base = { profile: { type: 'ltd', registered_office_address: { country: 'United Kingdom' } }, matrix: MATRIX };
    const r = await assessRisk({ ...base, previousAssessment: { score: 0 } });
    expect(r.deltaFromPrevious).toBe(round2(r.score));
    const flagged = await assessRisk({
      profile: { type: 'oversea-company', registered_office_address: { country: 'Russia' }, sic_codes: ['92000'] },
      matrix: MATRIX,
      previousAssessment: { score: 0 },
    });
    expect(flagged.deltaFlagged).toBe(true);
  });

  it('warns when country and SIC are absent', async () => {
    const r = await assessRisk({ profile: {}, matrix: MATRIX });
    expect(r.receipt.warnings.some((w) => w.includes('country'))).toBe(true);
    expect(r.receipt.warnings.some((w) => w.includes('SIC'))).toBe(true);
  });
});

describe('buildReceipt', () => {
  it('normalizes nullable fields and non-finite numbers', () => {
    const rec = buildReceipt({
      factors: [{ factor: 'geographic', weight: 0.3, baseScore: 5, contribution: 1.5 }],
      score: 1.5,
      knockouts: { triggered: ['x'] },
      tier: 'Low',
      outcome: 'Low',
      previousScore: NaN,
      deltaFromPrevious: NaN,
      deltaFlagThreshold: 15,
      deltaFlagged: false,
      warnings: null,
    });
    expect(rec.schemaVersion).toBe(1);
    expect(rec.trajectory.previousScore).toBeNull();
    expect(rec.trajectory.delta).toBeNull();
    expect(rec.knockoutsTriggered).toEqual(['x']);
    expect(rec.warnings).toEqual([]);
    expect(rec.factors[0].label).toBeNull();
  });
});

describe('normalize helpers (no I/O)', () => {
  it('resolves a known country via the static lookup', async () => {
    expect(await normalizeCountry('United Kingdom')).toMatchObject({ iso2: 'GB', source: 'lookup' });
  });
  it('returns unknown for blank country without touching cache/LLM', async () => {
    expect(await normalizeCountry('')).toEqual({ iso2: null, label: null, source: 'unknown' });
  });
  it('maps human-readable entity types to CH slugs', () => {
    expect(normalizeEntityType('Private Limited Company')).toBe('ltd');
    expect(normalizeEntityType('ltd')).toBe('ltd');
    expect(normalizeEntityType('')).toBeNull();
  });
  it('coerces and filters SIC codes', () => {
    expect(normalizeSicCodes({ sic_codes: [62012, ' 123 ', '', null] })).toEqual(['62012', '123']);
    expect(normalizeSicCodes({})).toEqual([]);
  });
});

describe('formatRationale (pure)', () => {
  it('assembles tier/score/headline/drivers/note', () => {
    const s = formatRationale(
      { tier: 'High', score: 88 },
      { headline: 'Elevated.', drivers: [{ reason: 'sanctions' }, { reason: 'geography' }], sanctionsNote: 'OFAC match.' },
    );
    expect(s).toContain('High');
    expect(s).toContain('88');
    expect(s).toContain('Primary drivers: sanctions; geography.');
    expect(s).toContain('OFAC match.');
  });
  it('handles a missing llm object gracefully', () => {
    expect(formatRationale({ tier: 'Low', score: 3 }, null)).toBe('Entity assessed as Low (Score: 3).');
  });
});

describe('validateMatrix', () => {
  it('accepts the bundled default matrix', () => {
    expect(validateMatrix(defaultMatrixBody())).toEqual([]);
  });
  it('rejects a non-object body', () => {
    expect(validateMatrix(null)).toEqual(['matrix body must be a JSON object']);
    expect(validateMatrix([])).toEqual(['matrix body must be a JSON object']);
  });
  it('flags weights that do not sum to 1', () => {
    const m = defaultMatrixBody();
    m.weights.geographic = 0.9;
    expect(validateMatrix(m).some((e) => e.includes('weights_sum'))).toBe(true);
  });
  it('flags an unknown knockout tag and a non-boolean value', () => {
    const m = defaultMatrixBody();
    m.knockouts.madeUpTag = true;
    m.knockouts.screeningProhibited = 'yes';
    const errs = validateMatrix(m);
    expect(errs.some((e) => e.includes('unknown_knockout'))).toBe(true);
    expect(errs.some((e) => e.includes('screeningProhibited must be a boolean'))).toBe(true);
  });
  it('flags non-ascending thresholds and a gap below 100', () => {
    const m = defaultMatrixBody();
    m.thresholds = [{ tier: 'Low', min: 0, max: 50 }, { tier: 'High', min: 40, max: 80 }];
    const errs = validateMatrix(m);
    expect(errs.some((e) => e.includes('ascending'))).toBe(true);
    expect(errs.some((e) => e.includes('cover up to 100'))).toBe(true);
  });
  it('flags a structural tier list that is not open-ended last', () => {
    const m = defaultMatrixBody();
    m.factors.structuralComplexity.corporatePscCount.tiers = [{ upTo: 1, score: 10 }];
    expect(validateMatrix(m).some((e) => e.includes('open-ended'))).toBe(true);
  });
});
