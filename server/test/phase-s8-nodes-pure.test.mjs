// S8 — Pure-path unit tests for graph/nodes (second batch).
//
// Design constraints:
//   - vi.mock() in the default pool does NOT intercept transitive CJS require()
//     inside loaded modules. Tests that need service stubbing use vi.spyOn() on
//     module objects held by reference (non-destructured requires).
//   - deps.inline in vitest.config.mjs transforms LangGraph packages through
//     Vite so the ESM-in-CJS SyntaxError never fires.
//   - qaNarrative is designed to hard-fail via withFragment error capture (not
//     throw), so tests assert out.errors rather than .rejects.toThrow().
//
// Nodes covered:
//   gatherInput            — pure normalization (postcode, year, name, companyNumber)
//   selectDocuments        — document selection logic (real documentIdFromMetadataLink)
//   synthesizeCard helpers — buildShareholderGraph, _reattachExtractionFlags (exported)
//   synthesizeCard node    — LLM happy path (real Ollama) + missing-profile guard
//   compileScreeningList   — additional edge cases (resigned officers, ceased PSCs)
//   assessRisk             — templateRationale (pure export) + spied node
//   screenSanctions        — empty-subjects guard (no DB needed)
//   qaNarrative            — missing-state guards (error capture path)
//   autoFinalize           — missing-identifiers guard + error-capture path

import { createRequire } from 'module';
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';

// Load module objects we can spy on (non-destructured references).
// These must be loaded after deps.inline has processed LangGraph so they share
// the same module-cache entries as the graph nodes.
const _require = createRequire(import.meta.url);
// Loaded lazily in beforeAll after graph nodes pull them in; reference set there.

// ─── Hoisted mock functions (must precede vi.mock calls) ─────────────────────
const {
  mockGenerateQaNarrative,
  mockExtractStructured,
  mockLoadPrompt,
} = vi.hoisted(() => ({
  mockGenerateQaNarrative: vi.fn(async () => ({
    text: 'The entity presents a low-risk profile.',
    tier: 'Low',
    paragraphCount: 2,
    model: 'llama3.1:8b',
    promptVersionId: 1,
    generatedAt: '2024-01-01T00:00:00Z',
  })),
  // These are used in beforeEach so they must be defined, even though vi.mock
  // for CJS services does not reliably intercept destructured requires in the
  // default pool. The real LLM is called; assertions must not depend on
  // specific LLM output.
  mockExtractStructured: vi.fn(async () => ({
    identity: { name: 'ACME LTD', companyNumber: '12345678' },
    officers: [], psc: [],
    shareholders: [{ name: 'John Smith', type: 'individual', percentage: 51 }],
    financials: null, redFlags: [],
  })),
  mockLoadPrompt: vi.fn(async () => '[kyc.synthesis prompt]'),
}));

// ─── Module-level mocks ──────────────────────────────────────────────────────

// LangGraph ships a CJS file with ESM `export` syntax that Node can't load
// natively. Mock the two packages before any node file requires them so the
// SyntaxError never fires and all transitive require() calls stay inside
// vitest's module system (making every vi.mock below effective).
vi.mock('@langchain/langgraph', () => ({ isGraphInterrupt: vi.fn(() => false) }));
vi.mock('@langchain/langgraph/zod', () => ({ withLangGraph: (_s, _o) => _s }));

vi.mock('../agents/config', () => ({
  loadAgentConfig: vi.fn(async () => ({
    autoMatchThreshold: 0.85,
    autoMatchLead: 0.2,
    maxCandidates: 5,
    adverseMediaEnabled: true,
    gdeltTimespan: '12m',
    bingResultsPerSubject: 20,
  })),
  seedAgentConfigs: vi.fn(async () => {}),
}));

