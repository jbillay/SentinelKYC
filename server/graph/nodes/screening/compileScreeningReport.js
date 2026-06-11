// Deterministic — no LLM. Aggregates state.screeningHits + state.screeningEvaluations
// into the frozen `screeningReport` shape via the shared helper in
// services/screening/report.js so the PATCH override endpoint can re-derive
// the same shape after a human override flips a hit's effective decision.
//
// Risk rule (per SCREENING_PLAN.md §5.6, implemented in report.js):
//   - Any confirmed sanctions hit                                  → high
//   - Confirmed adverse-media hit (financial_crime / corruption /
//     fraud / tax_evasion) at severity ≥ medium, OR any sanctions
//     hit at needs_review                                          → medium
//   - Otherwise                                                    → low

const { traceEvent } = require('../../state');
const { withFragment } = require('../../fragments');
const { buildScreeningReport } = require('../../../services/screening/report');

const compileScreeningReport = withFragment(
  'compile_screening_report',
  async function compileScreeningReport(state) {
    const subjects = state.screeningSubjects || [];
    const hits = state.screeningHits || [];
    const evaluations = state.screeningEvaluations || [];

    const screeningReport = buildScreeningReport({ subjects, hits, evaluations });
    const { summary, perSubject, byList } = screeningReport;

    const headline = `Screening report — risk ${summary.overallRisk} (${summary.confirmedHits} confirmed / ${summary.needsReview} review / ${summary.dismissedHits} dismissed across ${summary.subjectCount} subject${summary.subjectCount === 1 ? '' : 's'})`;

    return {
      screeningReport,
      trace: [traceEvent('compile_screening_report', headline, summary)],
      __fragment: {
        summary: headline,
        inputs: {
          subjectCount: subjects.length,
          hitCount: hits.length,
          evaluationCount: evaluations.length,
        },
        outputs: {
          summary,
          byList,
          perSubjectCount: perSubject.length,
        },
      },
    };
  }
);

module.exports = { compileScreeningReport };
