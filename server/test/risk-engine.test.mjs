import { describe, it, expect } from 'vitest';
import { scoreToTier } from '../services/risk/thresholds.js';
import { applyKnockouts, maxTier } from '../services/risk/knockouts.js';

const MATRIX = {
  thresholds: [
    { tier: 'Low', min: 0, max: 35 },
    { tier: 'Medium', min: 36, max: 70 },
    { tier: 'High', min: 71, max: 100 },
  ],
  knockouts: {
    screeningProhibited: false,
    screeningHighOverride: true,
    screeningMediumFloor: true,
  },
};

const report = (overallRisk) => ({ summary: { overallRisk } });

describe('scoreToTier', () => {
  it('maps scores into their bands', () => {
    expect(scoreToTier(0, MATRIX)).toBe('Low');
    expect(scoreToTier(35, MATRIX)).toBe('Low');
    expect(scoreToTier(36, MATRIX)).toBe('Medium');
    expect(scoreToTier(70, MATRIX)).toBe('Medium');
    expect(scoreToTier(71, MATRIX)).toBe('High');
    expect(scoreToTier(100, MATRIX)).toBe('High');
  });

  it('bridges the integer seam by rounding', () => {
    expect(scoreToTier(35.4, MATRIX)).toBe('Low');
    expect(scoreToTier(35.6, MATRIX)).toBe('Medium');
  });

  it('clamps above the top band to the last tier', () => {
    expect(scoreToTier(140, MATRIX)).toBe('High');
  });

  it('defaults to Low when the matrix has no thresholds', () => {
    expect(scoreToTier(99, {})).toBe('Low');
    expect(scoreToTier(99, { thresholds: [] })).toBe('Low');
  });
});

describe('applyKnockouts', () => {
  it('does nothing when screening risk is low', () => {
    const r = applyKnockouts({ tier: 'Low', screeningReport: report('low'), matrix: MATRIX });
    expect(r).toEqual({ tier: 'Low', outcome: 'Low', triggered: [] });
  });

  it('floors the tier to Medium on medium screening risk', () => {
    const r = applyKnockouts({ tier: 'Low', screeningReport: report('medium'), matrix: MATRIX });
    expect(r.tier).toBe('Medium');
    expect(r.triggered).toEqual(['screeningMediumFloor']);
  });

  it('never lowers an already-higher tier (floor, not set)', () => {
    const r = applyKnockouts({ tier: 'High', screeningReport: report('medium'), matrix: MATRIX });
    expect(r.tier).toBe('High');
  });

  it('forces High on high screening risk (confirmed sanctions hit)', () => {
    const r = applyKnockouts({ tier: 'Low', screeningReport: report('high'), matrix: MATRIX });
    expect(r.tier).toBe('High');
    expect(r.outcome).toBe('High');
    expect(r.triggered).toContain('screeningHighOverride');
  });

  it('marks the outcome Prohibited when screeningProhibited is enabled', () => {
    const matrix = { ...MATRIX, knockouts: { ...MATRIX.knockouts, screeningProhibited: true } };
    const r = applyKnockouts({ tier: 'Low', screeningReport: report('high'), matrix });
    expect(r.tier).toBe('High');
    expect(r.outcome).toBe('Prohibited');
    expect(r.triggered).toContain('screeningProhibited');
  });

  it('respects disabled flags', () => {
    const matrix = {
      knockouts: { screeningProhibited: false, screeningHighOverride: false, screeningMediumFloor: false },
    };
    const r = applyKnockouts({ tier: 'Low', screeningReport: report('high'), matrix });
    expect(r).toEqual({ tier: 'Low', outcome: 'Low', triggered: [] });
  });

  it('tolerates a missing screening report', () => {
    const r = applyKnockouts({ tier: 'Medium', screeningReport: null, matrix: MATRIX });
    expect(r).toEqual({ tier: 'Medium', outcome: 'Medium', triggered: [] });
  });
});

describe('maxTier', () => {
  it('orders Low < Medium < High', () => {
    expect(maxTier('Low', 'Medium')).toBe('Medium');
    expect(maxTier('High', 'Medium')).toBe('High');
    expect(maxTier('Low', 'Low')).toBe('Low');
  });
});
