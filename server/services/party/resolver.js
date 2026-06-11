// Phase 1b — Party resolver.
//
// Given a dossier run's CH inputs (profile / officers / psc) and any
// document-extracted shareholders, this service:
//
//   1. Resolves every subject to a Party row in the party master:
//        a. Strong-key lookup first (CH officer appointment id for
//           individuals; (country, registration_number) for corporates).
//           A hit auto-links with confidence 1.0 and writes no review item.
//        b. Otherwise, runs the name matcher (services/party/matcher.js).
//           EXACT (sim=1.0) → auto-link to the existing party (per the
//           Phase 1b decision: name-only EXACT is treated as authoritative
//           for the POC; Phase 1c will tighten with DOB / nationality).
//           HIGH / REVIEW   → create a new party AND enqueue review-queue
//                              items pointing at each candidate.
//           No candidates   → create a new party silently.
//
//   2. Upserts a party_links row for each subject (idempotent on the
//      (party_id, dossier_id, role, appointed_on, notified_on) unique
//      index). Status reflects the latest CH observation: officer.
//      resigned_on → 'resigned'; psc.ceased_on → 'ceased'; otherwise
//      'active'.
//
//   3. Appends a party_link_status_history row whenever a link's status
//      changes (or it's newly inserted, with from=NULL).
//
//   4. Records every name-matcher call in party_match_log via
//      services/party/auditLog.js (replay-grade audit; even zero-match
//      calls land a row).
//
//   5. After all subjects are processed, looks up every non-historical
//      link on this dossier that the current run didn't touch and flips
//      it to 'historical' — that's how "this officer disappeared from
//      the latest CH snapshot" gets reflected in the master without
//      destroying audit history.
//
// Phase 1b is dark-mode: this service is called only by smoke scripts.
// Phase 2 wires it into the graph via a resolve_parties node between
// synthesize_card and compile_screening_list.
//
// Idempotency is the single most important property. Re-running the
// resolver against the same inputs produces the same parties + links;
// re-running against changed inputs produces precisely the diff.

const repo = require('../../db/repo');
const { findMatches, THRESHOLDS } = require('./matcher');
const { recordMatchCall } = require('./auditLog');
const { corroborate } = require('./corroborate');

// CH officer items expose `links.officer.appointments` as a path of the
// form `/officers/<ID>/appointments`. The <ID> piece is stable across
// companies — it's the closest thing CH gives us to a person identifier
// for individual officers. We extract it and use it as the strong dedup
// key for the officer source.
const APPOINTMENT_PATH_RE = /\/officers\/([^/]+)\/appointments/;

function extractAppointmentId(officer) {
  const path = officer?.links?.officer?.appointments;
  if (typeof path !== 'string') return null;
  const m = path.match(APPOINTMENT_PATH_RE);
  return m ? m[1] : null;
}

// CH officer.identification is present (and non-null) for corporate
// officers; absent / null for individuals. Some CH responses also expose
// `is_pre_1992_appointment` etc. — we keep the test narrow.
function officerKind(officer) {
  return officer?.identification ? 'organisation' : 'individual';
}

function pscKind(psc) {
  const k = String(psc?.kind || '').toLowerCase();
  if (k.includes('corporate') || k.includes('legal-person')) return 'organisation';
  return 'individual';
}

function shareholderKind(sh) {
  return sh?.type === 'corporate' ? 'organisation' : 'individual';
}

function nationalityArray(input) {
  if (!input) return null;
  if (Array.isArray(input)) return input.filter(Boolean);
  return [String(input)];
}

// Map CH-style country names to ISO-2 where the matcher / Phase 1c later
// expects a normalised value. The full normaliser lives in
// services/risk/normalize.js; for now we just keep the raw string and let
// Phase 1c plug it in. Returned as-is.
function asCountry(input) {
  if (!input) return null;
  return String(input).trim() || null;
}

