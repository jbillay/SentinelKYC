const { traceEvent } = require('../state');
const { withFragment } = require('../fragments');

const TYPE_KEYWORDS = ['ltd', 'limited', 'plc', 'llp', 'cic'];

function normalisePostcode(pc) {
  if (!pc) return '';
  return String(pc).toUpperCase().replace(/\s+/g, '');
}

function scoreCandidate(candidate, input) {
  const breakdown = {
    apiRank: candidate.apiRank,
    base: 0,
    numberMatch: 0,
    postcodeMatch: 0,
    yearMatch: 0,
    typeMatch: 0,
  };

  breakdown.base = Math.max(0, 1 - candidate.apiRank / 20);

  if (
    input.companyNumber &&
    candidate.companyNumber &&
    candidate.companyNumber.toUpperCase() === input.companyNumber.toUpperCase()
  ) {
    breakdown.numberMatch = 1.0;
  }

  if (
    input.postcode &&
    candidate.postcode &&
    normalisePostcode(candidate.postcode) === normalisePostcode(input.postcode)
  ) {
    breakdown.postcodeMatch = 0.3;
  }

  if (input.incorporationYear && candidate.incorporationDate) {
    const year = Number(candidate.incorporationDate.slice(0, 4));
    if (year === input.incorporationYear) {
      breakdown.yearMatch = 0.2;
    }
  }

  if (input.name && candidate.title) {
    const inputLower = input.name.toLowerCase();
    const titleLower = candidate.title.toLowerCase();
    const sharedTypeKeyword = TYPE_KEYWORDS.find(
      (kw) => inputLower.includes(kw) && titleLower.includes(kw)
    );
    if (sharedTypeKeyword) {
      breakdown.typeMatch = 0.15;
    }
  }

  const score =
    breakdown.base +
    breakdown.numberMatch +
    breakdown.postcodeMatch +
    breakdown.yearMatch +
    breakdown.typeMatch;

  return { ...candidate, score, scoreBreakdown: breakdown };
}

const entityResolution = withFragment('entity_resolution', async function entityResolution(state) {
  const { candidates, input } = state;

  if (state.resolution?.status === 'not_found') {
    return {
      trace: [traceEvent('entity_resolution', 'company not found, skipping')],
      __fragment: {
        status: 'skipped',
        summary: 'Skipped — upstream search marked the company as not found',
      },
    };
  }

  if (!candidates || candidates.length === 0) {
    return {
      resolution: {
        status: 'needs_more_info',
        reason: 'no candidates returned from Companies House',
      },
      trace: [traceEvent('entity_resolution', 'no candidates')],
      __fragment: {
        status: 'failed',
        summary: 'No candidates returned — need more disambiguators (postcode, year, or company number)',
        outputs: { resolution: 'needs_more_info' },
      },
    };
  }

  const scored = candidates
    .map((c) => scoreCandidate(c, input))
    .sort((a, b) => b.score - a.score);

  const top = scored[0];
  const second = scored[1];

  let status;
  let reason;

  const ahead = second ? top.score - second.score : Infinity;
  if (top.score >= 0.85 && ahead >= 0.2) {
    status = 'auto_match';
    reason = `top score ${top.score.toFixed(2)} clear of #2 by ${ahead.toFixed(2)}`;
  } else {
    status = 'needs_user_pick';
    reason = `top score ${top.score.toFixed(2)} not decisive (#2 ${
      second ? second.score.toFixed(2) : 'n/a'
    })`;
  }

  const summary =
    status === 'auto_match'
      ? `Auto-matched ${top.title} (${top.companyNumber}) — score ${top.score.toFixed(2)}, ${ahead.toFixed(2)} ahead of #2`
      : `Top match ${top.title} (${top.companyNumber}) at ${top.score.toFixed(2)} — needs user pick (${candidates.length} candidates)`;

  return {
    candidates: scored,
    resolution: {
      status,
      chosen: status === 'auto_match' ? top.companyNumber : undefined,
      reason,
    },
    trace: [
      traceEvent('entity_resolution', `resolution: ${status}`, {
        topScore: top.score,
        topCompanyNumber: top.companyNumber,
        runnerUpScore: second?.score,
      }),
    ],
    __fragment: {
      summary,
      inputs: {
        candidateCount: candidates.length,
        userInput: input,
      },
      outputs: {
        resolution: status,
        chosen: status === 'auto_match' ? top.companyNumber : null,
        topScore: top.score,
        runnerUpScore: second?.score ?? null,
        scoreBreakdown: top.scoreBreakdown,
        top5: scored.slice(0, 5).map((c) => ({
          companyNumber: c.companyNumber,
          title: c.title,
          score: Number(c.score.toFixed(3)),
        })),
      },
    },
  };
});

module.exports = { entityResolution };
