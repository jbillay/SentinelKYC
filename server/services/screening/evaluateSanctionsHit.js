// Reusable core of the sanctions-hit LLM judgement. Factored out of the
// `evaluate_sanctions_hits` graph node so the exact same code path is exercised
// by production (the node) AND the R3 eval harness (server/eval). The node owns
// fragment/evaluation bookkeeping, overrides, and failure isolation; this module
// owns only "given a subject + a hit, what does the model decide".
//
// Keep this in lock-step with the node: the schema and the LLM input shape are
// the contract the prompt `screening.evaluate_sanctions_hit` is written against.

const { z } = require('zod');
const { extractStructured } = require('../llm');
const { loadPrompt } = require('../prompts');

const SanctionsEvalSchema = z.object({
  decision: z.enum(['confirmed', 'dismissed', 'needs_review']),
  llmScore: z.number().min(0).max(1),
  reasoning: z.string(),
  matchedFields: z.array(z.string()).default(() => []),
  conflictingFields: z.array(z.string()).default(() => []),
});

// Build the JSON the model sees. `hit` carries listSource / matchScore / rawEntry
// (the sanctions list entry); `subject` is the screening subject (may be null,
// in which case we fall back to the denormalised fields on the hit).
function buildSanctionsInput(subject, hit) {
  const raw = hit.rawEntry || {};
  return JSON.stringify(
    {
      subject: {
        name: subject?.name ?? hit.subjectName,
        kind: subject?.kind ?? hit.subjectKind,
        role: subject?.role ?? null,
        dob: subject?.dob ?? null,
        nationality: subject?.nationality ?? null,
      },
      entry: {
        listSource: hit.listSource,
        primaryName: raw.primaryName ?? null,
        entryType: raw.entryType ?? null,
        aliases: Array.isArray(raw.aliases)
          ? raw.aliases.map((a) => a?.name).filter(Boolean).slice(0, 20)
          : [],
        dob: raw.dob ?? null,
        nationality: raw.nationality ?? null,
        programs: raw.programs ?? null,
        identifiers: raw.identifiers ?? null,
      },
      matchScore: hit.matchScore ?? null,
    },
    null,
    2
  );
}

// Run the LLM judgement for a single sanctions hit. `prompt` may be supplied by
// the caller (the node loads it once and reuses it across hits; the harness
// passes an A/B candidate version); otherwise the active prompt is loaded.
async function evaluateSanctionsHit(subject, hit, { prompt } = {}) {
  const p = prompt || (await loadPrompt('screening.evaluate_sanctions_hit'));
  const input = buildSanctionsInput(subject, hit);
  return extractStructured(input, SanctionsEvalSchema, p);
}

module.exports = { SanctionsEvalSchema, buildSanctionsInput, evaluateSanctionsHit };