// Officer status — resigned_on present (even in the past) means the
// officer has resigned. We still write the link so historical roles are
// auditable.
function officerStatus(officer) {
  return officer?.resigned_on ? 'resigned' : 'active';
}

function pscStatus(psc) {
  if (psc?.ceased_on || psc?.ceased) return 'ceased';
  return 'active';
}

// A trimmed source_ref payload — drops bulky / noisy fields so the jsonb
// column stays compact and useful. Keep enough that an auditor can answer
// "which CH item drove this link?" without restoring from a snapshot.
function sanitiseOfficer(officer) {
  if (!officer) return null;
  return {
    name: officer.name,
    officer_role: officer.officer_role,
    appointed_on: officer.appointed_on,
    resigned_on: officer.resigned_on,
    nationality: officer.nationality,
    country_of_residence: officer.country_of_residence,
    occupation: officer.occupation,
    date_of_birth: officer.date_of_birth,
    appointment_id: extractAppointmentId(officer),
    identification: officer.identification ?? null,
  };
}

function sanitisePsc(psc) {
  if (!psc) return null;
  return {
    name: psc.name,
    kind: psc.kind,
    natures_of_control: psc.natures_of_control,
    notified_on: psc.notified_on,
    ceased_on: psc.ceased_on ?? psc.ceased ?? null,
    nationality: psc.nationality,
    country_of_residence: psc.country_of_residence,
    date_of_birth: psc.date_of_birth,
    identification: psc.identification ?? null,
  };
}

function sanitiseShareholder(sh) {
  if (!sh) return null;
  return {
    name: sh.name,
    type: sh.type,
    shares: sh.shares,
    percentage: sh.percentage,
    shareClass: sh.shareClass,
  };
}

// ---------------------------------------------------------------------------
// Per-source party builders. These don't write — they shape the party
// row that the resolver will insert (or use to enrich an existing party).
// ---------------------------------------------------------------------------

function buildOfficerParty(officer, appointmentId) {
  const kind = officerKind(officer);
  const base = {
    partyType: kind,
    fullName: officer.name,
    sourceKind: 'officer',
    chOfficerAppointmentId: kind === 'individual' ? appointmentId : null,
  };
  if (kind === 'individual') {
    base.dateOfBirthYear = officer?.date_of_birth?.year ?? null;
    base.dateOfBirthMonth = officer?.date_of_birth?.month ?? null;
    base.nationality = nationalityArray(officer?.nationality);
    base.countryOfResidence = asCountry(officer?.country_of_residence);
  } else {
    base.registrationNumber = officer?.identification?.registration_number ?? null;
    base.registrationCountry = asCountry(officer?.identification?.country_registered);
  }
  return base;
}

function buildPscParty(psc) {
  const kind = pscKind(psc);
  const base = {
    partyType: kind,
    fullName: psc.name,
    sourceKind: 'psc',
  };
  if (kind === 'individual') {
    base.dateOfBirthYear = psc?.date_of_birth?.year ?? null;
    base.dateOfBirthMonth = psc?.date_of_birth?.month ?? null;
    base.nationality = nationalityArray(psc?.nationality);
    base.countryOfResidence = asCountry(psc?.country_of_residence);
  } else {
    base.registrationNumber = psc?.identification?.registration_number ?? null;
    base.registrationCountry = asCountry(psc?.identification?.country_registered);
  }
  return base;
}

function buildShareholderParty(sh) {
  const kind = shareholderKind(sh);
  return {
    partyType: kind,
    fullName: sh.name,
    sourceKind: 'shareholder',
  };
}

// ---------------------------------------------------------------------------
// Dossier-side strong-key cross-check for corporate parties.
//
// If a corporate PSC / shareholder has a UK registration number, see
// whether we already onboarded that company — if so, the party row's
// dossier_id back-link points at that dossier, enabling cross-dossier
// graph traversal. Best-effort: a missing dossier is fine, just means
// it's an external entity.
// ---------------------------------------------------------------------------

const UK_COUNTRY_HINTS = /^(united kingdom|uk|england|scotland|wales|northern ireland|gb)$/i;

