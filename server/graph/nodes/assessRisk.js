// Deterministic, rules-based, weighted-factor risk engine, run after
// compile_screening_report in both the full graph and the screening-only graph.
//
// Reads kycCard + profile + psc + screeningReport.summary; produces a versioned
// calculation receipt + score + tier + outcome + delta vs the previous run.
// The heavy lifting is in services/risk. This node loads the active matrix,
// looks up the previous run's assessment for the trajectory delta, runs the
// engine, generates an LLM rationale (falling back to a deterministic templated
// one if Ollama is unavailable / the call fails), and persists the result to
// state.riskAssessment + a single decision fragment.

const { traceEvent } = require('../state');
const { withFragment } = require('../fragments');
const riskService = require('../../services/risk');
const { loadActiveMatrix } = require('../../services/risk/matrix');
const { generateRationale } = require('../../services/risk/rationale');
const repo = require('../../db/repo');
const { log } = require('../../services/log');

function templateRationale(result) {
  const drivers = [...(result.factors || [])]
    .sort((a, b) => (b.contribution || 0) - (a.contribution || 0))
    .slice(0, 3)
    .map((f) => `${f.label || f.factor} (${f.contribution})`);
  const ko = Array.isArray(result.knockoutsTriggered) && result.knockoutsTriggered.length
    ? ` Knockouts applied: ${result.knockoutsTriggered.join(', ')}.`
    : '';
  let delta = '';
  if (result.deltaFromPrevious != null) {
    const sign = result.deltaFromPrevious >= 0 ? '+' : '';
    delta = ` Change vs previous run: ${sign}${result.deltaFromPrevious}${result.deltaFlagged ? ' (flagged)' : ''}.`;
  }
  return `Entity assessed as ${result.outcome} (score ${result.score}, tier ${result.tier}). Primary risk drivers: ${drivers.join('; ')}.${ko}${delta}`;
}

function factorSummary(factors) {
  return (factors || []).map((f) => ({
    factor: f.factor,
    label: f.label,
    weight: f.weight,
    baseScore: f.baseScore,
    contribution: f.contribution,
    attribute: f.attribute,
  }));
}

const assessRisk = withFragment('assess_risk', async function assessRisk(state, config) {
  const matrix = await loadActiveMatrix();

  let previousAssessment = null;
  if (state.companyNumber) {
    try {
      previousAssessment = await repo.getPreviousRiskAssessment(
        state.companyNumber,
        config?.configurable?.runId
      );
    } catch (err) {
      // Non-fatal — without the previous assessment we just lose the delta.
      log.error(`[assess_risk] previous assessment lookup failed: ${err.message}`);
    }
  }

  const result = await riskService.assessRisk({
    profile: state.profile,
    kycCard: state.kycCard,
    psc: state.psc,
    screeningReport: state.screeningReport,
    previousAssessment,
    matrix,
  });

  // LLM rationale, with the deterministic template as the fallback (Ollama down,
  // parse failure, timeout). Never throw out of the node.
  let rationaleSource = 'llm';
  try {
    result.rationale = await generateRationale(result.receipt);
  } catch (err) {
    log.error(`[assess_risk] LLM rationale failed, using template: ${err.message}`);
    result.rationale = templateRationale(result);
    rationaleSource = 'template';
  }

  const deltaStr =
    result.deltaFromPrevious != null
      ? ` (Δ ${result.deltaFromPrevious >= 0 ? '+' : ''}${result.deltaFromPrevious}${result.deltaFlagged ? ' flagged' : ''})`
      : '';
  const headline = `Risk assessment — ${result.outcome} (score ${result.score}, tier ${result.tier})${deltaStr}`;

  return {
    riskAssessment: result,
    trace: [
      traceEvent('assess_risk', headline, {
        score: result.score,
        tier: result.tier,
        outcome: result.outcome,
        knockouts: result.knockoutsTriggered,
        delta: result.deltaFromPrevious,
      }),
    ],
    __fragment: {
      summary: headline,
      inputs: {
        matrixVersion: result.matrixVersion,
        matrixVersionId: result.matrixVersionId,
        hasProfile: !!state.profile,
        hasPsc: !!state.psc,
        hasKycCard: !!state.kycCard,
        hasScreeningReport: !!state.screeningReport,
        previousScore: result.receipt?.trajectory?.previousScore ?? null,
      },
      outputs: {
        score: result.score,
        tier: result.tier,
        outcome: result.outcome,
        factors: factorSummary(result.factors),
        knockoutsTriggered: result.knockoutsTriggered,
        deltaFromPrevious: result.deltaFromPrevious,
        deltaFlagged: result.deltaFlagged,
        rationale: result.rationale,
        rationaleSource,
      },
    },
  };
});

module.exports = { assessRisk, templateRationale };
