// Phase 1a — Party matcher request payload validation (web twin).
//
// Source-of-truth for the POST /api/parties/match request body shape and
// the response shape the UI can rely on. The server has a CommonJS twin at
// server/lib/partyMatchSchema.js — keep them in sync (same fields, same
// regex, same min/max). The duplicate exists because web is ESM (Vite) and
// server is CJS (Node) and zod is available in both — sharing one physical
// file would require bundler gymnastics that aren't worth it for a POC.
//
// Pattern mirrors web/src/lib/decisionSchema.js — see the equivalent
// commentary there.

import { z } from 'zod';

const ISO2 = /^[A-Z]{2}$/;

export const partyMatchInputSchema = z.object({
  name: z.string().trim().min(1, 'name must not be empty').max(500),
  dob: z
    .object({
      year: z.number().int().min(1900).max(new Date().getFullYear()).optional(),
      month: z.number().int().min(1).max(12).optional(),
    })
    .optional(),
  nationality: z.array(z.string().regex(ISO2, 'nationality must be ISO-3166-1 alpha-2')).optional(),
  countryOfResidence: z.string().regex(ISO2, 'countryOfResidence must be ISO-3166-1 alpha-2').optional(),
  minScore: z.number().min(0).max(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

export const partyMatchResultSchema = z.object({
  inputCanonical: z.string(),
  candidates: z.array(
    z.object({
      partyId: z.string().uuid(),
      fullName: z.string(),
      canonical: z.string(),
      score: z.number(),
      confidence: z.enum(['EXACT', 'HIGH', 'REVIEW']),
      matchedVia: z.enum(['token_set', 'trigram', 'phonetic']),
    }),
  ),
  topScore: z.number().nullable(),
});

// Human-readable labels for the confidence chip in the UI (Phase 4 will
// consume these from the review-queue page). Keep keys aligned with the
// confidence enum above.
export const CONFIDENCE_LABELS = {
  EXACT: 'Exact match',
  HIGH: 'High confidence',
  REVIEW: 'Needs review',
};

// Phase 4 — Merge action payload (sent to POST /api/parties/:id/merge).
// :id is the winner; mergeFromPartyId is the loser.
export const partyMergeSchema = z.object({
  mergeFromPartyId: z.string().uuid('mergeFromPartyId must be a uuid'),
  reason: z.string().trim().min(3).max(500).optional(),
});

// Phase 4 — Review queue resolution payload.
export const reviewQueueResolutionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('merge'),
    winnerPartyId: z.string().uuid().optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  }),
  z.object({
    action: z.literal('reject'),
    reason: z.string().trim().min(3).max(500).optional(),
  }),
]);