async function findDossierForRegistration({ country, number }) {
  if (!number) return null;
  if (country && !UK_COUNTRY_HINTS.test(country)) return null;
  const d = await repo.getDossier(number);
  return d || null;
}

// ---------------------------------------------------------------------------
// Per-subject resolution. Returns { partyId, linkRow, transitionRow,
// reviewItems[], matcherCall } so the orchestrator can aggregate.
// ---------------------------------------------------------------------------

async function resolveSubject({
  dossierId,
  runId,
  role,
  partyData,
  linkExtras,
  strongKeyEvidence,
  bypassMatcher,
  matcherMinScore,
  // For corporate dossier back-link.
  candidateDossierId,
}) {
  let party = null;
  let matchEvidence = null;
  let matchConfidence = null;
  let matcherCall = null;
  const reviewItems = [];

  if (strongKeyEvidence) {
    // Strong-key path already chose a party (or chose to create one without
    // running the matcher because the strong key is authoritative).
    party = bypassMatcher ?? null;
    matchEvidence = strongKeyEvidence;
    matchConfidence = 1.0;
  } else {
    // Name matcher path.
    const matcherResult = await findMatches(partyData.fullName, {
      minScore: matcherMinScore ?? THRESHOLDS.PHONETIC_LO,
    });
    matcherCall = {
      inputName: partyData.fullName,
      inputCanonical: matcherResult.inputCanonical,
      candidates: matcherResult.candidates,
      topScore: matcherResult.topScore,
    };

    const top = matcherResult.candidates[0];
    if (top && top.confidence === 'EXACT') {
      // R5 — EXACT name alone no longer auto-links an individual: two real
      // humans can share a canonical name. Require a corroborating identifier
      // (DOB and/or nationality) to be present AND consistent; a bare-name
      // EXACT (no signal on either side) routes to the review queue instead.
      // Corporates keep EXACT auto-link (their strong key — registration
      // number — runs before the matcher). PARTY_REQUIRE_CORROBORATION=false
      // restores the legacy always-auto-link behaviour.
      const candidate = await repo.findPartyById(top.partyId);
      const gateActive =
        partyData.partyType === 'individual' &&
        String(process.env.PARTY_REQUIRE_CORROBORATION || 'true').toLowerCase() !== 'false';
      const cor = gateActive
        ? corroborate(partyData, candidate)
        : { ok: true, reason: gateActive ? null : 'gate_disabled_or_corporate', signalsUsed: [] };
      if (cor.ok) {
        // Auto-link to the EXACT candidate.
        party = candidate;
        matchEvidence = {
          kind: 'name_match',
          score: top.score,
          confidence: top.confidence,
          matchedVia: top.matchedVia,
          candidates: matcherResult.candidates.slice(0, 3),
          corroboration: cor,
        };
        matchConfidence = top.score;
      } else {
        // Demote to the HIGH/REVIEW path: new party + review-queue items.
        matchEvidence = {
          kind: 'name_match',
          score: top.score,
          confidence: top.confidence,
          matchedVia: top.matchedVia,
          candidates: matcherResult.candidates.slice(0, 5),
          outcome: 'new_party_queued',
          corroboration: cor,
        };
        matchConfidence = top.score;
        // party will be created below.
      }
    } else if (matcherResult.candidates.length > 0) {
      // HIGH / REVIEW — create a new party AND queue review items.
      matchEvidence = {
        kind: 'name_match',
        score: top.score,
        confidence: top.confidence,
        matchedVia: top.matchedVia,
        candidates: matcherResult.candidates.slice(0, 5),
        outcome: 'new_party_queued',
      };
      matchConfidence = top.score;
      // party will be created below.
    } else {
      // No candidates → silent new party.
      matchEvidence = { kind: 'new', reason: 'no_match' };
      matchConfidence = null;
    }
  }

  // Create the party if neither strong-key nor EXACT-auto-link selected one.
  let createdParty = false;
  if (!party) {
    const insertInput = { ...partyData };
    // Corporate dossier back-link: if we identified an existing dossier
    // for this corporate party's registration_number, store the FK.
    if (candidateDossierId) insertInput.dossierId = candidateDossierId;
    // Flag for review queue UI when matcher found suggestive candidates.
    if (matchEvidence?.outcome === 'new_party_queued') {
      insertInput.needsReview = true;
      insertInput.reviewReason =
        matchEvidence.corroboration && !matchEvidence.corroboration.ok
          ? `EXACT name match demoted: ${matchEvidence.corroboration.reason} — reviewer decision required`
          : `${matchEvidence.confidence} name match against existing party — reviewer decision required`;
    }
    party = await repo.insertNewParty(insertInput);
    createdParty = true;
  } else {
    // Enrich the existing party with newly-observed attributes.
    // Non-destructive: only fill NULLs, never overwrite.
    const patch = {};
    if (!party.dateOfBirthYear && partyData.dateOfBirthYear) patch.dateOfBirthYear = partyData.dateOfBirthYear;
    if (!party.dateOfBirthMonth && partyData.dateOfBirthMonth) patch.dateOfBirthMonth = partyData.dateOfBirthMonth;
    if (!party.countryOfResidence && partyData.countryOfResidence) patch.countryOfResidence = partyData.countryOfResidence;
    if (!party.chOfficerAppointmentId && partyData.chOfficerAppointmentId) patch.chOfficerAppointmentId = partyData.chOfficerAppointmentId;
    if (!party.registrationNumber && partyData.registrationNumber) patch.registrationNumber = partyData.registrationNumber;
    if (!party.registrationCountry && partyData.registrationCountry) patch.registrationCountry = partyData.registrationCountry;
    if (!party.dossierId && candidateDossierId) patch.dossierId = candidateDossierId;
    // Add the observed name to aliases if it differs from the canonical
    // we already have.
    if (partyData.fullName && partyData.fullName !== party.fullName) {
      const existingAliases = Array.isArray(party.aliases) ? party.aliases : [];
      if (!existingAliases.includes(partyData.fullName)) {
        patch.aliases = [...existingAliases, partyData.fullName];
      }
    }
    if (Object.keys(patch).length) {
      const updated = await repo.updatePartyFields(party.id, patch);
      if (updated) party = updated;
    }
  }

  // Queue any HIGH/REVIEW candidates for the new party (skipped on
  // strong-key path and EXACT auto-link).
  if (
    matcherCall &&
    matchEvidence?.outcome === 'new_party_queued' &&
    matcherCall.candidates.length > 0
  ) {
    for (const c of matcherCall.candidates) {
      // Don't queue the party against itself (shouldn't happen — the
      // candidate is from the matcher which only returns OTHER parties —
      // but cheap defensive check).
      if (c.partyId === party.id) continue;
      const queued = await repo.enqueueReviewItem({
        partyId: party.id,
        candidatePartyId: c.partyId,
        score: c.score,
        confidence: c.confidence,
        matchedVia: c.matchedVia,
        evidence: {
          inputName: matcherCall.inputName,
          inputCanonical: matcherCall.inputCanonical,
          candidateCanonical: c.canonical,
          candidateFullName: c.fullName,
        },
        runId,
      });
      if (queued) reviewItems.push(queued);
    }
  }

  // Upsert the link.
  const { row: linkRow, inserted } = await repo.upsertPartyLink({
    partyId: party.id,
    dossierId,
    role,
    runId,
    matchConfidence,
    matchEvidence,
    sourceRef: linkExtras.sourceRef,
    roleDetail: linkExtras.roleDetail,
    status: linkExtras.status,
    naturesOfControl: linkExtras.naturesOfControl,
    sharesCount: linkExtras.sharesCount,
    sharesPercentage: linkExtras.sharesPercentage,
    shareClass: linkExtras.shareClass,
    appointedOn: linkExtras.appointedOn,
    resignedOn: linkExtras.resignedOn,
    notifiedOn: linkExtras.notifiedOn,
    ceasedOn: linkExtras.ceasedOn,
  });

  // Status-history bookkeeping.
  //   - insert  → write a transition row with fromStatus=null.
  //   - update + status differs from the previously-stored status →
  //     write a transition row.
  // We don't have the previous status in scope on update because the
  // ON CONFLICT replaced it. Strategy: compare against linkExtras.status
  // and the existing row only when not freshly inserted, by re-fetching
  // the most recent transition. For Phase 1b's POC scope a simpler rule
  // is sufficient: on insert OR when the resolver observes a non-active
  // status, emit a transition. This over-counts on a re-run where the
  // resigned/ceased state was already observed previously; Phase 2 can
  // tighten with a pre-check if the noise becomes a problem.
  let transitionRow = null;
  if (inserted) {
    transitionRow = await repo.appendPartyStatusTransition({
      linkId: linkRow.id,
      fromStatus: null,
      toStatus: linkExtras.status,
      runId,
      reason: 'link first observed',
    });
  } else if (linkExtras.status !== 'active') {
    // Best-effort: re-fetch the latest history row and only emit if the
    // current observed status genuinely differs from it. This avoids
    // exploding the history table on idempotent re-runs.
    const { db } = require('../../db/client');
    const schema = require('../../db/schema');
    const { eq: eqFn, desc: descFn } = require('drizzle-orm');
    const [last] = await db
      .select({ toStatus: schema.partyLinkStatusHistory.toStatus })
      .from(schema.partyLinkStatusHistory)
      .where(eqFn(schema.partyLinkStatusHistory.linkId, linkRow.id))
      .orderBy(descFn(schema.partyLinkStatusHistory.changedAt))
      .limit(1);
    if (!last || last.toStatus !== linkExtras.status) {
      transitionRow = await repo.appendPartyStatusTransition({
        linkId: linkRow.id,
        fromStatus: last?.toStatus ?? null,
        toStatus: linkExtras.status,
        runId,
        reason: 'status changed in latest run',
      });
    }
  }

  return {
    partyId: party.id,
    createdParty,
    linkRow,
    transitionRow,
    reviewItems,
    matcherCall,
  };
}

