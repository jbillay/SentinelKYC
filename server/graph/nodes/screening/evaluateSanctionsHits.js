// Per-hit LLM judgement on sanctions matches. Emits a single parent decision
// fragment and one nested child fragment per hit (linked via
// parent_fragment_id). Each child carries the LLM's reasoning + decision and
// is mirrored as a row in `screening_evaluations` (persisted by the SSE loop
// in server/index.js using a screeningEvaluations cursor — see Step 5 follow-up).
//
// Failures are isolated per hit: an LLM timeout or JSON parse failure on one
// hit produces a `failed` child fragment but does not abort the node.

const crypto = require('crypto');
const { traceEvent, errorEvent } = require('../../state');
const { withFragment } = require('../../fragments');
const { loadPrompt } = require('../../../services/prompts');
// Reusable LLM-judgement core, shared with the R3 eval harness so production
// and the harness exercise the identical model path. EvalSchema is re-exported
// below for back-compat.
const {
  SanctionsEvalSchema: EvalSchema,
  evaluateSanctionsHit,
} = require('../../../services/screening/evaluateSanctionsHit');
const { getOverridesForDossier, getOverridesForParties } = require('../../../db/repo');
const { log } = require('../../../services/log');

function findOverride(overrides, hit) {
  if (!overrides || !overrides.length) return null;
  for (const o of overrides) {
    if (o.subjectId !== hit.subjectId) continue;
    if (o.listSource !== hit.listSource) continue;
    if ((o.listEntryId || null) !== (hit.listEntryId || null)) continue;
    return o;
  }
  return null;
}

// Phase 3 — party-level override lookup. Matches on (party_id, list_source,
// list_entry_id). evidence_url is included for adverse-media-style lookups
// where the entry id is null. Wins over dossier-level overrides because it
// represents an enterprise-wide reviewer decision.
function findPartyOverride(partyOverrides, hit) {
  if (!partyOverrides || !partyOverrides.length || !hit.partyId) return null;
  for (const o of partyOverrides) {
    if (o.partyId !== hit.partyId) continue;
    if (o.listSource !== hit.listSource) continue;
    if ((o.listEntryId || null) !== (hit.listEntryId || null)) continue;
    return o;
  }
  return null;
}

