// Pure helpers shared between graph/nodes/screening/compileScreeningReport.js
// (which compiles the report at the end of a run) and the PATCH override
// endpoint (which re-derives runs.final_screening_report after a human
// override flips a hit's effective decision).
//
// Inputs:
//   - subjects:    [{ id, name, kind, source }]
//   - hits:        screening_hits rows (or in-memory equivalents) with
//                  { hitId|id, subjectId, listSource, ... }
//   - evaluations: screening_evaluations rows with
//                  { hitId, decision, category, severity, humanOverride }
//
// Output: { summary, perSubject, byList } — same shape compileScreeningReport
// emits and that runs.final_screening_report stores.

const SANCTIONS_LISTS = ['ofac_sdn', 'uk_hmt'];
const ADVERSE_LIST = 'adverse_media';
const SERIOUS_AM_CATEGORIES = new Set([
  'financial_crime',
  'corruption',
  'fraud',
  'tax_evasion',
]);
const SEVERITY_RANK = { low: 1, medium: 2, high: 3 };

function effectiveDecision(evaluation) {
  if (!evaluation) return 'unevaluated';
  if (evaluation.humanOverride) return evaluation.humanOverride;
  return evaluation.decision;
}

function emptyBuckets() {
  return { confirmed: 0, needsReview: 0, dismissed: 0 };
}

function bumpBucket(bucket, decision) {
  if (decision === 'confirmed') bucket.confirmed += 1;
  else if (decision === 'needs_review') bucket.needsReview += 1;
  else if (decision === 'dismissed') bucket.dismissed += 1;
}

function worstStatus(...decisions) {
  if (decisions.includes('confirmed')) return 'confirmed';
  if (decisions.includes('needs_review')) return 'needs_review';
  if (decisions.includes('dismissed')) return 'dismissed';
  return 'clean';
}

function buildScreeningReport({ subjects = [], hits = [], evaluations = [] }) {
  const evalsByHit = new Map(evaluations.map((e) => [e.hitId, e]));

  const summary = {
    subjectCount: subjects.length,
    confirmedHits: 0,
    needsReview: 0,
    dismissedHits: 0,
    overallRisk: 'low',
  };

  const byList = {
    ofac_sdn: emptyBuckets(),
    uk_hmt: emptyBuckets(),
    adverse_media: emptyBuckets(),
  };

  const perSubjectMap = new Map();
  for (const s of subjects) {
    perSubjectMap.set(s.id, {
      subjectId: s.id,
      partyId: s.partyId ?? null,
      name: s.name,
      kind: s.kind,
      source: s.source,
      hits: {
        sanctions: emptyBuckets(),
        adverseMedia: emptyBuckets(),
      },
      decisions: [],
    });
  }

  let hasConfirmedSanctions = false;
  let hasSeriousConfirmedAdverse = false;
  let hasSanctionsNeedsReview = false;

  for (const hit of hits) {
    const hitId = hit.hitId ?? hit.id;
    const evaluation = evalsByHit.get(hitId);
    const decision = effectiveDecision(evaluation);

    if (decision !== 'unevaluated' && byList[hit.listSource]) {
      bumpBucket(byList[hit.listSource], decision);
    }

    const ps = perSubjectMap.get(hit.subjectId);
    if (ps) {
      const isSanctions = SANCTIONS_LISTS.includes(hit.listSource);
      const target = isSanctions ? ps.hits.sanctions : ps.hits.adverseMedia;
      if (decision !== 'unevaluated') bumpBucket(target, decision);
      ps.decisions.push(decision);
    }

    if (decision === 'confirmed') {
      if (SANCTIONS_LISTS.includes(hit.listSource)) {
        hasConfirmedSanctions = true;
      } else if (hit.listSource === ADVERSE_LIST) {
        const cat = evaluation?.category;
        const sev = evaluation?.severity;
        const sevRank = SEVERITY_RANK[sev] ?? 0;
        if (SERIOUS_AM_CATEGORIES.has(cat) && sevRank >= SEVERITY_RANK.medium) {
          hasSeriousConfirmedAdverse = true;
        }
      }
    } else if (decision === 'needs_review' && SANCTIONS_LISTS.includes(hit.listSource)) {
      hasSanctionsNeedsReview = true;
    }

    if (decision === 'confirmed') summary.confirmedHits += 1;
    else if (decision === 'needs_review') summary.needsReview += 1;
    else if (decision === 'dismissed') summary.dismissedHits += 1;
  }

  if (hasConfirmedSanctions) summary.overallRisk = 'high';
  else if (hasSeriousConfirmedAdverse || hasSanctionsNeedsReview) summary.overallRisk = 'medium';
  else summary.overallRisk = 'low';

  const perSubject = [];
  for (const ps of perSubjectMap.values()) {
    const status = worstStatus(...ps.decisions);
    delete ps.decisions;
    ps.worstStatus = status;
    perSubject.push(ps);
  }

  return { summary, perSubject, byList };
}

module.exports = {
  buildScreeningReport,
  effectiveDecision,
  SANCTIONS_LISTS,
  ADVERSE_LIST,
  SERIOUS_AM_CATEGORIES,
  SEVERITY_RANK,
};
