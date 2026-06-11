const { z } = require('zod');
const { loadPrompt } = require('../../services/prompts');

const schema = z.object({
  periodEnd: z
    .string()
    .optional()
    .describe('End date of the accounting period in YYYY-MM-DD format if present'),
  turnover: z
    .number()
    .optional()
    .describe('Reported turnover / revenue in GBP, plain number with no commas'),
  profit: z
    .number()
    .optional()
    .describe('Profit or loss for the period in GBP (negative if a loss)'),
  totalAssets: z
    .number()
    .optional()
    .describe('Total assets in GBP'),
  netAssets: z
    .number()
    .optional()
    .describe('Net assets / shareholders funds in GBP'),
  employees: z
    .number()
    .optional()
    .describe('Average number of employees during the period'),
  // R6 — model self-assessment, advisory only (UI affordance, never routing).
  confidence: z
    .enum(['high', 'medium', 'low'])
    .optional()
    .describe('Your confidence that the figures were read correctly from the source. Use "low" when the source is partially legible — never guess values.'),
});

const getPrompt = () => loadPrompt('extract.accounts');

const ocrPolicy = 'ifLowText';

module.exports = { schema, getPrompt, ocrPolicy };
