// Per-article LLM judgement on adverse-media hits. Same nested-fragment
// pattern as evaluateSanctionsHits: a parent decision fragment, one child per
// hit, linked via parent_fragment_id. Each child carries the LLM's decision +
// category + severity + reasoning, and is mirrored as a row in
// `screening_evaluations` (persisted by the SSE loop in server/index.js).
//
// Per-hit failures (LLM timeout / invalid JSON) become `failed` child fragments
// without aborting the node — same isolation as the sanctions evaluator.
//
// Override short-circuit: if a `dossier_screening_overrides` row matches
// (subjectId, list_source='adverse_media', evidence_url=article.url), record
// the override decision directly. The LLM is NOT called in that case for
// adverse media — articles change weekly so there is little audit value in
// re-running the model.

const crypto = require('crypto');
const { traceEvent, errorEvent } = require('../../state');
const { withFragment } = require('../../fragments');
const { loadPrompt } = require('../../../services/prompts');
// Reusable LLM-judgement core, shared with the R3 eval harness. EvalSchema is
// re-exported below for back-compat.
const {
  AdverseMediaEvalSchema: EvalSchema,
  evaluateAdverseMediaHit,
} = require('../../../services/screening/evaluateAdverseMediaHit');
const { getOverridesForDossier, getOverridesForParties } = require('../../../db/repo');
const { log } = require('../../../services/log');

function findOverride(overrides, hit) {
  if (!overrides || !overrides.length) return null;
  const url = hit.rawEntry?.url ?? null;
  for (const o of overrides) {
    if (o.subjectId !== hit.subjectId) continue;
    if (o.listSource !== 'adverse_media') continue;
    if ((o.evidenceUrl || null) !== url) continue;
    return o;
  }
  return null;
}

// Phase 3 — party-level override. Adverse-media overrides key on
// (party_id, list_source='adverse_media', evidence_url) because each
// article has its own URL but no list_entry_id.
function findPartyOverride(partyOverrides, hit) {
  if (!partyOverrides || !partyOverrides.length || !hit.partyId) return null;
  const url = hit.rawEntry?.url ?? null;
  for (const o of partyOverrides) {
    if (o.partyId !== hit.partyId) continue;
    if (o.listSource !== 'adverse_media') continue;
    if ((o.evidenceUrl || null) !== url) continue;
    return o;
  }
  return null;
}

