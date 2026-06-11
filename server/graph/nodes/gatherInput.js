const { traceEvent } = require('../state');
const { withFragment } = require('../fragments');

const POSTCODE_RE = /^[A-Z]{1,2}\d[A-Z\d]?\s*\d[A-Z]{2}$/i;

function describeInput(input) {
  const parts = [];
  if (input.name) parts.push(`name "${input.name}"`);
  if (input.companyNumber) parts.push(`number ${input.companyNumber}`);
  if (input.postcode) parts.push(`postcode ${input.postcode}`);
  if (input.incorporationYear) parts.push(`year ${input.incorporationYear}`);
  return parts.length ? parts.join(', ') : 'no inputs supplied';
}

const gatherInput = withFragment('gather_input', async function gatherInput(state) {
  const raw = state.input || {};

  const normalised = {};
  if (raw.name) normalised.name = String(raw.name).trim();
  if (raw.companyNumber) {
    normalised.companyNumber = String(raw.companyNumber).trim().toUpperCase();
  }
  if (raw.postcode) {
    const pc = String(raw.postcode).trim().toUpperCase();
    if (POSTCODE_RE.test(pc)) {
      normalised.postcode = pc.replace(/\s+/g, ' ');
    }
  }
  if (raw.incorporationYear) {
    const y = Number(raw.incorporationYear);
    if (Number.isInteger(y) && y > 1800 && y < 2100) {
      normalised.incorporationYear = y;
    }
  }

  return {
    input: normalised,
    trace: [traceEvent('gather_input', 'input normalised', { input: normalised })],
    __fragment: {
      summary: `Captured user input: ${describeInput(normalised)}`,
      inputs: { raw },
      outputs: { normalised },
    },
  };
});

module.exports = { gatherInput };
