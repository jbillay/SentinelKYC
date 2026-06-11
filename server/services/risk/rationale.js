// R4 — LLM-generated risk rationale.
//
// `generateRationale(receipt)` asks the reasoning model to turn the calculation
// receipt into a short, regulator-defensible paragraph. It returns the formatted
// string on success and THROWS on any failure (parse error, timeout, Ollama
// down, prompt-load failure) — the assess_risk node catches and falls back to
// its `templateRationale`. Keeping the fallback in the node avoids a circular
// require (the node owns `templateRationale`).

const { z } = require('zod');

const RationaleSchema = z.object({
  headline: z.string(),
  drivers: z
    .array(z.object({ factor: z.string(), reason: z.string() }))
    .max(3)
    .default(() => []),
  sanctionsNote: z.string().nullable().default(null),
});

// "Entity assessed as {tier} (Score: {score}). {headline} Primary drivers:
//  {r1}; {r2}; {r3}.{ sanctionsNote ? ' ' + sanctionsNote : '' }"
function formatRationale(receipt, llm) {
  const tier = (receipt && receipt.tier) ?? 'Unknown';
  const score = (receipt && receipt.score) ?? '?';
  const headline = String((llm && llm.headline) || '').trim();
  const reasons = ((llm && llm.drivers) || [])
    .map((d) => String((d && d.reason) || '').trim())
    .filter(Boolean)
    .slice(0, 3);
  const driverClause = reasons.length ? ` Primary drivers: ${reasons.join('; ')}.` : '';
  const note = llm && llm.sanctionsNote ? ` ${String(llm.sanctionsNote).trim()}` : '';
  return `Entity assessed as ${tier} (Score: ${score}).${headline ? ' ' + headline : ''}${driverClause}${note}`.trim();
}

async function generateRationale(receipt) {
  const { extractStructured } = require('../llm');
  const { loadPrompt } = require('../prompts');
  const prompt = await loadPrompt('risk.rationale');
  const out = await extractStructured(JSON.stringify(receipt), RationaleSchema, prompt);
  if (!out || typeof out !== 'object' || typeof out.headline !== 'string') {
    throw new Error('risk.rationale LLM returned an unexpected shape');
  }
  return formatRationale(receipt, out);
}

module.exports = { generateRationale, formatRationale, RationaleSchema };