const evaluateAdverseMedia = withFragment(
  'evaluate_adverse_media',
  async function evaluateAdverseMedia(state, config) {
    const allHits = state.screeningHits || [];
    const hits = allHits.filter((h) => h.listSource === 'adverse_media');
    const subjectsById = new Map(
      (state.screeningSubjects || []).map((s) => [s.id, s])
    );

    if (!hits.length) {
      return {
        trace: [traceEvent('evaluate_adverse_media', 'no adverse-media hits to evaluate, skipping')],
        __fragment: {
          status: 'skipped',
          summary: 'No adverse-media hits to evaluate',
          inputs: { hitCount: 0 },
        },
      };
    }

    const dossierId = config?.configurable?.dossierId ?? null;
    let overrides = [];
    if (dossierId) {
      try {
        overrides = await getOverridesForDossier(dossierId);
      } catch (err) {
        // Non-fatal — overrides are an optimisation, not a correctness gate.
        log.error(`[evaluate_adverse_media] override fetch failed: ${err.message}`);
      }
    }

    // Phase 3: party-level overrides take precedence.
    const partyIdsOnHits = Array.from(
      new Set(hits.map((h) => h.partyId).filter(Boolean)),
    );
    let partyOverrides = [];
    if (partyIdsOnHits.length) {
      try {
        partyOverrides = await getOverridesForParties(partyIdsOnHits);
      } catch (err) {
        log.error(`[evaluate_adverse_media] party override fetch failed: ${err.message}`);
      }
    }

    const parentId = crypto.randomUUID();
    const startedAt = Date.now();
    const prompt = await loadPrompt('screening.evaluate_adverse_media');

    const evaluations = [];
    const childFragments = [];
    const errors = [];
    const counts = { confirmed: 0, dismissed: 0, needs_review: 0, failed: 0, overridden: 0 };
    const distinctSubjects = new Set();

    for (const hit of hits) {
      distinctSubjects.add(hit.subjectId);
      const subject = subjectsById.get(hit.subjectId);
      const childId = crypto.randomUUID();
      const hitStartedAt = Date.now();
      const article = hit.rawEntry || {};

      // Phase 3: party-level override wins.
      const partyOverride = findPartyOverride(partyOverrides, hit);
      const override = partyOverride || findOverride(overrides, hit);
      if (override) {
        counts[override.decision] = (counts[override.decision] || 0) + 1;
        counts.overridden += 1;

        evaluations.push({
          hitId: hit.hitId,
          decision: override.decision,
          category: 'other',
          severity: 'low',
          llmReasoning: 'Carry-forward override applied (no LLM call).',
          llmScore: 1,
          fragmentId: childId,
          humanOverride: override.decision,
          overrideReason: override.reason ?? undefined,
        });

        childFragments.push({
          id: childId,
          parentFragmentId: parentId,
          nodeId: 'evaluate_adverse_media',
          kind: 'decision',
          status: 'ok',
          startedAt: hitStartedAt,
          summary: `${override.decision} (carry-forward) — ${hit.subjectName} · ${article.title ?? 'article'}`,
          inputs: {
            hitId: hit.hitId,
            subjectId: hit.subjectId,
            subjectName: hit.subjectName,
            url: article.url ?? null,
            overrideApplied: true,
          },
          outputs: {
            decision: override.decision,
            reason: override.reason ?? null,
            source: 'human_override',
          },
        });
        continue;
      }

      let evalResult;
      let failed;
      try {
        evalResult = await evaluateAdverseMediaHit(subject, hit, { prompt });
      } catch (err) {
        failed = err;
        errors.push(
          errorEvent('evaluate_adverse_media', `hit ${hit.hitId}: ${err.message}`)
        );
      }

      if (failed) {
        counts.failed += 1;
        childFragments.push({
          id: childId,
          parentFragmentId: parentId,
          nodeId: 'evaluate_adverse_media',
          kind: 'decision',
          status: 'failed',
          startedAt: hitStartedAt,
          summary: `LLM evaluation failed — ${hit.subjectName} · ${article.title ?? 'article'}`,
          inputs: {
            hitId: hit.hitId,
            subjectId: hit.subjectId,
            subjectName: hit.subjectName,
            url: article.url ?? null,
          },
          error: failed.message,
        });
        continue;
      }

      counts[evalResult.decision] = (counts[evalResult.decision] || 0) + 1;

      evaluations.push({
        hitId: hit.hitId,
        decision: evalResult.decision,
        category: evalResult.category,
        severity: evalResult.severity,
        llmReasoning: evalResult.reasoning,
        llmScore: evalResult.llmScore,
        fragmentId: childId,
      });

      childFragments.push({
        id: childId,
        parentFragmentId: parentId,
        nodeId: 'evaluate_adverse_media',
        kind: 'decision',
        status: 'ok',
        startedAt: hitStartedAt,
        summary: `${evalResult.decision} (${evalResult.category}/${evalResult.severity}) — ${hit.subjectName} · ${article.title ?? 'article'}`,
        inputs: {
          hitId: hit.hitId,
          subjectId: hit.subjectId,
          subjectName: hit.subjectName,
          title: article.title ?? null,
          url: article.url ?? null,
          publishedAt: article.publishedAt ?? null,
        },
        outputs: {
          decision: evalResult.decision,
          category: evalResult.category,
          severity: evalResult.severity,
          llmScore: evalResult.llmScore,
          reasoning: evalResult.reasoning,
        },
      });
    }

    const summary = `Evaluated ${hits.length} adverse-media hit${hits.length === 1 ? '' : 's'} — ${counts.confirmed} confirmed, ${counts.needs_review} need review, ${counts.dismissed} dismissed${counts.failed ? `, ${counts.failed} failed` : ''}${counts.overridden ? ` (${counts.overridden} via override)` : ''}`;

    const parentFragment = {
      id: parentId,
      parentFragmentId: null,
      nodeId: 'evaluate_adverse_media',
      kind: 'decision',
      status: counts.failed === hits.length ? 'failed' : 'ok',
      startedAt,
      summary,
      inputs: {
        hitCount: hits.length,
        subjectCount: distinctSubjects.size,
      },
      outputs: counts,
    };

    return {
      screeningEvaluations: evaluations,
      trace: [
        traceEvent('evaluate_adverse_media', summary, {
          hits: hits.length,
          ...counts,
        }),
      ],
      errors,
      __fragments: [parentFragment, ...childFragments],
    };
  }
);

module.exports = { evaluateAdverseMedia, EvalSchema };
