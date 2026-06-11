import { describe, it, expect } from 'vitest';
import {
  nameCanonical,
  canonicalTokens,
  isStrictSubset,
} from '../services/party/canonical.js';

// JS twin of the SQL name_canonical() from migration 0012 — these tests pin
// the four documented steps (fold, strip honorifics, punctuation, sort) so a
// drift from the SQL side shows up as a failing unit test, not a duplicate
// node on the ownership graph.
describe('nameCanonical', () => {
  it('lowercases and sorts tokens so order never matters', () => {
    expect(nameCanonical('John Smith')).toBe('john smith');
    expect(nameCanonical('Smith John')).toBe('john smith');
  });

  it('strips honorifics (the original duplicate-node bug)', () => {
    expect(nameCanonical('Mr Vincent Huard')).toBe('huard vincent');
    expect(nameCanonical('Dr. John Smith')).toBe('john smith');
    expect(nameCanonical('Mme Claire Dubois')).toBe('claire dubois');
  });

  it('does not eat names that merely start like an honorific', () => {
    expect(nameCanonical('Mary Morten')).toBe('mary morten');
    expect(nameCanonical('Drake Mills')).toBe('drake mills');
  });

  it('folds diacritics, including letters NFD cannot decompose', () => {
    expect(nameCanonical('José García')).toBe('garcia jose');
    expect(nameCanonical('Łukasz Møller')).toBe('lukasz moller');
    expect(nameCanonical('Æthel Þór')).toBe('aethel thor');
  });

  it('removes apostrophes but spaces other punctuation', () => {
    expect(nameCanonical("Patrick O'Hara")).toBe('ohara patrick');
    expect(nameCanonical('Smith-Jones, Anna')).toBe('anna jones smith');
  });

  it('returns empty string for blank input', () => {
    expect(nameCanonical(null)).toBe('');
    expect(nameCanonical('')).toBe('');
    expect(nameCanonical('  --  ')).toBe('');
  });
});

describe('canonicalTokens', () => {
  it('dedupes repeated tokens', () => {
    expect(canonicalTokens('John John Smith')).toEqual(['john', 'smith']);
  });

  it('returns empty array for blank input', () => {
    expect(canonicalTokens('')).toEqual([]);
  });
});

describe('isStrictSubset', () => {
  const full = canonicalTokens('Vincent Matthieu Benjamin Huard');

  it('folds a partial name onto the full name', () => {
    expect(isStrictSubset(canonicalTokens('Vincent Huard'), full)).toBe(true);
  });

  it('rejects a lone token (never absorb on forename alone)', () => {
    expect(isStrictSubset(canonicalTokens('Vincent'), full)).toBe(false);
  });

  it('rejects equal sets (strict subset only)', () => {
    expect(isStrictSubset(full, full)).toBe(false);
  });

  it('rejects tokens missing from the superset', () => {
    expect(isStrictSubset(canonicalTokens('Vincent Smith'), full)).toBe(false);
  });
});
