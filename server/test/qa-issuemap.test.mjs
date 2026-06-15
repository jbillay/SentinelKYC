// Phase 1 — full coverage of the QA issue-code → UI metadata map.
import { describe, it, expect } from 'vitest';
import { ISSUE_MAP, describe as describeCode, buildHighlightedIssues } from '../services/qa/issueMap.js';

describe('issueMap.describe', () => {
  it('returns the mapped metadata for every known code', () => {
    for (const [code, meta] of Object.entries(ISSUE_MAP)) {
      const d = describeCode(code);
      expect(d.severity).toBe(meta.severity);
      expect(d.anchor).toBe(meta.anchor);
      expect(typeof d.message).toBe('string');
    }
  });

  it('returns null for a falsy code', () => {
    expect(describeCode(null)).toBeNull();
    expect(describeCode('')).toBeNull();
  });

  it('expands the document_status:<category>:failed prefix into a per-filing message', () => {
    const d = describeCode('document_status:accounts:failed');
    expect(d.severity).toBe('low');
    expect(d.anchor).toBe('#documents');
    expect(d.message).toContain('accounts');
  });

  it('falls back to category="document" when the prefix has no category', () => {
    const d = describeCode('document_status:');
    expect(d.message).toContain('document');
  });

  it('falls back to a medium #identity default for an unknown code', () => {
    const d = describeCode('totally_new_code');
    expect(d).toEqual({ severity: 'medium', message: 'totally_new_code', anchor: '#identity' });
  });
});

describe('issueMap.buildHighlightedIssues', () => {
  it('returns an empty array for empty input', () => {
    expect(buildHighlightedIssues()).toEqual([]);
    expect(buildHighlightedIssues({})).toEqual([]);
  });

  it('maps missing + warning codes to their metadata', () => {
    const out = buildHighlightedIssues({
      missing: ['risk_score'],
      warnings: ['document_status:accounts:failed'],
    });
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ code: 'risk_score', severity: 'high', anchor: '#risk' });
    expect(out[1]).toMatchObject({ code: 'document_status:accounts:failed', severity: 'low' });
  });

  it('prefers the issue.message over the mapped default and carries evidence', () => {
    const out = buildHighlightedIssues({
      issues: [{ code: 'ubo_not_screened', message: 'custom message', evidence: { x: 1 } }],
    });
    expect(out[0].message).toBe('custom message');
    expect(out[0].evidence).toEqual({ x: 1 });
    expect(out[0].anchor).toBe('#screening');
  });

  it('falls back to the mapped message when issue.message is absent', () => {
    const out = buildHighlightedIssues({ issues: [{ code: 'ubo_not_screened' }] });
    expect(out[0].message).toBe(ISSUE_MAP.ubo_not_screened.message);
  });
});