const evaluateSanctionsHits = withFragment(
  'evaluate_sanctions_hits',
  async function evaluateSanctionsHits(state, config) {
    // Sanctions hits only — adverse-media hits are evaluated by their own node.
    const allHits = state.screeningHits || [];
    const hits = allHits.filter(
      (h) => h.listSource === 'ofac_sdn' || h.listSource === 'uk_hmt'
    );
    const subjectsById = new Map(
      (state.screeningSubjects || []).map((s) => [s.id, s])
    );

    if (!hits.length) {
      return {
        trace: [traceEvent('evaluate_sanctions_hits', 'no hits to evaluate, skipping')],
        __fragment: {
          status: 'skipped',
          summary: 'No sanctions hits to evaluate',
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
        log.error(`[evaluate_sanctions_hits] override fetch failed: ${err.message}`);
      }
    }

    // Phase 3: party-level overrides take precedence over dossier-level
    // ones. A single bulk fetch keyed by every distinct partyId on the hit
    // set (skips bulk fetch when no hit has a partyId — pre-Phase-2 data).
    const partyIdsOnHits = Array.from(
      new Set(hits.map((h) => h.partyId).filter(Boolean)),
    );
    let partyOverrides = [];
    if (partyIdsOnHits.length) {
      try {
        partyOverrides = await getOverridesForParties(partyIdsOnHits);
      } catch (err) {
        log.error(`[evaluate_sanctions_hits] party override fetch failed: ${err.message}`);
      }
    }

    const parentId = crypto.randomUUID();
    const startedAt = Date.now();
    const prompt = await loadPrompt('screening.evaluate_sanctions_hit');

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
      // Phase 3: party-level override wins. Fall back to dossier-level
      // override (pre-Phase-2 hits without a partyId).
      const partyOverride = findPartyOverride(partyOverrides, hit);
      const override = partyOverride || findOverride(overrides, hit);

      // Run the LLM regardless — even when an override exists, we keep the
      // model's reasoning as the audit trail. The override decides the final
      // status only.
      let evalResult;
      let failed;
      try {
        evalResult = await evaluateSanctionsHit(subject, hit, { prompt });
      } catch (err) {
        failed = err;
        errors.push(
          errorEvent('evaluate_sanctions_hits', `hit ${hit.hitId}: ${err.message}`)
        );
      }

      if (failed && !override) {
        counts.failed += 1;
        childFragments.push({
          id: childId,
          parentFragmentId: parentId,
          nodeId: 'evaluate_sanctions_hits',
          kind: 'decision',
          status: 'failed',
          startedAt: hitStartedAt,
          summary: `LLM evaluation failed — ${hit.subjectName} vs ${hit.rawEntry?.primaryName ?? 'entry'}`,
          inputs: {
            hitId: hit.hitId,
            subjectId: hit.subjectId,
            subjectName: hit.subjectName,
            listSource: hit.listSource,
            listEntryId: hit.listEntryId,
            matchScore: hit.matchScore,
          },
          error: failed.message,
        });
        continue;
      }

      // If an override exists, it decides the final status regardless of the
      // LLM result. The LLM reasoning is still kept as audit trail. If the LLM
      // failed, we degrade gracefully and use the override decision alone.
      const finalDecision = override ? override.decision : evalResult.decision;
      counts[finalDecision] = (counts[finalDecision] || 0) + 1;
      if (override) counts.overridden += 1;

      evaluations.push({
        hitId: hit.hitId,
        decision: finalDecision,
        llmReasoning: evalResult?.reasoning ?? 'LLM evaluation failed; carry-forward override applied.',
        llmScore: evalResult?.llmScore,
        fragmentId: childId,
        humanOverride: override ? override.decision : undefined,
        overrideReason: override?.reason ?? undefined,
      });

      childFragments.push({
        id: childId,
        parentFragmentId: parentId,
        nodeId: 'evaluate_sanctions_hits',
        kind: 'decision',
        status: 'ok',
        startedAt: hitStartedAt,
        summary: override
          ? `${finalDecision} (carry-forward) — ${hit.subjectName} vs ${hit.rawEntry?.primaryName ?? 'entry'}`
          : `${finalDecision} — ${hit.subjectName} vs ${hit.rawEntry?.primaryName ?? 'entry'}`,
        inputs: {
          hitId: hit.hitId,
          subjectId: hit.subjectId,
          subjectName: hit.subjectName,
          listSource: hit.listSource,
          listEntryId: hit.listEntryId,
          matchScore: hit.matchScore,
          overrideApplied: !!override,
        },
        outputs: {
          decision: finalDecision,
          llmDecision: evalResult?.decision ?? null,
          llmScore: evalResult?.llmScore,
          reasoning: evalResult?.reasoning ?? null,
          matchedFields: evalResult?.matchedFields ?? [],
          conflictingFields: evalResult?.conflictingFields ?? [],
          overrideReason: override?.reason ?? null,
        },
      });
    }

    const parentFragment = {
      id: parentId,
      parentFragmentId: null,
      nodeId: 'evaluate_sanctions_hits',
      kind: 'decision',
      status: counts.failed === hits.length ? 'failed' : 'ok',
      startedAt,
      summary: `Evaluated ${hits.length} sanctions hit${hits.length === 1 ? '' : 's'} — ${counts.confirmed} confirmed, ${counts.needs_review} need review, ${counts.dismissed} dismissed${counts.failed ? `, ${counts.failed} failed` : ''}${counts.overridden ? ` (${counts.overridden} via override)` : ''}`,
      inputs: {
        hitCount: hits.length,
        subjectCount: distinctSubjects.size,
      },
      outputs: counts,
    };

    return {
      screeningEvaluations: evaluations,
      trace: [
        traceEvent('evaluate_sanctions_hits', parentFragment.summary, {
          hits: hits.length,
          ...counts,
        }),
      ],
      errors,
      __fragments: [parentFragment, ...childFragments],
    };
  }
);

module.exports = { evaluateSanctionsHits, EvalSchema };
