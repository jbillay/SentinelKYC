// Throwaway check: generateQaNarrative returns multi-paragraph text with the
// new paragraphs[] schema against the live DB prompt + configured provider.
require('dotenv').config();

const { generateQaNarrative } = require('../services/qa/narrative');

const input = {
  kycCard: {
    identity: {
      name: 'BARCLAYS PLC',
      companyNumber: '00048839',
      countryOfIncorporation: 'United Kingdom',
      status: 'active',
      type: 'plc',
    },
    officers: [{ name: 'C S VENKATAKRISHNAN', role: 'director' }],
    psc: [],
    shareholders: [],
    redFlags: [],
  },
  screeningReport: {
    summary: { overallRisk: 'low', confirmed: 0, needsReview: 0, dismissed: 3 },
    subjects: [{ name: 'BARCLAYS PLC', type: 'company' }],
  },
  riskAssessment: {
    score: 25.5,
    tier: 'High',
    outcome: 'Proceed',
    factors: [
      { key: 'geographic', contribution: 5, attribute: 'GB' },
      { key: 'industry', contribution: 10.5, attribute: '64191 other monetary intermediation' },
    ],
    knockoutsTriggered: [],
    rationale: { headline: 'UK-registered bank, low-risk jurisdiction and sector.' },
  },
  qaResult: {
    passed: false,
    completeness: { issues: [{ code: 'ubo_missing', message: 'No ultimate beneficial owners identified' }] },
    consistency: { issues: [] },
    routing: { caseStatus: 'standard_review', qaSummary: 'Completeness issue: UBO absent.' },
    tier: 'Low',
  },
};

generateQaNarrative(input)
  .then((n) => {
    const paras = n.text.split(/\n\s*\n/).filter(Boolean);
    console.log('--- paragraphCount field:', n.paragraphCount);
    console.log('--- actual paragraphs in text:', paras.length);
    console.log('--- model:', n.model);
    console.log(n.text);
    process.exit(paras.length >= 5 ? 0 : 1);
  })
  .catch((e) => {
    console.error('FAILED:', e.message);
    process.exit(1);
  });
