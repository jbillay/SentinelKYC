// Phase 5 / Q-N — qa.narrative LLM step.
//
// generateQaNarrative({ kycCard, screeningReport, riskAssessment, qaResult })
//   -> { text, paragraphCount, tier, model, promptVersionId, generatedAt }
//
// Paragraph count is keyed off the post-knockout risk tier (riskAssessment.tier):
// Low=2 / Medium=4 / High=6. The prompt body has `{{paragraphCount}}` substituted
// at call time so a single prompt covers all three tiers.
//
// Hard-fail policy: throws on any failure (missing tier, missing prompt, parse
// error, Ollama unreachable, empty output). The qaNarrative graph node lets the
// error propagate, which `withFragment` turns into a `failed` fragment + an
// errors entry — the SSE runtime then closes the run as `failed`. There is no
// template fallback; the run requires the LLM-generated narrative.

const { z } = require('zod');

const PARAGRAPHS_BY_TIER = { Low: 2, Medium: 4, High: 6 };

const QaNarrativeSchema = z.object({
  text: z.string().min(1).describe('Narrative text — paragraphs joined by \\n\\n'),
});

function paragraphsFor(tier) {
  return PARAGRAPHS_BY_TIER[tier];
}

function buildPromptBody(rawPrompt, paragraphCount) {
  return String(rawPrompt).replace(/\{\{paragraphCount\}\}/g, String(paragraphCount));
}

function buildInputPayload({ kycCard, screeningReport, riskAssessment, qaResult }) {
  // Strip the receipt — it's enormous and the rationale already summarises it.
  let trimmedRisk = riskAssessment;
  if (riskAssessment && typeof riskAssessment === 'object') {
    const { receipt, ...rest } = riskAssessment;
    trimmedRisk = rest;
  }
  return {
    kycCard: kycCard ?? null,
    screeningReport: screeningReport ?? null,
    riskAssessment: trimmedRisk ?? null,
    qaResult: qaResult ?? null,
  };
}

async function generateQaNarrative({ kycCard, screeningReport, riskAssessment, qaResult }) {
  const tier = riskAssessment?.tier;
  const paragraphCount = paragraphsFor(tier);
  if (!paragraphCount) {
    throw new Error(`qa.narrative: unknown or missing risk tier "${tier}" (expected Low / Medium / High)`);
  }

  const { extractStructured } = require('../llm');
  const { loadPrompt } = require('../prompts');
  const { resolveTask } = require('../llm/config');
  const { getActiveVersion } = require('../prompts');

  const rawPrompt = await loadPrompt('qa.narrative');
  const prompt = buildPromptBody(rawPrompt, paragraphCount);
  const input = buildInputPayload({ kycCard, screeningReport, riskAssessment, qaResult });

  const out = await extractStructured(JSON.stringify(input), QaNarrativeSchema, prompt);
  if (!out || typeof out !== 'object' || typeof out.text !== 'string' || !out.text.trim()) {
    throw new Error('qa.narrative: LLM returned an unexpected shape (missing or empty text)');
  }

  const reasoningCfg = resolveTask('reasoning');
  let promptVersionId = null;
  try {
    const active = await getActiveVersion('qa.narrative');
    promptVersionId = active?.id ?? null;
  } catch {
    promptVersionId = null;
  }

  return {
    text: out.text.trim(),
    paragraphCount,
    tier,
    model: `${reasoningCfg.provider}:${reasoningCfg.model}`,
    promptVersionId,
    generatedAt: new Date().toISOString(),
  };
}

module.exports = {
  generateQaNarrative,
  QaNarrativeSchema,
  PARAGRAPHS_BY_TIER,
  paragraphsFor,
};
