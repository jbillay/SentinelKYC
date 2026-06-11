// Phase 5 — Final Decision Panel payload validation (server twin).
//
// CommonJS mirror of web/src/lib/decisionSchema.js — same enums, same fields,
// same min-length rules. Keep them in sync. See the comment in the web file
// for why we keep two physical files.

const { z } = require('zod');

const REASON_CODES = [
  'sanctions_hit',
  'adverse_media_confirmed',
  'pep_exposure',
  'high_risk_jurisdiction',
  'complex_ownership_structure',
  'insufficient_documentation',
  'identity_mismatch',
  'dissolved_or_inactive',
  'other',
];

const reasonCodeSchema = z.enum(REASON_CODES);

const approveSchema = z.object({
  action: z.literal('approve'),
  userId: z.string().min(1),
});

const rejectSchema = z.object({
  action: z.literal('reject'),
  userId: z.string().min(1),
  reasonCode: reasonCodeSchema,
  freeText: z.string().min(10),
});

const escalateSchema = z.object({
  action: z.literal('escalate'),
  userId: z.string().min(1),
  notes: z.string().min(10),
  suggestedAction: z.string().optional(),
});

const requestInfoItemSchema = z.object({
  description: z.string().min(3),
  category: z.string().min(1),
});

const requestInfoSchema = z.object({
  action: z.literal('request_info'),
  userId: z.string().min(1),
  items: z.array(requestInfoItemSchema).min(1),
});

const decisionPayloadSchema = z.discriminatedUnion('action', [
  approveSchema,
  rejectSchema,
  escalateSchema,
  requestInfoSchema,
]);

module.exports = {
  REASON_CODES,
  reasonCodeSchema,
  approveSchema,
  rejectSchema,
  escalateSchema,
  requestInfoSchema,
  requestInfoItemSchema,
  decisionPayloadSchema,
};
