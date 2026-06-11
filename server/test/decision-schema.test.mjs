import { describe, it, expect } from 'vitest';
import { decisionPayloadSchema, REASON_CODES } from '../lib/decisionSchema.js';

const ok = (payload) => decisionPayloadSchema.safeParse(payload).success;

describe('decision payload schema (server twin)', () => {
  it('accepts a minimal approve', () => {
    expect(ok({ action: 'approve', userId: 'u1' })).toBe(true);
  });

  it('rejects approve without a userId', () => {
    expect(ok({ action: 'approve' })).toBe(false);
    expect(ok({ action: 'approve', userId: '' })).toBe(false);
  });

  it('requires reasonCode + freeText >= 10 chars on reject', () => {
    expect(
      ok({ action: 'reject', userId: 'u1', reasonCode: 'sanctions_hit', freeText: 'Confirmed OFAC SDN match.' })
    ).toBe(true);
    expect(ok({ action: 'reject', userId: 'u1', reasonCode: 'sanctions_hit', freeText: 'too short' })).toBe(false);
    expect(ok({ action: 'reject', userId: 'u1', reasonCode: 'not_a_code', freeText: 'long enough text here' })).toBe(false);
  });

  it('requires notes >= 10 chars on escalate; suggestedAction optional', () => {
    expect(ok({ action: 'escalate', userId: 'u1', notes: 'Needs a senior look at the PSC chain.' })).toBe(true);
    expect(ok({ action: 'escalate', userId: 'u1', notes: 'short' })).toBe(false);
    expect(
      ok({ action: 'escalate', userId: 'u1', notes: 'Needs a senior look.', suggestedAction: 'reject' })
    ).toBe(true);
  });

  it('requires at least one well-formed item on request_info', () => {
    expect(
      ok({ action: 'request_info', userId: 'u1', items: [{ description: 'Latest accounts', category: 'documents' }] })
    ).toBe(true);
    expect(ok({ action: 'request_info', userId: 'u1', items: [] })).toBe(false);
    expect(ok({ action: 'request_info', userId: 'u1', items: [{ description: 'ab', category: 'documents' }] })).toBe(false);
  });

  it('rejects unknown actions', () => {
    expect(ok({ action: 'defer', userId: 'u1' })).toBe(false);
  });

  it('keeps the reason-code enum stable', () => {
    expect(REASON_CODES).toContain('sanctions_hit');
    expect(REASON_CODES).toContain('other');
  });
});
