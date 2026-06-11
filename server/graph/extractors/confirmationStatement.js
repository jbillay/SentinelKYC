const { z } = require('zod');
const { loadPrompt } = require('../../services/prompts');

const ShareholderSchema = z.object({
  name: z.string().describe('Full legal name of the shareholder'),
  type: z
    .enum(['individual', 'corporate'])
    .describe('Whether the shareholder is a person or another company'),
  shares: z
    .number()
    .optional()
    .describe('Number of shares held, if stated'),
  percentage: z
    .number()
    .optional()
    .describe('Percentage of shares held, 0-100, if stated'),
  shareClass: z
    .string()
    .optional()
    .describe('Share class label, e.g. "Ordinary", "A Ordinary"'),
  // R6 — model self-assessment, advisory only. The risk/QA engines must
  // never read this; it drives reviewer-facing UI affordances only.
  confidence: z
    .enum(['high', 'medium', 'low'])
    .optional()
    .describe('Your confidence that this record was read correctly from the source. Use "low" when the source is partially legible — never guess values.'),
});

const schema = z.object({
  statementDate: z
    .string()
    .optional()
    .describe('Confirmation statement date in YYYY-MM-DD format if present'),
  shareholders: z
    .array(ShareholderSchema)
    .describe('All shareholders listed on the statement'),
});

const getPrompt = () => loadPrompt('extract.confirmation_statement');

// Modern e-filed confirmation statements have a clean text layer; only fall
// back to OCR when the text layer is too sparse to extract shareholders from
// (the global ifLowText threshold is 200 chars/page). This saves ~200-250s of
// OCR latency on the common case while still covering scanned-PDF filings.
// See CODE_REVIEW §4.4.
const ocrPolicy = 'ifLowText';

module.exports = { schema, getPrompt, ocrPolicy };
