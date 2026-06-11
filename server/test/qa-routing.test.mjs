import { describe, it, expect } from 'vitest';
import { route } from '../services/qa/routingEngine.js';

// Tier-based routing: the tier is post-knockout, so a confirmed sanctions hit
// has already forced High before routing sees it.
describe('qa routing engine', () => {
  it('routes failed QA to standard_review regardless of tier', () => {
    const r = route({
      passed: false,
      tier: 'Low',
      completenessMissing: ['ubo_list'],
      consistencyIssues: [],
    });
    expect(r.caseStatus).toBe('standard_review');
    expect(r.qaSummary).toContain('QA failed');
  });

  it('routes passed + Low to auto_approved', () => {
    expect(route({ passed: true, tier: 'Low' }).caseStatus).toBe('auto_approved');
  });

  it('routes passed + Medium to streamlined_review', () => {
    expect(route({ passed: true, tier: 'Medium' }).caseStatus).toBe('streamlined_review');
  });

  it('routes passed + High to standard_review', () => {
    expect(route({ passed: true, tier: 'High' }).caseStatus).toBe('standard_review');
  });

  it('falls back to standard_review on a missing or unknown tier', () => {
    expect(route({ passed: true, tier: undefined }).caseStatus).toBe('standard_review');
    expect(route({ passed: true, tier: 'Bananas' }).caseStatus).toBe('standard_review');
  });
});
