// Sanctions screening node. Deterministic — no LLM here. For each subject ×
// each list source, run the fuzzy matcher against the cached sanctions
// entries and emit a hit row for every match >= threshold.
//
// Fragment is `audit` (not `decision`) — the LLM-driven judgement happens
// next, in `evaluate_sanctions_hits` (M3). The hit *itself* is mechanical.

const crypto = require('crypto');
const { traceEvent, errorEvent } = require('../../state');
const { withFragment } = require('../../fragments');
const matcher = require('../../../services/sanctions/matcher');
const { searchSanctionsByNormalizedName, getScreeningConfig } =
  require('../../../db/repo');

const LIST_SOURCES = ['ofac_sdn', 'uk_hmt'];

const screenSanctions = withFragment('screen_sanctions', async function screenSanctions(state, config) {
  const subjects = state.screeningSubjects || [];
  const emitProgress = config?.configurable?.emitProgress;
  if (!subjects.length) {
    return {
      trace: [traceEvent('screen_sanctions', 'no subjects to screen, skipping')],
      __fragment: {
        status: 'skipped',
        summary: 'No subjects to screen',
      },
    };
  }

  const cfg = await getScreeningConfig();
  const threshold = cfg.matchThreshold ?? 0.85;

  const hits = [];
  const perList = { ofac_sdn: 0, uk_hmt: 0 };
  const perSubject = new Map();
  const errors = [];

  for (const subject of subjects) {
    let subjectHits = 0;
    for (const listSource of LIST_SOURCES) {
      if (emitProgress) {
        emitProgress({
          kind: 'screening_subject_started',
          subjectId: subject.id,
          subjectName: subject.name,
          listSource,
        });
      }
      let candidates;
      try {
        candidates = await searchSanctionsByNormalizedName(subject.normalizedName, {
          source: listSource,
        });
      } catch (err) {
        errors.push(errorEvent('screen_sanctions', `${listSource}: ${err.message}`));
        continue;
      }
      if (!candidates.length) continue;

      let matches;
      try {
        matches = await matcher.matchSubject(subject, candidates, threshold);
      } catch (err) {
        errors.push(errorEvent('screen_sanctions', `match ${listSource}: ${err.message}`));
        continue;
      }

      for (const m of matches) {
        const hit = {
          hitId: crypto.randomUUID(),
          // Phase 2: pass party_id when compile_screening_list keyed the
          // subject by party. Null on the legacy path (no resolver ran).
          partyId: subject.partyId || null,
          subjectId: subject.id,
          subjectName: subject.name,
          subjectKind: subject.kind,
          subjectSource: subject.source,
          listSource,
          listEntryId: m.entry.listEntryId,
          matchScore: Number(m.score.toFixed(3)),
          matchedFields: {
            matchedAlias: m.matchedAlias,
            primaryName: m.entry.primaryName,
          },
          rawEntry: {
            id: m.entry.id,
            primaryName: m.entry.primaryName,
            entryType: m.entry.entryType,
            programs: m.entry.programs,
            nationality: m.entry.nationality,
            dob: m.entry.dob,
            identifiers: m.entry.identifiers,
            aliases: m.entry.aliases,
          },
        };
        hits.push(hit);
        perList[listSource] += 1;
        subjectHits += 1;
      }
    }
    if (subjectHits) perSubject.set(subject.id, subjectHits);
  }

  const summary = `Screened ${subjects.length} subjects against ${LIST_SOURCES.length} lists — ${hits.length} potential hit${hits.length === 1 ? '' : 's'}`;

  return {
    screeningHits: hits,
    trace: [
      traceEvent('screen_sanctions', summary, {
        subjects: subjects.length,
        hits: hits.length,
        perList,
      }),
    ],
    errors,
    __fragment: {
      summary,
      inputs: {
        subjectCount: subjects.length,
        threshold,
        lists: LIST_SOURCES,
      },
      outputs: {
        hitCount: hits.length,
        perList,
        perSubject: Array.from(perSubject.entries()).map(([id, count]) => ({
          subjectId: id,
          hits: count,
        })),
      },
    },
  };
});

module.exports = { screenSanctions, LIST_SOURCES };