// ---------------------------------------------------------------------------
// Per-source orchestration. Each of these handles one subject end-to-end
// (strong-key check → resolveSubject) and returns its result.
// ---------------------------------------------------------------------------

async function resolveOfficerSubject({ dossierId, runId, officer }) {
  if (!officer?.name) return null;
  const appointmentId = extractAppointmentId(officer);
  const partyData = buildOfficerParty(officer, appointmentId);
  const sourceRef = sanitiseOfficer(officer);
  const linkExtras = {
    sourceRef,
    roleDetail: officer.officer_role || null,
    status: officerStatus(officer),
    appointedOn: officer.appointed_on || null,
    resignedOn: officer.resigned_on || null,
  };

  // Strong-key: individual + appointment id.
  let strongKeyEvidence = null;
  let bypassMatcher = null;
  if (officerKind(officer) === 'individual' && appointmentId) {
    const existing = await repo.findPartyByAppointmentId(appointmentId);
    if (existing) {
      bypassMatcher = existing;
    }
    strongKeyEvidence = {
      kind: 'appointment_id',
      value: appointmentId,
      outcome: existing ? 'linked_existing' : 'created_new',
    };
  }
  // Strong-key: corporate + registration.
  let candidateDossierId = null;
  if (officerKind(officer) === 'organisation' && officer?.identification?.registration_number) {
    const reg = {
      country: asCountry(officer.identification.country_registered),
      number: officer.identification.registration_number,
    };
    const existing = await repo.findPartyByRegistration(reg);
    if (existing) {
      bypassMatcher = existing;
    }
    const dossier = await findDossierForRegistration(reg);
    if (dossier) candidateDossierId = dossier.id;
    strongKeyEvidence = {
      kind: 'registration_number',
      country: reg.country,
      number: reg.number,
      outcome: existing ? 'linked_existing' : 'created_new',
      backlinkedDossierId: candidateDossierId,
    };
  }

  return resolveSubject({
    dossierId,
    runId,
    role: 'officer',
    partyData,
    linkExtras,
    strongKeyEvidence,
    bypassMatcher,
    candidateDossierId,
  });
}

