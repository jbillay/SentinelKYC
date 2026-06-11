const { interrupt } = require('@langchain/langgraph');
const { traceEvent, errorEvent } = require('../state');
const { withFragment } = require('../fragments');

const awaitConfirmation = withFragment('await_confirmation', async function awaitConfirmation(state) {
  const { resolution, candidates } = state;

  const top5 = [...candidates]
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);

  const resumePayload = interrupt({
    resolution,
    candidates: top5,
  });

  const chosen = resumePayload?.companyNumber;
  if (!chosen) {
    return {
      errors: [errorEvent('await_confirmation', 'resume payload missing companyNumber')],
      trace: [traceEvent('await_confirmation', 'invalid resume payload')],
      __fragment: {
        status: 'failed',
        summary: 'Resume payload did not include a companyNumber',
        error: 'missing companyNumber',
      },
    };
  }

  const valid = candidates.find((c) => c.companyNumber === chosen);
  if (!valid) {
    return {
      errors: [
        errorEvent(
          'await_confirmation',
          `chosen companyNumber ${chosen} not in candidate list`
        ),
      ],
      trace: [traceEvent('await_confirmation', 'invalid choice')],
      __fragment: {
        status: 'failed',
        summary: `Chosen company ${chosen} is not in the candidate list`,
        error: 'invalid choice',
        inputs: { chosen },
      },
    };
  }

  const wasAutoMatch = resolution?.status === 'auto_match';
  return {
    companyNumber: chosen,
    resolution: { ...resolution, status: 'auto_match', chosen },
    trace: [
      traceEvent('await_confirmation', 'user confirmed', { companyNumber: chosen }),
    ],
    __fragment: {
      summary: wasAutoMatch
        ? `User confirmed auto-matched ${valid.title} (${chosen})`
        : `User picked ${valid.title} (${chosen}) from disambiguation list`,
      inputs: { chosen, candidateCount: candidates.length },
      outputs: {
        companyNumber: chosen,
        title: valid.title,
        wasAutoMatch,
      },
    },
  };
});

module.exports = { awaitConfirmation };
