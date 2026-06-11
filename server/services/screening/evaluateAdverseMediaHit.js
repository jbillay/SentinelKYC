// Reusable core of the adverse-media LLM judgement. Factored out of the
// `evaluate_adverse_media` graph node so production (the node) and the R3 eval
// harness (server/eval) exercise the identical model path. The node owns
// fragment/evaluation bookkeeping, overrides, and failure isolation; this module
// owns only "given a subject + an article, what does the model decide".
//
// Keep in lock-step with the node: the schema + LLM input shape are the contract
// the `screening.evaluate_adverse_media` prompt is written against.

const { z } = require('zod');
const { extractStructured } = require('../llm');
const { loadPrompt } = require('../prompts');

const AdverseMediaEvalSchema = z.object({
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
    .default('other'),
  severity: z.enum(['low', 'medium', 'high']).default('low'),
  llmScore: z.number().min(0).max(1),
  reasoning: z.string(),
});

// `hit.rawEntry` is the GDELT-style article ({ title, snippet, url, publishedAt,
// source }); `subject` is the screening subject (individuals only in v1).
function buildAdverseMediaInput(subject, hit) {
  const article = hit.rawEntry || {};
  return JSON.stringify(
    {
      subject: {
        name: subject?.name ?? hit.subjectName,
        kind: subject?.kind ?? hit.subjectKind,
        role: subject?.role ?? null,
        nationality: subject?.nationality ?? null,
      },
      article: {
        title: article.title ?? null,
        snippet: article.snippet ?? null,
        url: article.url ?? null,
        publishedAt: article.publishedAt ?? null,
        source: article.source ?? null,
      },
    },
    null,
    2
  );
}

async function evaluateAdverseMediaHit(subject, hit, { prompt } = {}) {
  const p = prompt || (await loadPrompt('screening.evaluate_adverse_media'));
  const input = buildAdverseMediaInput(subject, hit);
  return extractStructured(input, AdverseMediaEvalSchema, p);
}

module.exports = {
  AdverseMediaEvalSchema,
  buildAdverseMediaInput,
  evaluateAdverseMediaHit,
};