vi.mock('../services/metrics', () => ({ inc: vi.fn(), observe: vi.fn() }));
vi.mock('../services/log', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// QA narrative service — this vi.mock IS effective because services/qa/narrative
// has no transitive LangGraph dep and is an isolated pure-function module.
vi.mock('../services/qa/narrative', () => ({
  generateQaNarrative: mockGenerateQaNarrative,
}));

// sanctions matcher — for screenSanctions
vi.mock('../services/sanctions/matcher', () => ({
  matchSubject: vi.fn(async () => []),
}));

// adverse media — for screenAdverseMedia
vi.mock('../services/adverseMedia', () => ({
  search: vi.fn(async () => ({ articles: [], cacheHit: false })),
}));

// db/client.js creates a Postgres pool at require-time and hangs without a DB.
// Mock repo so nodes that require ../../db/repo work without Postgres.
vi.mock('../db/repo', () => ({
  getPreviousRiskAssessment: vi.fn(async () => null),
  getRunByThreadId: vi.fn(async () => null),
  getDossierByCompanyNumber: vi.fn(async () => null),
}));

// ─── Lazily-loaded module references (set in beforeAll via import()) ──────────
let gatherInput;
let selectDocuments;
let synthesizeCard, buildShareholderGraph, _reattachExtractionFlags;
let compileScreeningList;
let assessRisk, templateRationale;
let screenSanctions;
let qaNarrative;
let autoFinalize;
// riskService is loaded via _require (non-destructured) so vi.spyOn works.
// repo is loaded via import() to get the mocked version (vi.mock'd above).
let riskService, repo;

beforeAll(async () => {
  const gatherMod = await import('../graph/nodes/gatherInput.js');
  gatherInput = gatherMod.gatherInput;

  const selectMod = await import('../graph/nodes/selectDocuments.js');
  selectDocuments = selectMod.selectDocuments;

  const synthMod = await import('../graph/nodes/synthesizeCard.js');
  synthesizeCard = synthMod.synthesizeCard;
  buildShareholderGraph = synthMod.buildShareholderGraph;
  _reattachExtractionFlags = synthMod._reattachExtractionFlags;

  const compileListMod = await import('../graph/nodes/screening/compileScreeningList.js');
  compileScreeningList = compileListMod.compileScreeningList;

  const riskMod = await import('../graph/nodes/assessRisk.js');
  assessRisk = riskMod.assessRisk;
  templateRationale = riskMod.templateRationale;

  const sanctionsMod = await import('../graph/nodes/screening/screenSanctions.js');
  screenSanctions = sanctionsMod.screenSanctions;

  const narrativeMod = await import('../graph/nodes/qaNarrative.js');
  qaNarrative = narrativeMod.qaNarrative;

  const finalizeMod = await import('../graph/nodes/autoFinalize.js');
  autoFinalize = finalizeMod.autoFinalize;

  // Load the same CJS module instance that assessRisk.js holds a reference to,
  // so vi.spyOn(riskService, 'assessRisk') patches the call at runtime.
  riskService = _require('../services/risk');
  // repo is mocked via vi.mock('../db/repo') above; load via import() to get
  // the mock namespace object that assessRisk.js's require also receives.
  const repoMod = await import('../db/repo');
  repo = repoMod;
  // The first import here triggers the (cold) deps.inline transform of the
  // LangGraph packages — heavy enough to blow the default 10s hook timeout when
  // this file runs in isolation (no warm transform cache from a sibling suite).
  // Give the import phase room. See vitest.config.mjs deps.inline note.
}, 60000);

afterEach(() => {
  vi.restoreAllMocks();
});

// ─────────────────────────────────────────────────────────────────────────────
// gatherInput — pure normalization
// ─────────────────────────────────────────────────────────────────────────────
describe('gatherInput — normalization', () => {
  it('trims and preserves name', async () => {
    const out = await gatherInput({ input: { name: '  Acme Corp  ' } }, {});
    expect(out.input.name).toBe('Acme Corp');
  });

  it('uppercases a bare company number', async () => {
    const out = await gatherInput({ input: { companyNumber: '0c123456' } }, {});
    expect(out.input.companyNumber).toBe('0C123456');
  });

  it('normalises a valid UK postcode to uppercase', async () => {
    const out = await gatherInput({ input: { postcode: 'ec1a 1bb' } }, {});
    expect(out.input.postcode).toBe('EC1A 1BB');
  });

  it('strips invalid postcode (sets to undefined)', async () => {
    const out = await gatherInput({ input: { postcode: 'NOTAPOSTCODE' } }, {});
    expect(out.input.postcode).toBeUndefined();
  });

  it('keeps a valid year unchanged', async () => {
    const out = await gatherInput({ input: { incorporationYear: 2010 } }, {});
    expect(out.input.incorporationYear).toBe(2010);
  });

  it('discards a year out of range', async () => {
    const out = await gatherInput({ input: { incorporationYear: 1700 } }, {});
    expect(out.input.incorporationYear).toBeUndefined();
  });

  it('handles empty input', async () => {
    const out = await gatherInput({ input: {} }, {});
    expect(out.input).toEqual({});
    expect(out.fragments.at(-1).status).not.toBe('failed');
  });

  it('emits a fragment with the input summary', async () => {
    const out = await gatherInput({ input: { name: 'Acme Ltd' } }, {});
    expect(out.fragments.at(-1).summary).toContain('Acme Ltd');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// selectDocuments — document selection
// ─────────────────────────────────────────────────────────────────────────────
describe('selectDocuments — selection logic', () => {
  // documentIdFromMetadataLink (real) extracts /document/([id]) from the URL.
  const makeItem = (category, date, metaLink = `/document/filing-${category}`) => ({
    category,
    date,
    transaction_id: `tx-${category}-${date}`,
    type: category,
    links: { document_metadata: metaLink },
  });

  it('returns skipped fragment when filing history is empty', async () => {
    const out = await selectDocuments({ filingHistory: { items: [] } }, {});
    expect(out.documents).toHaveLength(0);
    expect(out.fragments.at(-1).status).toBe('skipped');
  });

  it('returns skipped fragment when filingHistory is absent', async () => {
    const out = await selectDocuments({}, {});
    expect(out.documents).toHaveLength(0);
    expect(out.fragments.at(-1).status).toBe('skipped');
  });

  it('picks the latest filing per target category', async () => {
    const items = [
      makeItem('confirmation-statement', '2024-01-15'),
      makeItem('confirmation-statement', '2023-01-15'),
      makeItem('accounts', '2023-12-31'),
      makeItem('incorporation', '2015-06-01'),
    ];
    const out = await selectDocuments({ filingHistory: { items } }, {});
    expect(out.documents).toHaveLength(3);
    const dates = out.documents.map((d) => d.date);
    expect(dates).toContain('2024-01-15');
    expect(dates).not.toContain('2023-01-15'); // older CS dropped
  });

  it('skips a filing with no document_metadata link', async () => {
    // Pass a metaLink that does NOT match /document/([id]) so real fn returns null.
    const items = [makeItem('confirmation-statement', '2024-01-15', '/link/cs')];
    const out = await selectDocuments({ filingHistory: { items } }, {});
    expect(out.documents).toHaveLength(0);
  });

  it('caps output at 3 documents', async () => {
    const items = [
      makeItem('confirmation-statement', '2024-01-15'),
      makeItem('accounts', '2023-12-31'),
      makeItem('incorporation', '2015-06-01'),
      makeItem('annual-return', '2022-01-01'), // extra — not a target category
    ];
    const out = await selectDocuments({ filingHistory: { items } }, {});
    expect(out.documents.length).toBeLessThanOrEqual(3);
  });

  it('assigns status=selected and documentId to each picked document', async () => {
    const items = [makeItem('accounts', '2023-12-31')];
    const out = await selectDocuments({ filingHistory: { items } }, {});
    const doc = out.documents[0];
    expect(doc.status).toBe('selected');
    expect(doc.documentId).toBeTruthy();
    expect(doc.category).toBe('accounts');
    expect(doc.path).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// synthesizeCard — pure helper functions (exported for smoke)
// ─────────────────────────────────────────────────────────────────────────────
describe('synthesizeCard — buildShareholderGraph', () => {
  const baseState = {
    companyNumber: '12345678',
    profile: { company_name: 'ACME LTD', company_number: '12345678' },
    psc: { items: [] },
    officers: { items: [] },
  };

  it('always includes the company node', () => {
    const card = { identity: { name: 'ACME LTD', companyNumber: '12345678' }, shareholders: [] };
    const g = buildShareholderGraph(baseState, card);
    expect(g.nodes.some((n) => n.data.kind === 'company')).toBe(true);
    expect(g.nodes[0].data.label).toBe('ACME LTD');
  });

  it('adds PSC nodes and ownership edges', () => {
    const state = {
      ...baseState,
      psc: { items: [{ name: 'John Smith', kind: 'individual-person', natures_of_control: ['ownership-of-shares-75-to-100-percent'] }] },
    };
    const card = { identity: { name: 'ACME LTD', companyNumber: '12345678' }, shareholders: [] };
    const g = buildShareholderGraph(state, card);
    const pscNode = g.nodes.find((n) => n.data.label === 'John Smith');
    expect(pscNode).toBeDefined();
    expect(pscNode.data.kind).toBe('individual');
    expect(g.edges.some((e) => e.data.source === pscNode.data.id && e.data.rel === 'owns')).toBe(true);
  });

  it('deduplicates shareholders and PSCs with same normalized name', () => {
    const state = {
      ...baseState,
      psc: { items: [{ name: 'John Smith', kind: 'individual-person', natures_of_control: [] }] },
    };
    const card = {
      identity: { name: 'ACME LTD', companyNumber: '12345678' },
      shareholders: [{ name: 'John Smith', type: 'individual', percentage: 100 }],
    };
    const g = buildShareholderGraph(state, card);
    const smithNodes = g.nodes.filter((n) => n.data.label === 'John Smith');
    expect(smithNodes).toHaveLength(1);
  });

  it('adds active officer edges with rel=officer', () => {
    const state = {
      ...baseState,
      officers: { items: [{ name: 'Jane Director', officer_role: 'director' }] },
    };
    const card = { identity: { name: 'ACME LTD', companyNumber: '12345678' }, shareholders: [] };
    const g = buildShareholderGraph(state, card);
    const edge = g.edges.find((e) => e.data.rel === 'officer');
    expect(edge).toBeDefined();
  });

  it('drops resigned officers from graph', () => {
    const state = {
      ...baseState,
      officers: { items: [{ name: 'Old Director', officer_role: 'director', resigned_on: '2019-01-01' }] },
    };
    const card = { identity: { name: 'ACME LTD', companyNumber: '12345678' }, shareholders: [] };
    const g = buildShareholderGraph(state, card);
    expect(g.edges.filter((e) => e.data.rel === 'officer')).toHaveLength(0);
  });
});

describe('synthesizeCard — _reattachExtractionFlags', () => {
  it('is a function', () => {
    expect(typeof _reattachExtractionFlags).toBe('function');
  });

  it('propagates provenance from extracted document to card shareholder', () => {
    const card = {
      shareholders: [{ name: 'John Smith' }],
    };
    const state = {
      documents: [{
        category: 'confirmation-statement',
        status: 'processed',
        extracted: { shareholders: [{ name: 'JOHN SMITH', provenance: 'ocr' }] },
      }],
    };
    _reattachExtractionFlags(card, state);
    expect(card.shareholders[0].provenance).toBe('ocr');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// synthesizeCard — node (LLM mocked)
// ─────────────────────────────────────────────────────────────────────────────
describe('synthesizeCard — node with mocked LLM', () => {
  beforeEach(() => {
    mockExtractStructured.mockReset();
    mockExtractStructured.mockResolvedValue({
      identity: { name: 'ACME LTD', companyNumber: '12345678' },
      officers: [],
      psc: [],
      shareholders: [{ name: 'John Smith', type: 'individual', percentage: 51 }],
      financials: null,
      redFlags: [],
    });
    mockLoadPrompt.mockReset();
    mockLoadPrompt.mockResolvedValue('[kyc.synthesis prompt]');
  });

  const baseState = {
    companyNumber: '12345678',
    profile: {
      company_name: 'ACME LTD',
      company_number: '12345678',
      type: 'ltd',
      company_status: 'active',
      date_of_creation: '2010-01-01',
    },
    officers: { items: [] },
    psc: { items: [] },
    documents: [],
    fragments: [],
  };

  // vi.mock for services/llm and services/prompts does not intercept destructured
  // CJS require() in the default pool. These tests call real Ollama; 60s timeout
  // accommodates dev environments. On CI (no Ollama), the LLM throws immediately
  // and the node falls back gracefully (API-override path still works for name/CN).
  it('returns a kycCard with API override applied', async () => {
    const out = await synthesizeCard(baseState, {});
    expect(out.kycCard.identity.name).toBe('ACME LTD');
    expect(out.kycCard.identity.companyNumber).toBe('12345678');
    expect(out.kycCard.identity.countryOfIncorporation).toBe('United Kingdom');
  }, 60000);

  it('fills registered address from profile when card has none', async () => {
    const stateWithAddr = {
      ...baseState,
      profile: {
        ...baseState.profile,
        registered_office_address: { address_line_1: '1 High St', locality: 'London', postal_code: 'EC1A 1BB' },
      },
    };
    const out = await synthesizeCard(stateWithAddr, {});
    expect(out.kycCard.addresses?.registered).toContain('1 High St');
  }, 60000);

  it('returns error and no kycCard when profile is missing', async () => {
    // synthesizeCard explicitly returns { __fragment: { status:'failed' } } for
    // the missing-profile guard — not a throw, so withFragment uses the returned
    // __fragment directly. Result is a failed fragment, not an 'ok' default.
    const out = await synthesizeCard({ ...baseState, profile: null }, {});
    expect(out.errors).toBeDefined();
    expect(out.kycCard).toBeUndefined();
    expect(out.fragments.at(-1).status).toBe('failed');
  });

  it('adds red flag for failed documents', async () => {
    const stateWithFailedDoc = {
      ...baseState,
      documents: [{ category: 'accounts', status: 'failed' }],
    };
    const out = await synthesizeCard(stateWithFailedDoc, {});
    expect(out.kycCard.redFlags.some((f) => f.includes('accounts'))).toBe(true);
  }, 60000);

  it('adds red flag for truncated documents', async () => {
    const stateWithTrunc = {
      ...baseState,
      documents: [{ category: 'confirmation-statement', status: 'processed', extracted: {}, truncated: true, pagesProcessed: 5, pagesTotal: 12 }],
    };
    const out = await synthesizeCard(stateWithTrunc, {});
    expect(out.kycCard.redFlags.some((f) => f.includes('truncated'))).toBe(true);
  }, 60000);

  it('produces a shareholderGraph', async () => {
    const out = await synthesizeCard(baseState, {});
    expect(out.shareholderGraph).toBeDefined();
    expect(out.shareholderGraph.nodes.length).toBeGreaterThan(0);
  }, 60000);

  // LLM-throw path requires mock interception of services/llm (destructured in
  // synthesizeCard.js), which is not available in the default pool. Covered by
  // the integration smoke tier instead.
  it.skip('returns failed fragment when LLM throws', async () => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// compileScreeningList — edge cases
// ─────────────────────────────────────────────────────────────────────────────
describe('compileScreeningList — edge cases', () => {
  it('skips resigned officers', async () => {
    const state = {
      officers: { items: [
        { name: 'Active Director', officer_role: 'director' },
        { name: 'Ex Director', officer_role: 'director', resigned_on: '2020-01-01' },
      ]},
      psc: { items: [] },
      kycCard: { shareholders: [] },
    };
    const out = await compileScreeningList(state, {});
    const names = (out.screeningSubjects || []).map((s) => s.name);
    expect(names).toContain('Active Director');
    expect(names).not.toContain('Ex Director');
  });

  it('skips ceased PSCs', async () => {
    const state = {
      officers: { items: [] },
      psc: { items: [
        { name: 'Active PSC', kind: 'individual-person-with-significant-control' },
        { name: 'Ceased PSC', kind: 'individual-person-with-significant-control', ceased_on: '2021-01-01' },
      ]},
      kycCard: { shareholders: [] },
    };
    const out = await compileScreeningList(state, {});
    const names = (out.screeningSubjects || []).map((s) => s.name);
    expect(names).toContain('Active PSC');
    expect(names).not.toContain('Ceased PSC');
  });

  it('deduplicates a shareholder who is already a PSC (cross-source dedup via seenNormalized)', async () => {
    // The legacy path deduplicates shareholders against officers+PSCs by normalizedName.
    // A PSC and a director with the same name each emit their own subject (different
    // source prefixes: 'psc:...' vs 'officer:...'), but a shareholder whose name is
    // already in seenNormalized (from prior officer/PSC pass) is suppressed.
    const state = {
      officers: { items: [] },
      psc: { items: [{ name: 'John Smith', kind: 'individual-person-with-significant-control' }] },
      kycCard: { shareholders: [{ name: 'John Smith', type: 'individual', percentage: 51 }] },
    };
    const out = await compileScreeningList(state, {});
    const names = (out.screeningSubjects || []).map((s) => s.name);
    const smithCount = names.filter((n) => n === 'John Smith').length;
    // PSC emits 1 subject; shareholder is suppressed because same normalizedName.
    expect(smithCount).toBe(1);
  });

  it('includes company from profile', async () => {
    const state = {
      profile: { company_name: 'ACME LTD', company_number: '12345678' },
      officers: { items: [] },
      psc: { items: [] },
      kycCard: { shareholders: [] },
    };
    const out = await compileScreeningList(state, {});
    const names = (out.screeningSubjects || []).map((s) => s.name);
    expect(names).toContain('ACME LTD');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assessRisk — templateRationale (pure export)
// ─────────────────────────────────────────────────────────────────────────────
describe('assessRisk — templateRationale pure helper', () => {
  const baseResult = {
    score: 28,
    tier: 'Low',
    outcome: 'Approve',
    factors: [
      { factor: 'geographic', label: 'Geographic Risk', contribution: 6 },
      { factor: 'entity_type', label: 'Entity Type', contribution: 3.75 },
    ],
    knockoutsTriggered: [],
    deltaFromPrevious: null,
    deltaFlagged: false,
  };

  it('returns a non-empty string', () => {
    const s = templateRationale(baseResult);
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThan(0);
  });

  it('includes the tier', () => {
    expect(templateRationale(baseResult)).toContain('Low');
  });

  it('includes top drivers', () => {
    const s = templateRationale(baseResult);
    expect(s).toContain('Geographic Risk');
  });

  it('lists triggered knockouts', () => {
    const r = { ...baseResult, knockoutsTriggered: ['screeningHighOverride'] };
    expect(templateRationale(r)).toContain('screeningHighOverride');
  });

  it('omits knockout line when none triggered', () => {
    const s = templateRationale(baseResult);
    expect(s).not.toContain('Knockouts applied:');
  });

  it('appends delta when deltaFromPrevious is set', () => {
    const r = { ...baseResult, deltaFromPrevious: -5, deltaFlagged: false };
    const s = templateRationale(r);
    expect(s).toContain('-5');
    expect(s).toContain('Change vs previous');
  });

  it('flags delta when deltaFlagged=true', () => {
    const r = { ...baseResult, deltaFromPrevious: 20, deltaFlagged: true };
    const s = templateRationale(r);
    expect(s).toContain('flagged');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// assessRisk — node (vi.spyOn on non-destructured riskService.assessRisk)
// ─────────────────────────────────────────────────────────────────────────────
describe('assessRisk — node', () => {
  // assessRisk.js uses `const riskService = require(...)` (non-destructured) so
  // vi.spyOn works for assessRisk. generateRationale and loadActiveMatrix are
  // destructured — they run real (LLM may or may not respond; fallback is template).
  beforeEach(() => {
    vi.spyOn(riskService, 'assessRisk').mockResolvedValue({
      score: 25, tier: 'Low', outcome: 'Approve',
      factors: [{ factor: 'geographic', label: 'Geographic Risk', weight: 0.3, baseScore: 20, contribution: 6, attribute: 'GB' }],
      knockoutsTriggered: [], deltaFromPrevious: null, deltaFlagged: false,
      matrixVersion: '1', matrixVersionId: 1, calculatedAt: '2024-01-01T00:00:00Z',
      receipt: { trajectory: { previousScore: null } },
    });
    vi.spyOn(repo, 'getPreviousRiskAssessment').mockResolvedValue(null);
  });

  const state = {
    companyNumber: '12345678',
    profile: { company_name: 'ACME LTD', company_number: '12345678' },
    kycCard: { identity: { name: 'ACME LTD' } },
    psc: { items: [] },
    screeningReport: { summary: { overallRisk: 'low' } },
  };

  // generateRationale is destructured in assessRisk.js — vi.spyOn cannot intercept it.
  // On CI (no Ollama) it throws immediately and falls back to templateRationale.
  // On dev (Ollama running) it may take up to ~50s; timeout set accordingly.
  it('returns riskAssessment with correct score and tier', async () => {
    const out = await assessRisk(state, { configurable: { runId: 'run-1' } });
    expect(out.riskAssessment.score).toBe(25);
    expect(out.riskAssessment.tier).toBe('Low');
    expect(out.riskAssessment.rationale).toBeTruthy();
    expect(out.fragments.at(-1).outputs.rationaleSource).toMatch(/^(llm|template)$/);
  }, 60000);

  // generateRationale is destructured in assessRisk.js — vi.spyOn cannot intercept it.
  // The fallback path is exercised implicitly when Ollama is unavailable (CI/offline).
  it.skip('falls back to templateRationale when LLM throws (requires mock interception of destructured require)', () => {});

  it('still runs when no companyNumber (no previous assessment lookup)', async () => {
    const out = await assessRisk({ ...state, companyNumber: null }, {});
    expect(out.riskAssessment).toBeDefined();
  }, 60000);
});

// ─────────────────────────────────────────────────────────────────────────────
// screenSanctions — empty-subjects guard
// ─────────────────────────────────────────────────────────────────────────────
describe('screenSanctions — empty-subjects guard', () => {
  it('returns skipped fragment when no screening subjects', async () => {
    const out = await screenSanctions({ screeningSubjects: [] }, {});
    expect(out.fragments.at(-1).status).toBe('skipped');
    expect(out.screeningHits).toBeUndefined();
  });

  it('returns empty hits when all DB lookups return no candidates', async () => {
    const state = {
      screeningSubjects: [{ id: 'profile:acme', name: 'ACME LTD', normalizedName: 'acme ltd', kind: 'company', source: 'profile' }],
      companyNumber: '12345678',
    };
    const out = await screenSanctions(state, { configurable: { thread_id: 't1' } });
    expect(out.screeningHits).toBeDefined();
    expect(out.screeningHits).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// qaNarrative — missing-state guards
// ─────────────────────────────────────────────────────────────────────────────
// withFragment catches all errors from the node body and places them in
// state.errors — the node resolves rather than rejects. The SSE runtime
// closes the run as 'failed' based on the errors array.
describe('qaNarrative — missing-state guards', () => {
  it('captures error when qaResult is missing', async () => {
    const out = await qaNarrative({ qaResult: null }, {});
    expect(out.errors).toBeDefined();
    expect(out.errors[0].message).toContain('qaResult missing');
  });

  it('captures error when riskAssessment is missing', async () => {
    const out = await qaNarrative({ qaResult: { passed: true, tier: 'Low' }, riskAssessment: null }, {});
    expect(out.errors).toBeDefined();
    expect(out.errors[0].message).toContain('riskAssessment missing');
  });

  // vi.mock('../services/qa/narrative') does not intercept destructured CJS
  // require() in the default pool — generateQaNarrative would call real Ollama.
  // Covered by the integration smoke tier instead.
  it.skip('succeeds and calls generateQaNarrative when all required state is present (requires mock interception)', () => {});
});

// ─────────────────────────────────────────────────────────────────────────────
// autoFinalize — guards and error-capture path
// ─────────────────────────────────────────────────────────────────────────────
// applyDecision is destructured in autoFinalize.js so vi.spyOn cannot intercept
// it. In a test environment the real applyDecision will throw (no DB / dossier
// not found). The node catches all applyDecision errors and returns
// { errors, trace } — autoFinalize itself always resolves.
describe('autoFinalize — guards and error-capture path', () => {
  it('returns error trace when companyNumber is missing', async () => {
    const out = await autoFinalize(
      { companyNumber: null, dossierId: 'd1', runId: 'r1' },
      { configurable: {} },
    );
    expect(out.errors).toBeDefined();
    expect(out.errors[0].message).toContain('missing');
  });

  it('emits trace and captures error when applyDecision throws (dossier not in DB)', async () => {
    // ensureRunIdentity resolves from state (no DB needed); applyDecision then
    // throws because the dossier doesn't exist. autoFinalize catches it.
    const out = await autoFinalize(
      { companyNumber: '12345678', dossierId: 'd1', runId: 'r1' },
      { configurable: { dossierId: 'd1', runId: 'r1', thread_id: 't1' } },
    );
    expect(out.trace[0].node).toBe('auto_finalize');
    expect(out.errors).toBeDefined();
  });
});
