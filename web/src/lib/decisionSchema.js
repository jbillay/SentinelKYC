// Phase 5 — Final Decision Panel payload validation.
//
// Source-of-truth for the Approve / Reject / Escalate / Request-info payloads.
// The server has a CommonJS twin at server/lib/decisionSchema.js — keep them
// in sync (same field names, same enums, same min-length rules). The duplicate
// exists because web is ESM (Vite) and server is CJS (Node) and zod is
// available in both — sharing one physical file would require bundler
// gymnastics that aren't worth it for a POC.

import { z } from 'zod';

export const REASON_CODES = [
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

export const reasonCodeSchema = z.enum(REASON_CODES);

export const approveSchema = z.object({
  action: z.literal('approve'),
  userId: z.string().min(1),
});

export const rejectSchema = z.object({
  action: z.literal('reject'),
  userId: z.string().min(1),
  reasonCode: reasonCodeSchema,
  freeText: z.string().min(10),
});

export const escalateSchema = z.object({
  action: z.literal('escalate'),
  userId: z.string().min(1),
  notes: z.string().min(10),
  suggestedAction: z.string().optional(),
});

export const requestInfoItemSchema = z.object({
  description: z.string().min(3),
  category: z.string().min(1),
});

export const requestInfoSchema = z.object({
  action: z.literal('request_info'),
  userId: z.string().min(1),
  items: z.array(requestInfoItemSchema).min(1),
});

export const decisionPayloadSchema = z.discriminatedUnion('action', [
  approveSchema,
  rejectSchema,
  escalateSchema,
  requestInfoSchema,
]);

// Human-readable labels for the Reject reason-code <select>. Keep in sync with
// REASON_CODES — order is the dropdown order shown to the reviewer.
export const REASON_CODE_LABELS = {
  sanctions_hit: 'Sanctions hit',
  adverse_media_confirmed: 'Adverse media confirmed',
  pep_exposure: 'PEP exposure',
  high_risk_jurisdiction: 'High-risk jurisdiction',
  complex_ownership_structure: 'Complex ownership structure',
  insufficient_documentation: 'Insufficient documentation',
  identity_mismatch: 'Identity mismatch',
  dissolved_or_inactive: 'Dissolved or inactive',
  other: 'Other',
};
