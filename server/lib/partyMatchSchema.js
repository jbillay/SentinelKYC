// Phase 1a — Party matcher request payload validation (server twin).
//
// CommonJS mirror of web/src/lib/partyMatchSchema.js — same fields, same
// shape, same min-length. Keep them in sync. See the comment in the web
// file for why we keep two physical files (CJS / ESM split).
//
// The schema accepts EITHER a bare string under `name` (today's shape)
// OR an object that may carry future secondary attributes (dob, nationality,
// countryOfResidence) added in Phase 1b. The matcher's signature already
// allows the object form via readInput() — accepting it at the schema layer
// from day one keeps the HTTP contract forward-compatible.

const { z } = require('zod');

const ISO2 = /^[A-Z]{2}$/;

// Future-shape secondary attributes — accepted today but ignored by the
// matcher until Phase 1b. We validate the shape now so a Phase-1b rollout
// doesn't need to also tighten request validation.
const partyMatchInputSchema = z.object({
  name: z.string().trim().min(1, 'name must not be empty').max(500),
  dob: z
    .object({
      year: z.number().int().min(1900).max(new Date().getFullYear()).optional(),
      month: z.number().int().min(1).max(12).optional(),
    })
    .optional(),
  nationality: z.array(z.string().regex(ISO2, 'nationality must be ISO-3166-1 alpha-2')).optional(),
  countryOfResidence: z.string().regex(ISO2, 'countryOfResidence must be ISO-3166-1 alpha-2').optional(),
  // Matcher knobs are optional and clamped server-side. Exposed here so an
  // admin / smoke caller can tune without an admin-only endpoint.
  minScore: z.number().min(0).max(1).optional(),
  limit: z.number().int().min(1).max(100).optional(),
});

const partyMatchResultSchema = z.object({
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

// Phase 4 — Merge action payload.
const partyMergeSchema = z.object({
  mergeFromPartyId: z.string().uuid('mergeFromPartyId must be a uuid'),
  reason: z.string().trim().min(3).max(500).optional(),
});

// Phase 4 — Review queue resolution payload.
const reviewQueueResolutionSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('merge'),
    // When the queue item already pairs (party, candidate), the route
    // picks the merge direction from the row. Reviewer can override:
    winnerPartyId: z.string().uuid().optional(),
    reason: z.string().trim().min(3).max(500).optional(),
  }),
  z.object({
    action: z.literal('reject'),
    reason: z.string().trim().min(3).max(500).optional(),
  }),
]);

module.exports = {
  partyMatchInputSchema,
  partyMatchResultSchema,
  partyMergeSchema,
  reviewQueueResolutionSchema,
};
