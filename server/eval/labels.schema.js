// Zod schemas for golden eval cases (R3). A malformed golden case must fail
// fast and loudly rather than silently skewing a metric — these are the gate.
//
// Three case types, discriminated on `type`:
//   - extraction      → a document's OCR/text + the known-correct extracted records
//   - sanctions       → a subject + a sanctions entry + the known confirm/dismiss truth
//   - adverse_media   → a subject + a news article + the known relevance/category truth
//
// `validateCase(obj)` returns the parsed case or throws a ZodError annotated
// with the case id when one is present.

const { z } = require('zod');

const SubjectSchema = z.object({
  name: z.string().min(1),
  kind: z.enum(['individual', 'corporate']).optional(),
  role: z.string().nullable().optional(),
  dob: z.string().nullable().optional(),
  nationality: z.string().nullable().optional(),
});

const RecordSetSchema = z.object({
  field: z.string().min(1), // property on the extracted object holding the array
  key: z.string().default('name'), // field used to match predicted ↔ expected records
  fields: z.array(z.string()).default(() => []), // scalar fields scored per matched record
});

const ExtractionCaseSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal('extraction'),
    category: z.enum(['confirmation-statement', 'accounts', 'incorporation']),
    description: z.string().optional(),
    // Frozen input: either inline OCR/text or a sibling text file (relative to
    // the case file). Keeps the corpus reproducible + offline.
    inputText: z.string().optional(),
    inputTextFile: z.string().optional(),
    expected: z.record(z.string(), z.any()),
    scoring: z
      .object({
        recordSets: z.array(RecordSetSchema).default(() => []),
        scalarFields: z.array(z.string()).default(() => []),
      })
      .default(() => ({ recordSets: [], scalarFields: [] })),
  })
  .refine((c) => !!(c.inputText || c.inputTextFile), {
    message: 'extraction case needs inputText or inputTextFile',
  });

const SanctionsCaseSchema = z.object({
  id: z.string().min(1),
  type: z.literal('sanctions'),
  description: z.string().optional(),
  subject: SubjectSchema,
  hit: z.object({
    listSource: z.enum(['ofac_sdn', 'uk_hmt']),
    matchScore: z.number().min(0).max(1).optional(),
    rawEntry: z.record(z.string(), z.any()),
  }),
  expected: z.object({
    decision: z.enum(['confirmed', 'dismissed', 'needs_review']),
  }),
});

const AdverseMediaCaseSchema = z.object({
  id: z.string().min(1),
  type: z.literal('adverse_media'),
  description: z.string().optional(),
  subject: SubjectSchema,
  hit: z.object({
    listSource: z.literal('adverse_media').default('adverse_media'),
    rawEntry: z.object({
      title: z.string().min(1),
      snippet: z.string().default(''),
      url: z.string().optional(),
      publishedAt: z.string().optional(),
      source: z.string().optional(),
    }),
  }),
  expected: z.object({
    decision: z.enum(['confirmed', 'dismissed', 'needs_review']),
    category: z
      .enum([
        'financial_crime',
        'fraud',
        'corruption',
        'tax_evasion',
        'regulatory_action',
        'litigation',
        'other',
      ])
      .optional(),
    severity: z.enum(['low', 'medium', 'high']).optional(),
  }),
});

const SCHEMAS = {
  extraction: ExtractionCaseSchema,
  sanctions: SanctionsCaseSchema,
  adverse_media: AdverseMediaCaseSchema,
};

const CASE_TYPES = Object.keys(SCHEMAS);

function validateCase(obj) {
  const type = obj && obj.type;
  const schema = SCHEMAS[type];
  if (!schema) {
    throw new Error(
      `Unknown or missing case "type": ${JSON.stringify(type)} (expected one of ${CASE_TYPES.join(', ')})`
    );
  }
  const parsed = schema.safeParse(obj);
  if (!parsed.success) {
    const where = obj.id ? ` in case "${obj.id}"` : '';
    throw new Error(
      `Invalid ${type} case${where}: ${parsed.error.issues
        .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
        .join('; ')}`
    );
  }
  return parsed.data;
}

module.exports = {
  CASE_TYPES,
  SCHEMAS,
  SubjectSchema,
  ExtractionCaseSchema,
  SanctionsCaseSchema,
  AdverseMediaCaseSchema,
  validateCase,
};
