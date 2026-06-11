import { describe, it, expect } from 'vitest';
import { normalizeName, firstToken } from '../services/sanctions/normalize.js';
import { tokenSetRatio, ratio, phoneticBoost } from '../services/sanctions/matcher.js';

describe('sanctions name normalization', () => {
  it('uppercases, folds diacritics, and strips punctuation', () => {
    expect(normalizeName('José García-López')).toBe('JOSE GARCIA LOPEZ');
  });

  it('canonicalizes corporate abbreviations to the long form', () => {
    expect(normalizeName('Acme Ltd')).toBe('ACME LIMITED');
    expect(normalizeName('ACME LIMITED')).toBe('ACME LIMITED');
    expect(normalizeName('Smith & Co')).toBe('SMITH AND COMPANY');
  });

  it('returns empty string for blank input', () => {
    expect(normalizeName('')).toBe('');
    expect(normalizeName(null)).toBe('');
  });

  it('firstToken takes the leading token only', () => {
    expect(firstToken('JOHN SMITH')).toBe('JOHN');
    expect(firstToken('MONONYM')).toBe('MONONYM');
  });
});

describe('token-set ratio', () => {
  it('scores identical names 1.0 regardless of token order', () => {
    expect(tokenSetRatio('JOHN SMITH', 'SMITH JOHN')).toBe(1);
  });

  it('scores unrelated names low', () => {
    expect(tokenSetRatio('JOHN SMITH', 'XAVIER QUIROGA')).toBeLessThan(0.5);
  });

  it('scores a near-miss spelling below an exact match but high', () => {
    const near = tokenSetRatio('JOHN SMITH', 'JON SMITH');
    expect(near).toBeGreaterThan(0.8);
    expect(near).toBeLessThan(1);
  });

  it('is tolerant of an extra middle token (subset pairing)', () => {
    expect(tokenSetRatio('JOHN SMITH', 'JOHN ALBERT SMITH')).toBe(1);
  });

  it('returns 0 for blank input', () => {
    expect(tokenSetRatio('', 'JOHN SMITH')).toBe(0);
  });
});

describe('ratio', () => {
  it('is 1 for equal strings and proportional to edit distance', () => {
    expect(ratio('ABCD', 'ABCD')).toBe(1);
    expect(ratio('ABCD', 'ABCX')).toBe(0.75);
  });
});

describe('phoneticBoost', () => {
  it('adds a small bump for phonetically equal names', async () => {
    expect(await phoneticBoost('SMITH', 'SMYTH')).toBe(0.05);
  });

  it('adds nothing for phonetically distinct names', async () => {
    expect(await phoneticBoost('SMITH', 'QUIROGA')).toBe(0);
  });
});