async function resolvePscSubject({ dossierId, runId, psc }) {
  if (!psc?.name) return null;
  const partyData = buildPscParty(psc);
  const sourceRef = sanitisePsc(psc);
  const linkExtras = {
    sourceRef,
    roleDetail: null,
    status: pscStatus(psc),
    naturesOfControl: Array.isArray(psc.natures_of_control) ? psc.natures_of_control : null,
    notifiedOn: psc.notified_on || null,
    ceasedOn: psc.ceased_on || null,
  };

  // PSCs have no cross-company strong key for individuals. Corporates
  // can carry identification.registration_number.
  let strongKeyEvidence = null;
  let bypassMatcher = null;
  let candidateDossierId = null;
  if (pscKind(psc) === 'organisation' && psc?.identification?.registration_number) {
    const reg = {
      country: asCountry(psc.identification.country_registered),
      number: psc.identification.registration_number,
    };
    const existing = await repo.findPartyByRegistration(reg);
    if (existing) bypassMatcher = existing;
    const dossier = await findDossierForRegistration(reg);
    if (dossier) candidateDossierId = dossier.id;
    strongKeyEvidence = {
      kind: 'registration_number',
      country: reg.country,
      number: reg.number,
      outcome: existing ? 'linked_existing' : 'created_new',
      backlinkedDossierId: candidateDossierId,
    };
  }

  return resolveSubject({
    dossierId,
    runId,
    role: 'psc',
    partyData,
    linkExtras,
    strongKeyEvidence,
    bypassMatcher,
    candidateDossierId,
  });
}

