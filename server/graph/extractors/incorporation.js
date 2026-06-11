const { z } = require('zod');
const { loadPrompt } = require('../../services/prompts');

const SubscriberSchema = z.object({
  name: z.string().describe('Full name of the initial subscriber / member'),
  sharesAllotted: z
    .number()
    .optional()
    .describe('Number of shares initially allotted to this subscriber, if stated'),
  // R6 — model self-assessment, advisory only (UI affordance, never routing).
  confidence: z
    .enum(['high', 'medium', 'low'])
    .optional()
    .describe('Your confidence that this record was read correctly from the source. Use "low" when the source is partially legible — never guess values.'),
});

const schema = z.object({
  incorporationDate: z
    .string()
    .optional()
    .describe('Date of incorporation in YYYY-MM-DD format if present'),
  initialSubscribers: z
    .array(SubscriberSchema)
    .describe('People or entities who subscribed to the memorandum at incorporation'),
});

const getPrompt = () => loadPrompt('extract.incorporation');

const ocrPolicy = 'ifLowText';

module.exports = { schema, getPrompt, ocrPolicy };
