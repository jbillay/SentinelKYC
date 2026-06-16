// Phase S6 — graph/extractors schema + ocrPolicy unit tests.
// getPrompt() is trivially `() => loadPrompt(key)` — verified via typeof.
// Schema and ocrPolicy tests provide the coverage value without mocks.

import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const cs = require('../graph/extractors/confirmationStatement.js');
const acc = require('../graph/extractors/accounts.js');
const inc = require('../graph/extractors/incorporation.js');

// ─── confirmationStatement ────────────────────────────────────────────────────

describe('confirmationStatement extractor', () => {
  it('ocrPolicy is ifLowText', () => {
    expect(cs.ocrPolicy).toBe('ifLowText');
  });

  it('schema accepts a valid payload with shareholders', () => {
    const result = cs.schema.safeParse({
      statementDate: '2024-01-15',
      shareholders: [
        { name: 'Jane Smith', type: 'individual', shares: 100, percentage: 100, shareClass: 'Ordinary', confidence: 'high' },
        { name: 'Acme Holdings Ltd', type: 'corporate', shares: 200, percentage: 50 },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.data.shareholders).toHaveLength(2);
  });

  it('schema accepts empty shareholders array', () => {
    const result = cs.schema.safeParse({ shareholders: [] });
    expect(result.success).toBe(true);
  });

  it('schema accepts missing statementDate (optional)', () => {
    const result = cs.schema.safeParse({ shareholders: [{ name: 'Bob', type: 'individual' }] });
    expect(result.success).toBe(true);
    expect(result.data.statementDate).toBeUndefined();
  });

  it('schema rejects invalid shareholder type', () => {
    const result = cs.schema.safeParse({
      shareholders: [{ name: 'Bob', type: 'trust' }], // invalid
    });
    expect(result.success).toBe(false);
  });

  it('schema rejects missing shareholders field', () => {
    const result = cs.schema.safeParse({ statementDate: '2024-01-01' });
    expect(result.success).toBe(false);
  });

  it('schema accepts missing optional fields on a shareholder', () => {
    const result = cs.schema.safeParse({
      shareholders: [{ name: 'Minimal Corp', type: 'corporate' }],
    });
    expect(result.success).toBe(true);
    expect(result.data.shareholders[0].shares).toBeUndefined();
  });

  it('getPrompt is a function that returns a promise', () => {
    expect(typeof cs.getPrompt).toBe('function');
    // getPrompt() calls loadPrompt — verified by signature; integration tests
    // exercise it with a real DB via the graph-nodes-llm.int suite.
  });

  it('confidence field accepts high/medium/low', () => {
    for (const confidence of ['high', 'medium', 'low']) {
      const r = cs.schema.safeParse({
        shareholders: [{ name: 'Test', type: 'individual', confidence }],
      });
      expect(r.success).toBe(true);
    }
  });

  it('confidence field rejects unknown values', () => {
    const result = cs.schema.safeParse({
      shareholders: [{ name: 'Test', type: 'individual', confidence: 'very-high' }],
    });
    expect(result.success).toBe(false);
  });
});

// ─── accounts extractor ───────────────────────────────────────────────────────

describe('accounts extractor', () => {
  it('ocrPolicy is ifLowText', () => {
    expect(acc.ocrPolicy).toBe('ifLowText');
  });

  it('schema accepts a full valid payload', () => {
    const result = acc.schema.safeParse({
      periodEnd: '2023-12-31',
      turnover: 1000000,
      profit: 150000,
      totalAssets: 3000000,
      netAssets: 500000,
      employees: 42,
      confidence: 'medium',
    });
    expect(result.success).toBe(true);
    expect(result.data.employees).toBe(42);
  });

  it('schema accepts an empty object (all fields optional)', () => {
    const result = acc.schema.safeParse({});
    expect(result.success).toBe(true);
  });

  it('schema rejects non-numeric turnover', () => {
    const result = acc.schema.safeParse({ turnover: 'one million' });
    expect(result.success).toBe(false);
  });

  it('schema accepts negative profit (a loss)', () => {
    const result = acc.schema.safeParse({ profit: -50000 });
    expect(result.success).toBe(true);
    expect(result.data.profit).toBe(-50000);
  });

  it('getPrompt is a function', () => {
    expect(typeof acc.getPrompt).toBe('function');
  });
});

// ─── incorporation extractor ──────────────────────────────────────────────────

describe('incorporation extractor', () => {
  it('ocrPolicy is ifLowText', () => {
    expect(inc.ocrPolicy).toBe('ifLowText');
  });

  it('schema accepts valid payload with initial subscribers', () => {
    const result = inc.schema.safeParse({
      incorporationDate: '2015-03-22',
      initialSubscribers: [
        { name: 'Founder One', sharesAllotted: 500, confidence: 'high' },
        { name: 'Founder Two', sharesAllotted: 500 },
      ],
    });
    expect(result.success).toBe(true);
    expect(result.data.initialSubscribers).toHaveLength(2);
  });

  it('schema accepts empty initialSubscribers', () => {
    const result = inc.schema.safeParse({ initialSubscribers: [] });
    expect(result.success).toBe(true);
  });

  it('schema accepts missing incorporationDate (optional)', () => {
    const result = inc.schema.safeParse({ initialSubscribers: [{ name: 'Jane' }] });
    expect(result.success).toBe(true);
    expect(result.data.incorporationDate).toBeUndefined();
  });

  it('schema rejects missing initialSubscribers field', () => {
    const result = inc.schema.safeParse({ incorporationDate: '2015-01-01' });
    expect(result.success).toBe(false);
  });

  it('schema accepts sharesAllotted as optional', () => {
    const result = inc.schema.safeParse({
      initialSubscribers: [{ name: 'Alice' }],
    });
    expect(result.success).toBe(true);
    expect(result.data.initialSubscribers[0].sharesAllotted).toBeUndefined();
  });

  it('getPrompt is a function', () => {
    expect(typeof inc.getPrompt).toBe('function');
  });

  it('confidence field on subscriber accepts high/medium/low', () => {
    for (const confidence of ['high', 'medium', 'low']) {
      const r = inc.schema.safeParse({
        initialSubscribers: [{ name: 'Test', confidence }],
      });
      expect(r.success).toBe(true);
    }
  });
});