async function resolveShareholderSubject({ dossierId, runId, sh }) {
  if (!sh?.name) return null;
  const partyData = buildShareholderParty(sh);
  const sourceRef = sanitiseShareholder(sh);
  const linkExtras = {
    sourceRef,
    roleDetail: sh.shareClass || null,
    // Shareholders have no resignation/cessation concept in our extracted
    // data — always active when observed.
    status: 'active',
    sharesCount: sh.shares ?? null,
    sharesPercentage: sh.percentage ?? null,
    shareClass: sh.shareClass ?? null,
  };

  // No strong key for doc-extracted shareholders.
  return resolveSubject({
    dossierId,
    runId,
    role: 'shareholder',
    partyData,
    linkExtras,
  });
}

// ---------------------------------------------------------------------------
// Main entry point.
// ---------------------------------------------------------------------------

async function resolveParties({
  dossierId,
  runId = null,
  profile,
  officers = [],
  psc = [],
  shareholders = [],
  // Caller-controlled: should historical reconciliation run? Default true.
  // Set false when the caller is only adding to an existing run (e.g. a
  // partial replay in a future ticket).
  reconcileHistorical = true,
  // Tag for party_match_log.source on every matcher call.
  matchLogSource = 'resolver',
  // Override for x-user-id / system identity in the audit log.
  matchLogCalledBy = 'system:resolver',
} = {}) {
  if (!dossierId) throw new Error('resolveParties: dossierId required');

  const result = {
    parties: [],
    links: [],
    reviewItems: [],
    statusTransitions: [],
    counts: {
      officers: 0,
      psc: 0,
      shareholders: 0,
      newParties: 0,
      autoLinkedStrong: 0,
      autoLinkedExact: 0,
      // R5 — corroboration gate outcomes on the EXACT branch (individuals).
      autoLinkedCorroborated: 0,
      exactDemotedToReview: 0,
      queuedForReview: 0,
      historicalReconciled: 0,
    },
  };
  const touchedLinkIds = new Set();

  async function consumeOutcome(outcome) {
    if (!outcome) return;
    if (outcome.matcherCall) {
      // Audit-log every name-matcher invocation (zero-match included).
      await recordMatchCall({
        inputName: outcome.matcherCall.inputName,
        inputCanonical: outcome.matcherCall.inputCanonical,
        candidates: outcome.matcherCall.candidates,
        topScore: outcome.matcherCall.topScore,
        calledBy: matchLogCalledBy,
        source: matchLogSource,
      });
    }
    result.parties.push({ id: outcome.partyId, created: outcome.createdParty });
    result.links.push(outcome.linkRow);
    if (outcome.transitionRow) result.statusTransitions.push(outcome.transitionRow);
    result.reviewItems.push(...outcome.reviewItems);
    touchedLinkIds.add(outcome.linkRow.id);
    if (outcome.createdParty) result.counts.newParties += 1;
    if (outcome.linkRow.match_confidence != null && Number(outcome.linkRow.match_confidence) === 1.0) {
      // Either strong-key or EXACT — distinguished by match_evidence.kind
      const evidence = outcome.linkRow.match_evidence || {};
      const k = evidence.kind;
      if (k === 'appointment_id' || k === 'registration_number') result.counts.autoLinkedStrong += 1;
      // A demoted EXACT (outcome new_party_queued) carries score 1.0 but did
      // NOT auto-link — exclude it here; it's counted as exactDemotedToReview.
      if (k === 'name_match' && evidence.outcome !== 'new_party_queued') {
        result.counts.autoLinkedExact += 1;
        // R5 — auto-link that passed the corroboration gate (signals present).
        if (evidence.corroboration?.ok && evidence.corroboration.signalsUsed?.length) {
          result.counts.autoLinkedCorroborated += 1;
        }
      }
    }
    // R5 — EXACT match demoted to review by a failed corroboration check.
    {
      const evidence = outcome.linkRow.match_evidence || {};
      if (
        evidence.kind === 'name_match' &&
        evidence.outcome === 'new_party_queued' &&
        evidence.confidence === 'EXACT' &&
        evidence.corroboration &&
        !evidence.corroboration.ok
      ) {
        result.counts.exactDemotedToReview += 1;
      }
    }
    if (outcome.reviewItems.length) result.counts.queuedForReview += outcome.reviewItems.length;
  }

  // Officers first — they often carry the strong key (appointment_id),
  // so resolving them first lets PSCs / shareholders dedup against their
  // newly-created party rows via the matcher's EXACT path.
  for (const officer of officers) {
    if (!officer?.name) continue;
    const outcome = await resolveOfficerSubject({ dossierId, runId, officer });
    await consumeOutcome(outcome);
    if (outcome) result.counts.officers += 1;
  }

  for (const p of psc) {
    if (!p?.name) continue;
    const outcome = await resolvePscSubject({ dossierId, runId, psc: p });
    await consumeOutcome(outcome);
    if (outcome) result.counts.psc += 1;
  }

  for (const sh of shareholders) {
    if (!sh?.name) continue;
    const outcome = await resolveShareholderSubject({ dossierId, runId, sh });
    await consumeOutcome(outcome);
    if (outcome) result.counts.shareholders += 1;
  }

  if (reconcileHistorical) {
    const existing = await repo.getOpenLinksForDossier(dossierId);
    const stale = existing.filter((l) => !touchedLinkIds.has(l.id)).map((l) => l.id);
    if (stale.length) {
      await repo.markLinksHistorical(stale, {
        runId,
        reason: 'not observed in latest run',
      });
      result.counts.historicalReconciled = stale.length;
    }
  }

  return result;
}

module.exports = {
  resolveParties,
  // Exported for unit-level testing of the small helpers.
  _extractAppointmentId: extractAppointmentId,
  _officerKind: officerKind,
  _pscKind: pscKind,
  _shareholderKind: shareholderKind,
  _officerStatus: officerStatus,
  _pscStatus: pscStatus,
};
