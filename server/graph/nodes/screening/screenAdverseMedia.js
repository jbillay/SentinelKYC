// Adverse-media screening node. For each INDIVIDUAL subject (officers, PSCs,
// individual shareholders — not companies in v1), call the adverse-media
// provider (GDELT 2.0 DOC API — see services/adverseMedia/gdelt.js) and emit
// one hit per article. The hit's `matchScore` is null here; the LLM in
// evaluate_adverse_media decides relevance + severity. Note GDELT returns
// headlines only — `rawEntry.snippet` is empty.
//
// Articles fetched per subject = `screening_config.bing_results_per_subject`
// (clamped 1..100, default 20).
//
// Concurrency lives inside services/adverseMedia/gdelt.js — strictly serial
// with 6s spacing (GDELT's public rate limit is one request / 5s) plus two
// 429 retries. If a subject is still 429'd after both retries the GDELT
// client throws err.code='GDELT_RATE_LIMITED' and we soft-skip the subject
// (trace event, not an error in state.errors) so the UI doesn't surface a
// non-fatal error for transient rate-limit jitter.
//
// Companies generate too-noisy results without entity disambiguation, so they
// are filtered out — see SCREENING_PLAN.md §4 / CLAUDE.md screening notes.

const crypto = require('crypto');
const { traceEvent, errorEvent } = require('../../state');
const { withFragment } = require('../../fragments');
const adverseMedia = require('../../../services/adverseMedia');
const { getScreeningConfig } = require('../../../db/repo');

function shouldScreen(subject) {
  return subject.kind === 'individual';
}

const screenAdverseMedia = withFragment(
  'screen_adverse_media',
  async function screenAdverseMedia(state, config) {
    const all = state.screeningSubjects || [];
    const subjects = all.filter(shouldScreen);
    const emitProgress = config?.configurable?.emitProgress;

    // Adverse media can be switched off independently of sanctions screening
    // (Settings → Agents → Screening). Sanctions branch is unaffected.
    const { loadAgentConfig } = require('../../../agents/config');
    const agentCfg = await loadAgentConfig('screening');
    if (agentCfg.adverseMediaEnabled === false) {
      return {
        trace: [
          traceEvent('screen_adverse_media', 'adverse media disabled in screening agent config — skipping'),
        ],
        __fragment: {
          status: 'skipped',
          summary: 'Adverse-media screening disabled in agent config',
          inputs: { subjectCount: all.length, individualCount: subjects.length },
        },
      };
    }

    if (!subjects.length) {
      return {
        trace: [
          traceEvent('screen_adverse_media', 'no individual subjects to screen, skipping'),
        ],
        __fragment: {
          status: 'skipped',
          summary: 'No individual subjects for adverse-media screening',
          inputs: { subjectCount: all.length, individualCount: 0 },
        },
      };
    }

    const cfg = await getScreeningConfig();
    const max = Math.min(100, Math.max(1, cfg.bingResultsPerSubject ?? 20));

    const startedAt = Date.now();
    const errors = [];
    const traces = [];
    const hits = [];
    const rateLimited = [];
    let cacheHits = 0;
    let articlesFetched = 0;

    // Sequential — the GDELT semaphore inside services/adverseMedia/gdelt.js
    // serialises with 5s spacing anyway, so fanning out with Promise.all just
    // queued all subjects internally without progress visibility. Walking the
    // list one-by-one means `screening_subject_started` events line up with
    // the actual wall-clock work the user is waiting on. See CODE_REVIEW §4.3.
    for (const subject of subjects) {
      if (emitProgress) {
        emitProgress({
          kind: 'screening_subject_started',
          subjectId: subject.id,
          subjectName: subject.name,
          listSource: 'adverse_media',
        });
      }
      try {
        // G1: party-keyed cache — the same individual across dossiers reuses
        // one GDELT fetch per ISO week (subjects are party-keyed post-resolver).
        const { articles, cacheHit } = await adverseMedia.search(subject.name, {
          max,
          partyId: subject.partyId || null,
        });
        if (cacheHit) cacheHits += 1;
        articlesFetched += articles.length;
        for (const article of articles) {
          hits.push({
            hitId: crypto.randomUUID(),
            // Phase 2: pass party_id when compile_screening_list keyed the
            // subject by party. Null on the legacy path.
            partyId: subject.partyId || null,
            subjectId: subject.id,
            subjectName: subject.name,
            subjectKind: subject.kind,
            subjectSource: subject.source,
            listSource: 'adverse_media',
            listEntryId: null,
            matchScore: null,
            matchedFields: null,
            rawEntry: {
              title: article.title,
              snippet: article.snippet,
              url: article.url,
              publishedAt: article.publishedAt,
              source: article.source,
            },
          });
        }
      } catch (err) {
        if (err.code === 'GDELT_RATE_LIMITED') {
          rateLimited.push(subject.name);
          traces.push(
            traceEvent(
              'screen_adverse_media',
              `${subject.name}: GDELT rate-limited after retries, skipped`,
            ),
          );
        } else {
          errors.push(errorEvent('screen_adverse_media', `${subject.name}: ${err.message}`));
        }
      }
    }

    const rlBit = rateLimited.length ? `, ${rateLimited.length} rate-limited` : '';
    const summary = `Screened ${subjects.length} individual${subjects.length === 1 ? '' : 's'} for adverse media — ${hits.length} potential article${hits.length === 1 ? '' : 's'}${cacheHits ? ` (${cacheHits} cache hit${cacheHits === 1 ? '' : 's'})` : ''}${rlBit}`;

    return {
      screeningHits: hits,
      trace: [
        ...traces,
        traceEvent('screen_adverse_media', summary, {
          subjects: subjects.length,
          resultsPerSubject: max,
          hits: hits.length,
          cacheHits,
          articlesFetched,
          rateLimited: rateLimited.length,
          durationMs: Date.now() - startedAt,
        }),
      ],
      errors,
      __fragment: {
        summary,
        inputs: {
          subjectCount: subjects.length,
          totalSubjects: all.length,
          resultsPerSubject: max,
        },
        outputs: {
          hitCount: hits.length,
          cacheHits,
          articlesFetched,
          rateLimited: rateLimited.length,
          rateLimitedSubjects: rateLimited,
          durationMs: Date.now() - startedAt,
        },
      },
    };
  }
);

module.exports = { screenAdverseMedia };
