// Phase 1 — scoreEntry + matchSubject (matcher.js lines the existing suite
// leaves uncovered) plus the normalize helpers.
import { describe, it, expect } from 'vitest';
import { scoreEntry, matchSubject, ratio, phoneticBoost } from '../services/sanctions/matcher.js';
import {
  normalizeName,
  foldDiacritics,
  expandCorpAbbrev,
  tokenize,
  tokenSort,
} from '../services/sanctions/normalize.js';

describe('scoreEntry', () => {
  it('scores against the primary normalized name', async () => {
    const r = await scoreEntry('JOHN SMITH', { normalized_name: 'JOHN SMITH', aliases: [] });
    expect(r.score).toBe(1);
    expect(r.matchedAlias).toBe('JOHN SMITH');
  });

  it('picks the best-scoring alias variant', async () => {
    const entry = {
      normalized_name: 'XAVIER QUIROGA',
      aliases: [{ normalized: 'JOHN SMITH' }, { normalized: 'JOHNNY SMITH' }],
    };
    const r = await scoreEntry('JOHN SMITH', entry);
    expect(r.matchedAlias).toBe('JOHN SMITH');
    expect(r.score).toBe(1);
  });

  it('ignores empty / malformed alias entries', async () => {
    const entry = { normalized_name: 'JOHN SMITH', aliases: [{ normalized: '' }, {}, null] };
    const r = await scoreEntry('JOHN SMITH', entry);
    expect(r.score).toBe(1);
  });

  it('caps a phonetic-boosted score at 1', async () => {
    const r = await scoreEntry('SMITH', { normalized_name: 'SMITH', aliases: [] });
    expect(r.score).toBeLessThanOrEqual(1);
  });
});

describe('matchSubject', () => {
  const candidates = [
    { normalized_name: 'JOHN SMITH', aliases: [] },
    { normalized_name: 'JON SMITH', aliases: [] },
    { normalized_name: 'XAVIER QUIROGA', aliases: [] },
  ];

  it('returns only entries at or above threshold, sorted by descending score', async () => {
    const out = await matchSubject({ name: 'John Smith' }, candidates, 0.8);
    expect(out.length).toBeGreaterThanOrEqual(2);
    expect(out[0].entry.normalized_name).toBe('JOHN SMITH');
    // monotonic non-increasing
    for (let i = 1; i < out.length; i++) expect(out[i - 1].score).toBeGreaterThanOrEqual(out[i].score);
    expect(out.map((m) => m.entry.normalized_name)).not.toContain('XAVIER QUIROGA');
  });

  it('uses a precomputed normalizedName when present', async () => {
    const out = await matchSubject({ normalizedName: 'JOHN SMITH' }, candidates, 0.99);
    expect(out).toHaveLength(1);
    expect(out[0].score).toBe(1);
  });

  it('returns nothing when no candidate clears a high threshold', async () => {
    const out = await matchSubject({ name: 'Zzz Nobody' }, candidates, 0.95);
    expect(out).toEqual([]);
  });
});

describe('phoneticBoost with precomputed code arrays', () => {
  it('accepts arrays of double-metaphone codes on either side', async () => {
    expect(await phoneticBoost(['SM0', 'XMT'], 'SMITH')).toBeGreaterThanOrEqual(0);
  });
  it('returns 0 on blank input', async () => {
    expect(await phoneticBoost('', 'SMITH')).toBe(0);
  });
});

describe('ratio edge cases', () => {
  it('treats two empty strings as identical', () => {
    expect(ratio('', '')).toBe(1);
  });
});

describe('normalize helpers', () => {
  it('foldDiacritics strips combining marks', () => {
    expect(foldDiacritics('José')).toBe('Jose');
  });
  it('tokenize splits on whitespace and drops blanks', () => {
    expect(tokenize('  a   b ')).toEqual(['a', 'b']);
  });
  it('tokenSort returns a sorted copy without mutating', () => {
    const input = ['c', 'a', 'b'];
    expect(tokenSort(input)).toEqual(['a', 'b', 'c']);
    expect(input).toEqual(['c', 'a', 'b']);
  });
  it('expandCorpAbbrev maps short forms to canonical long forms', () => {
    expect(expandCorpAbbrev(['ACME', 'LTD'])).toEqual(['ACME', 'LIMITED']);
    expect(expandCorpAbbrev(['&'])).toEqual(['AND']);
  });
  it('normalizeName coerces non-string input via String()', () => {
    expect(normalizeName(12345)).toBe('12345');
  });
});
