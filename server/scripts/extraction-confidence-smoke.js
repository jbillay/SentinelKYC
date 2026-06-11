// P1 R6 — extraction confidence + provenance smoke (node-only, no DB/LLM).
//
// Covers the pure plumbing that carries the honesty flags:
//   1. Extractor schemas accept the optional `confidence` enum (and reject
//      junk values) — old data without it still validates.
//   2. State KycShareholderSchema / KycFinancialsSchema accept provenance +
//      confidence.
//   3. synthesizeCard's reattachExtractionFlags restores flags the LLM merge
//      dropped, by normalized-name match, and stamps financials from the
//      accounts extraction.
//
// The end-to-end version (real PDF → OCR → flags on the card) needs Ollama +
// fixtures and is exercised by a full run; this smoke keeps the contract
// pinned without that cost.

const confirmation = require('../graph/extractors/confirmationStatement');
const accounts = require('../graph/extractors/accounts');
const incorporation = require('../graph/extractors/incorporation');
const { _reattachExtractionFlags } = require('../graph/nodes/synthesizeCard');

function ok(label, cond, extra = '') {
  console.log(`${cond ? '  ✓' : '  ✗'} ${label}${extra ? ' — ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

console.log('[extraction-confidence:smoke] running');

// ----- 1: extractor schemas ---------------------------------------------
{
  const r = confirmation.schema.safeParse({
    shareholders: [{ name: 'Jane Doe', type: 'individual', confidence: 'low' }],
  });
  ok('confirmation schema accepts confidence', r.success, JSON.stringify(r.error?.issues?.[0] ?? ''));
}
{
  const r = confirmation.schema.safeParse({
    shareholders: [{ name: 'Jane Doe', type: 'individual' }],
  });
  ok('confirmation schema: confidence optional (old data validates)', r.success);
}
{
  const r = confirmation.schema.safeParse({
    shareholders: [{ name: 'Jane Doe', type: 'individual', confidence: 'certain' }],
  });
  ok('confirmation schema rejects junk confidence', r.success === false);
}
{
  const r = accounts.schema.safeParse({ turnover: 1000, confidence: 'medium' });
  ok('accounts schema accepts confidence', r.success);
}
{
  const r = incorporation.schema.safeParse({
    initialSubscribers: [{ name: 'Founder One', sharesAllotted: 100, confidence: 'high' }],
  });
  ok('incorporation schema accepts confidence', r.success);
}

// ----- 2: state schemas ---------------------------------------------------
{
  const { stateSchema } = require('../graph/state');
  const shape = stateSchema.shape ?? stateSchema._def.shape();
  const card = shape.kycCard;
  const parsed = card.safeParse({
    identity: { name: 'X Ltd', companyNumber: '123' },
    shareholders: [{ name: 'Jane Doe', provenance: 'ocr', confidence: 'low' }],
    financials: { turnover: 5, provenance: 'text', confidence: 'high' },
  });
  ok('state kycCard accepts provenance+confidence', parsed.success, JSON.stringify(parsed.error?.issues?.[0] ?? ''));
}

// ----- 3: reattachExtractionFlags ----------------------------------------
{
  const card = {
    shareholders: [
      { name: 'JANE  DOE', percentage: 50 }, // LLM-normalised casing/spacing
      { name: 'Acme Holdings Ltd', percentage: 50 },
    ],
    financials: { turnover: 1000 },
  };
  const state = {
    documents: [
      {
        category: 'confirmation-statement',
        status: 'processed',
        processedBy: 'ocr',
        extracted: {
          shareholders: [
            { name: 'Jane Doe', percentage: 50, provenance: 'ocr', confidence: 'low' },
          ],
        },
      },
      {
        category: 'accounts',
        status: 'processed',
        processedBy: 'text',
        extracted: { turnover: 1000, provenance: 'text', confidence: 'medium' },
      },
    ],
  };
  _reattachExtractionFlags(card, state);
  ok('shareholder flags reattached by normalized name',
    card.shareholders[0].provenance === 'ocr' && card.shareholders[0].confidence === 'low',
    JSON.stringify(card.shareholders[0]));
  ok('unmatched shareholder left unflagged',
    card.shareholders[1].provenance === undefined);
  ok('financials stamped from accounts extraction',
    card.financials.provenance === 'text' && card.financials.confidence === 'medium',
    JSON.stringify(card.financials));
}

console.log('[extraction-confidence:smoke] done');
