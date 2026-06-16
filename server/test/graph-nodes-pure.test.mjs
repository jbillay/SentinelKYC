// Phase 4 — graph nodes / helpers that depend only on pure code (no DB, no LLM,
// no registry I/O): selectDocuments, assessRisk's templateRationale, and the
// state helpers + schemas.
import { describe, it, expect } from 'vitest';
import { selectDocuments } from '../graph/nodes/selectDocuments.js';
import { gatherInput } from '../graph/nodes/gatherInput.js';
import { templateRationale } from '../graph/nodes/assessRisk.js';
import { traceEvent, errorEvent, RiskAssessmentSchema, QaResultSchema } from '../graph/state.js';

const DOC_LINK = 'https://document-api.company-information.service.gov.uk/document/DOC-1';

describe('gatherInput node (pure)', () => {
  it('normalises name, company number, postcode and year', async () => {
    const out = await gatherInput({ input: {
      name: '  ACME  ', companyNumber: ' ab123456 ', postcode: 'ec1a 1aa', incorporationYear: '2010',
    } }, {});
    expect(out.input).toEqual({ name: 'ACME', companyNumber: 'AB123456', postcode: 'EC1A 1AA', incorporationYear: 2010 });
  });

  it('drops an invalid postcode and an out-of-range year', async () => {
    const out = await gatherInput({ input: { name: 'X', postcode: 'NOPE', incorporationYear: 1700 } }, {});
    expect(out.input.postcode).toBeUndefined();
    expect(out.input.incorporationYear).toBeUndefined();
  });
});

describe('selectDocuments node', () => {
  it('skips when there is no filing history', async () => {
    const out = await selectDocuments({ filingHistory: { items: [] } }, {});
    expect(out.documents).toEqual([]);
    expect(out.fragments[0].status).toBe('skipped');
  });

  it('picks the latest filing per target category, capped at 3', async () => {
    const items = [
      { category: 'confirmation-statement', date: '2022-01-01', transaction_id: 'cs-old', links: { document_metadata: DOC_LINK } },
      { category: 'confirmation-statement', date: '2024-06-15', transaction_id: 'cs-new', links: { document_metadata: DOC_LINK } },
      { category: 'accounts', date: '2023-12-31', transaction_id: 'acc', links: { document_metadata: DOC_LINK } },
      { category: 'incorporation', date: '2010-01-01', transaction_id: 'inc', links: { document_metadata: DOC_LINK } },
      { category: 'gazette', date: '2024-01-01', transaction_id: 'gz', links: { document_metadata: DOC_LINK } }, // not a target
    ];
    const out = await selectDocuments({ filingHistory: { items } }, {});
    expect(out.documents).toHaveLength(3);
    const cs = out.documents.find((d) => d.category === 'confirmation-statement');
    expect(cs.transactionId).toBe('cs-new'); // latest by date
    expect(out.documents.map((d) => d.category)).not.toContain('gazette');
  });

  it('skips a filing whose document_metadata link is missing', async () => {
    const items = [{ category: 'accounts', date: '2023-12-31', transaction_id: 'acc', links: {} }];
    const out = await selectDocuments({ filingHistory: { items } }, {});
    expect(out.documents).toHaveLength(0);
    expect(out.fragments[0].outputs.skipped[0].reason).toMatch(/no document_metadata/);
  });
});

describe('assessRisk templateRationale (pure fallback)', () => {
  it('renders outcome/score/tier with the top drivers and knockouts', () => {
    const s = templateRationale({
      outcome: 'High',
      score: 88,
      tier: 'High',
      factors: [
        { factor: 'geographic', label: 'Geographic risk', contribution: 27 },
        { factor: 'industry', label: 'Industry risk', contribution: 16 },
      ],
      knockoutsTriggered: ['screeningHighOverride'],
      deltaFromPrevious: 20,
      deltaFlagged: true,
    });
    expect(s).toContain('High');
    expect(s).toContain('88');
    expect(s).toContain('Geographic risk (27)');
    expect(s).toContain('Knockouts applied: screeningHighOverride.');
    expect(s).toContain('+20 (flagged)');
  });

  it('omits the delta clause when there is no previous run', () => {
    const s = templateRationale({ outcome: 'Low', score: 5, tier: 'Low', factors: [], knockoutsTriggered: [] });
    expect(s).not.toContain('Change vs previous');
  });
});

describe('state helpers + schemas', () => {
  it('traceEvent and errorEvent stamp node/msg/ts', () => {
    const t = traceEvent('searchCh', 'searching', { q: 'acme' });
    expect(t).toMatchObject({ node: 'searchCh', msg: 'searching', extra: { q: 'acme' } });
    expect(typeof t.ts).toBe('number');
    expect(errorEvent('fetchApis', 'boom')).toMatchObject({ node: 'fetchApis', message: 'boom' });
  });

  it('RiskAssessmentSchema validates a well-formed assessment and applies defaults', () => {
    const parsed = RiskAssessmentSchema.parse({
      score: 12, tier: 'Low', outcome: 'Low', calculatedAt: '2026-01-01T00:00:00Z',
    });
    expect(parsed.factors).toEqual([]);
    expect(parsed.deltaFlagged).toBe(false);
  });

  it('QaResultSchema rejects an unknown caseStatus', () => {
    const bad = QaResultSchema.safeParse({
      passed: true,
      completeness: { passed: true },
      consistency: { passed: true },
      routing: { caseStatus: 'nope', qaSummary: 'x' },
      qaSummary: 'x',
      evaluatedAt: '2026-01-01T00:00:00Z',
    });
    expect(bad.success).toBe(false);
  });
});
