// db/repo/parties.js — party master: identity, links, overrides, watchlist, review queue.
// Split from the monolithic db/repo.js (CODE_REVIEW §6.5). db/repo.js is the
// re-exporting facade — call sites keep requiring '../db/repo'.
/* eslint-disable no-unused-vars */
const { eq, desc, asc, and, sql, ilike, inArray, notInArray } = require('drizzle-orm');
const { db } = require('../client');
const {
  dossiers,
  runs,
  runEvents,
  decisionFragments,
  screeningHits,
  screeningEvaluations,
  dossierScreeningOverrides,
  screeningConfig,
  sanctionsLists,
  sanctionsEntries,
  riskMatrixVersions,
  riskMatrixActive,
  parties,
  partyMatchLog,
  partyLinks,
  partyLinkStatusHistory,
  partyReviewQueue,
  partyScreeningOverrides,
  partyWatchlist,
  users,
} = require('../schema');
/* eslint-enable no-unused-vars */
const { escapeLike, pgTextArrayLiteral } = require('./util');

async function insertPartyMatchLog({
  inputName,
  inputCanonical,
  candidates,
  matchCount = 0,
  topScore = null,
  calledBy,
  source = 'api',
}) {
  const [row] = await db
    .insert(partyMatchLog)
    .values({
      inputName,
      inputCanonical,
      candidates: candidates ?? [],
      matchCount,
      topScore: topScore == null ? null : String(topScore),
      calledBy,
      source,
    })
    .returning();
  return row;
}

// Plain INSERT. Returns the inserted row. The resolver uses this for new
// parties; smoke tests use it to seed.

async function insertParty({
  partyType,
  fullName,
  forename,
  middleNames,
  surname,
  title,
  dateOfBirthYear,
  dateOfBirthMonth,
  nationality,
  countryOfResidence,
  registrationNumber,
  registrationCountry,
  dossierId,
  chOfficerAppointmentId,
  aliases,
  identifiers,
  sourceKind = 'manual',
  needsReview,
  reviewReason,
}) {
  const values = {
    partyType,
    fullName,
    forename,
    middleNames,
    surname,
    title,
    dateOfBirthYear,
    dateOfBirthMonth,
    nationality,
    countryOfResidence,
    registrationNumber,
    registrationCountry,
    dossierId,
    chOfficerAppointmentId,
    sourceKind,
  };
  if (aliases !== undefined) values.aliases = aliases;
  if (identifiers !== undefined) values.identifiers = identifiers;
  if (needsReview !== undefined) values.needsReview = needsReview;
  if (reviewReason !== undefined) values.reviewReason = reviewReason;
  const [row] = await db.insert(parties).values(values).returning();
  return row;
}

async function deletePartyById(id) {
  await db.delete(parties).where(eq(parties.id, id));
}

// ---------------------------------------------------------------------------
// Party Master — strong-key lookups + reads
// ---------------------------------------------------------------------------

async function findPartyByAppointmentId(appointmentId) {
  if (!appointmentId) return null;
  const [row] = await db
    .select()
    .from(parties)
    .where(eq(parties.chOfficerAppointmentId, appointmentId))
    .limit(1);
  return row || null;
}

async function findPartyByRegistration({ country, number }) {
  if (!number) return null;
  const conds = [eq(parties.registrationNumber, number)];
  if (country) conds.push(eq(parties.registrationCountry, country));
  const [row] = await db
    .select()
    .from(parties)
    .where(and(...conds))
    .limit(1);
  return row || null;
}

async function findPartyById(id) {
  if (!id) return null;
  const [row] = await db.select().from(parties).where(eq(parties.id, id)).limit(1);
  return row || null;
}

// List with simple filters. q is a substring match on full_name OR canonical;
// limit/offset for pagination. Each row carries a `linkedDossierCount`
// column (count of distinct dossier_ids in party_links pointing at this
// party — Phase 4's KycCard uses this to compute the "also in N other
// dossiers" badge without per-row fetches).

async function listPartiesPage({ q, needsReview, dossierId, limit = 50, offset = 0 } = {}) {
  const filters = [];
  if (q && q.trim()) {
    const like = `%${escapeLike(q.trim().toLowerCase())}%`;
    filters.push(sql`(lower(p.full_name) LIKE ${like} OR p.name_canonical LIKE ${like})`);
  }
  if (typeof needsReview === 'boolean') {
    filters.push(sql`p.needs_review = ${needsReview}`);
  }
  if (dossierId) {
    filters.push(sql`(
      p.dossier_id = ${dossierId}::uuid
      OR EXISTS (
        SELECT 1 FROM party_links pl
        WHERE pl.party_id = p.id AND pl.dossier_id = ${dossierId}::uuid
      )
    )`);
  }
  const whereSql = filters.length
    ? sql`WHERE ${sql.join(filters, sql` AND `)}`
    : sql``;

  const lim = Math.min(Math.max(Number(limit) || 50, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);

  // Use a sub-select for the dossier-count column rather than a LATERAL
  // JOIN — fine at POC scale and easier for drizzle to round-trip.
  const result = await db.execute(sql`
    SELECT
      p.*,
      (
        SELECT COUNT(DISTINCT pl.dossier_id)::int
        FROM party_links pl
        WHERE pl.party_id = p.id
      ) AS linked_dossier_count
    FROM parties p
    ${whereSql}
    ORDER BY p.updated_at DESC
    LIMIT ${lim} OFFSET ${off}
  `);
  return result.rows;
}

// Party + all links + linked dossiers + open review-queue items pointing
// from or to this party. Single multi-query function so the route handler
// stays trivial.

async function getPartyDetail(partyId) {
  const party = await findPartyById(partyId);
  if (!party) return null;

  const links = await db
    .select({
      id: partyLinks.id,
      partyId: partyLinks.partyId,
      dossierId: partyLinks.dossierId,
      role: partyLinks.role,
      roleDetail: partyLinks.roleDetail,
      status: partyLinks.status,
      naturesOfControl: partyLinks.naturesOfControl,
      sharesCount: partyLinks.sharesCount,
      sharesPercentage: partyLinks.sharesPercentage,
      shareClass: partyLinks.shareClass,
      appointedOn: partyLinks.appointedOn,
      resignedOn: partyLinks.resignedOn,
      notifiedOn: partyLinks.notifiedOn,
      ceasedOn: partyLinks.ceasedOn,
      matchConfidence: partyLinks.matchConfidence,
      matchEvidence: partyLinks.matchEvidence,
      firstSeenRunId: partyLinks.firstSeenRunId,
      lastSeenRunId: partyLinks.lastSeenRunId,
      createdAt: partyLinks.createdAt,
      updatedAt: partyLinks.updatedAt,
      companyNumber: dossiers.companyNumber,
      companyName: dossiers.companyName,
      // Cross-dossier risk view: the dossier's current case status + the
      // risk tier from its latest risk-bearing run, so the party page can
      // show "UBO on a High-risk case" without an extra fetch per row.
      caseStatus: dossiers.caseStatus,
      riskTier: sql`(
        SELECT r.final_risk_assessment->>'tier'
        FROM runs r
        WHERE r.dossier_id = ${partyLinks.dossierId}
          AND r.final_risk_assessment IS NOT NULL
        ORDER BY r.started_at DESC
        LIMIT 1
      )`.as('risk_tier'),
    })
    .from(partyLinks)
    .innerJoin(dossiers, eq(dossiers.id, partyLinks.dossierId))
    .where(eq(partyLinks.partyId, partyId))
    .orderBy(desc(partyLinks.updatedAt));

  // Reviewer-facing payload: any OPEN queue item involving this party,
  // from either side of the (party, candidate) pair.
  const reviewItems = await db
    .select()
    .from(partyReviewQueue)
    .where(
      and(
        eq(partyReviewQueue.status, 'open'),
        sql`(${partyReviewQueue.partyId} = ${partyId}::uuid
             OR ${partyReviewQueue.candidatePartyId} = ${partyId}::uuid)`,
      ),
    )
    .orderBy(desc(partyReviewQueue.createdAt));

  // Cross-dossier risk roll-up: distinct dossiers this party touches and the
  // worst risk tier across them (High > Medium > Low). Drives the summary
  // chip at the top of the party page.
  const TIER_RANK = { Low: 1, Medium: 2, High: 3 };
  const tierByDossier = new Map();
  for (const l of links) {
    if (!l.dossierId) continue;
    if (!tierByDossier.has(l.dossierId)) tierByDossier.set(l.dossierId, l.riskTier || null);
  }
  let worstTier = null;
  let highCount = 0;
  for (const t of tierByDossier.values()) {
    if (!t) continue;
    if (!worstTier || (TIER_RANK[t] || 0) > (TIER_RANK[worstTier] || 0)) worstTier = t;
    if (t === 'High') highCount += 1;
  }
  const riskSummary = {
    dossierCount: tierByDossier.size,
    worstTier,
    highRiskDossierCount: highCount,
  };

  const watched = await isPartyWatched(partyId);

  return { party, links, reviewItems, riskSummary, isWatched: watched };
}

// ---------------------------------------------------------------------------
// Party Master — resolver writes (idempotent)
// ---------------------------------------------------------------------------

// Plain insert wrapped to return the inserted row. Used by the resolver's
// "new party" path; strong-key updates go via updateParty.

async function insertNewParty(input) {
  return insertParty(input);
}

// Patch a subset of party columns on an existing row. The resolver uses
// this to enrich an auto-linked party with newly-observed identifiers /
// aliases without touching unrelated fields.

async function updatePartyFields(id, patch) {
  if (!id || !patch) return null;
  const set = { updatedAt: sql`now()` };
  for (const k of [
    'fullName',
    'forename',
    'middleNames',
    'surname',
    'title',
    'dateOfBirthYear',
    'dateOfBirthMonth',
    'nationality',
    'countryOfResidence',
    'registrationNumber',
    'registrationCountry',
    'dossierId',
    'chOfficerAppointmentId',
    'aliases',
    'identifiers',
    'needsReview',
    'reviewReason',
  ]) {
    if (patch[k] !== undefined) set[k] = patch[k];
  }
  const [row] = await db.update(parties).set(set).where(eq(parties.id, id)).returning();
  return row || null;
}

// Format a JS string[] as a Postgres array literal: `{"a","b","c"}`. Returns
// null for null/empty input. Necessary because drizzle's sql tag, when given
// a single-element array, sends it as the bare string (flattening it) which
// pg then rejects as malformed text[]. Building the literal in JS gives us a
// stable shape regardless of element count.

// Idempotent upsert on the party_links_uniq index. Returns the row + a
// boolean indicating whether it was newly inserted (so the resolver knows
// to emit a status-history row only on a real state change).
async function upsertPartyLink(input) {
  if (!input.partyId || !input.dossierId || !input.role || !input.status) {
    throw new Error('upsertPartyLink: partyId, dossierId, role, status required');
  }
  const values = {
    partyId: input.partyId,
    dossierId: input.dossierId,
    role: input.role,
    roleDetail: input.roleDetail ?? null,
    status: input.status,
    naturesOfControl: pgTextArrayLiteral(input.naturesOfControl),
    sharesCount: input.sharesCount == null ? null : String(input.sharesCount),
    sharesPercentage: input.sharesPercentage == null ? null : String(input.sharesPercentage),
    shareClass: input.shareClass ?? null,
    appointedOn: input.appointedOn ?? null,
    resignedOn: input.resignedOn ?? null,
    notifiedOn: input.notifiedOn ?? null,
    ceasedOn: input.ceasedOn ?? null,
    sourceRef: input.sourceRef ?? null,
    firstSeenRunId: input.runId ?? null,
    lastSeenRunId: input.runId ?? null,
    matchConfidence: input.matchConfidence == null ? null : String(input.matchConfidence),
    matchEvidence: input.matchEvidence ?? null,
  };

  // ON CONFLICT on the partial-NULL-coalescing unique index. Drizzle's
  // onConflictDoUpdate targets the indexed expression directly via the
  // raw `target` form.
  const conflictTarget = sql`(
    party_id,
    dossier_id,
    role,
    COALESCE(appointed_on, '0001-01-01'::date),
    COALESCE(notified_on, '0001-01-01'::date)
  )`;

  // Use an INSERT … ON CONFLICT and capture xmax to detect insert vs update
  // in a single round-trip (xmax = 0 means a fresh insert).
  const result = await db.execute(sql`
    INSERT INTO party_links (
      party_id, dossier_id, role, role_detail, status,
      natures_of_control, shares_count, shares_percentage, share_class,
      appointed_on, resigned_on, notified_on, ceased_on,
      source_ref, first_seen_run_id, last_seen_run_id,
      match_confidence, match_evidence
    ) VALUES (
      ${values.partyId}::uuid, ${values.dossierId}::uuid, ${values.role}, ${values.roleDetail}, ${values.status},
      ${values.naturesOfControl}::text[], ${values.sharesCount}::numeric, ${values.sharesPercentage}::numeric, ${values.shareClass},
      ${values.appointedOn}::date, ${values.resignedOn}::date, ${values.notifiedOn}::date, ${values.ceasedOn}::date,
      ${values.sourceRef}::jsonb, ${values.firstSeenRunId}::uuid, ${values.lastSeenRunId}::uuid,
      ${values.matchConfidence}::numeric, ${values.matchEvidence}::jsonb
    )
    ON CONFLICT ${conflictTarget} DO UPDATE SET
      status = EXCLUDED.status,
      role_detail = EXCLUDED.role_detail,
      natures_of_control = EXCLUDED.natures_of_control,
      shares_count = EXCLUDED.shares_count,
      shares_percentage = EXCLUDED.shares_percentage,
      share_class = EXCLUDED.share_class,
      resigned_on = EXCLUDED.resigned_on,
      ceased_on = EXCLUDED.ceased_on,
      source_ref = EXCLUDED.source_ref,
      last_seen_run_id = EXCLUDED.last_seen_run_id,
      match_confidence = COALESCE(EXCLUDED.match_confidence, party_links.match_confidence),
      match_evidence = COALESCE(EXCLUDED.match_evidence, party_links.match_evidence),
      updated_at = now()
    RETURNING *, (xmax = 0) AS inserted
  `);

  const row = result.rows[0];
  return { row, inserted: !!row?.inserted };
}

async function appendPartyStatusTransition({ linkId, fromStatus, toStatus, runId, reason }) {
  if (!linkId || !toStatus) {
    throw new Error('appendPartyStatusTransition: linkId, toStatus required');
  }
  const [row] = await db
    .insert(partyLinkStatusHistory)
    .values({
      linkId,
      fromStatus: fromStatus ?? null,
      toStatus,
      runId: runId ?? null,
      reason: reason ?? null,
    })
    .returning();
  return row;
}

// Upsert a review-queue row on the partial-unique (party_id, candidate_party_id)
// WHERE status='open' index. Re-runs on the same dossier won't spawn dupes.

async function enqueueReviewItem({
  partyId,
  candidatePartyId,
  score,
  confidence,
  matchedVia,
  evidence,
  runId,
}) {
  if (!partyId || !candidatePartyId) {
    throw new Error('enqueueReviewItem: partyId + candidatePartyId required');
  }
  if (partyId === candidatePartyId) {
    // A party can't be a dedup candidate against itself. Silently skip.
    return null;
  }
  const result = await db.execute(sql`
    INSERT INTO party_review_queue (
      party_id, candidate_party_id, score, confidence, matched_via,
      evidence, raised_by_run_id
    ) VALUES (
      ${partyId}::uuid, ${candidatePartyId}::uuid,
      ${String(score)}::numeric, ${confidence}, ${matchedVia},
      ${evidence ?? {}}::jsonb, ${runId ?? null}::uuid
    )
    ON CONFLICT (party_id, candidate_party_id) WHERE status = 'open' DO UPDATE SET
      score = EXCLUDED.score,
      confidence = EXCLUDED.confidence,
      matched_via = EXCLUDED.matched_via,
      evidence = EXCLUDED.evidence,
      raised_by_run_id = EXCLUDED.raised_by_run_id
    RETURNING *
  `);
  return result.rows[0] || null;
}

// All party_links on this dossier with a status the resolver cares about
// (active/resigned/ceased — historical is the terminal state and gets
// skipped here). Used by historical-reconciliation: any link not touched
// by the current run flips to 'historical'.

async function getOpenLinksForDossier(dossierId) {
  if (!dossierId) return [];
  return db
    .select()
    .from(partyLinks)
    .where(
      and(
        eq(partyLinks.dossierId, dossierId),
        notInArray(partyLinks.status, ['historical']),
      ),
    );
}

// ---------------------------------------------------------------------------
// Phase 3 — Party-level screening overrides
// ---------------------------------------------------------------------------

// Upsert on (party_id, list_source, list_entry_id, evidence_url). Returns the
// row. Mirrors applyOverridesForward's semantics but writes to the
// party-level table instead.

async function setPartyScreeningOverride({
  partyId,
  listSource,
  listEntryId,
  evidenceUrl,
  decision,
  reason,
  appliedBy,
}) {
  if (!partyId || !listSource || !decision) {
    throw new Error('setPartyScreeningOverride: partyId, listSource, decision required');
  }
  // Conflict target matches the COALESCE-based unique index created in
  // migration 0017 — see the comment there for why NULL columns can't
  // participate in a plain CONSTRAINT UNIQUE.
  const result = await db.execute(sql`
    INSERT INTO party_screening_overrides (
      party_id, list_source, list_entry_id, evidence_url,
      decision, reason, applied_by
    ) VALUES (
      ${partyId}::uuid, ${listSource}, ${listEntryId ?? null}, ${evidenceUrl ?? null},
      ${decision}, ${reason ?? null}, ${appliedBy ?? null}
    )
    ON CONFLICT (
      party_id,
      list_source,
      COALESCE(list_entry_id, ''),
      COALESCE(evidence_url, '')
    ) DO UPDATE SET
      decision = EXCLUDED.decision,
      reason = EXCLUDED.reason,
      applied_by = EXCLUDED.applied_by,
      updated_at = now()
    RETURNING *
  `);
  return result.rows[0] || null;
}

// Delete an override (reviewer "clears" the cross-dossier dismissal/confirm).

async function clearPartyScreeningOverride({ partyId, listSource, listEntryId, evidenceUrl }) {
  await db.execute(sql`
    DELETE FROM party_screening_overrides
    WHERE party_id = ${partyId}::uuid
      AND list_source = ${listSource}
      AND list_entry_id IS NOT DISTINCT FROM ${listEntryId ?? null}
      AND evidence_url IS NOT DISTINCT FROM ${evidenceUrl ?? null}
  `);
}

async function getOverridesForParty(partyId) {
  if (!partyId) return [];
  return db
    .select()
    .from(partyScreeningOverrides)
    .where(eq(partyScreeningOverrides.partyId, partyId));
}

// Bulk fetch — used by evaluators to load all party-level overrides for
// every partyId in the current run's hit set in one query.

async function getOverridesForParties(partyIds) {
  if (!Array.isArray(partyIds) || partyIds.length === 0) return [];
  return db
    .select()
    .from(partyScreeningOverrides)
    .where(inArray(partyScreeningOverrides.partyId, partyIds));
}

// ---------------------------------------------------------------------------
// Party screening summary (cross-dossier).
//
// Aggregates every screening_hit carrying this party_id (across all runs /
// dossiers) with its evaluation, then resolves an effective decision per hit:
//   per-run human override  >  cross-dossier party override  >  LLM decision.
// Returns counts + per-list buckets + the worst status + the enriched hit
// rows (joined to the dossier they were raised on so the UI can deep-link).
// ---------------------------------------------------------------------------

const SANCTIONS_LIST_SOURCES = ['ofac_sdn', 'uk_hmt'];

function rankStatus(s) {
  if (s === 'confirmed') return 3;
  if (s === 'needs_review') return 2;
  if (s === 'dismissed') return 1;
  return 0;
}

async function getPartyScreeningSummary(partyId) {
  if (!partyId) return null;

  const hitRows = (await db.execute(sql`
    SELECT
      h.id              AS hit_id,
      h.list_source     AS list_source,
      h.list_entry_id   AS list_entry_id,
      -- Adverse-media hits carry the article URL in raw_entry; it's the key
      -- adverse-media overrides match on (list_entry_id is null for them).
      h.raw_entry->>'url' AS evidence_url,
      h.subject_name    AS subject_name,
      h.match_score     AS match_score,
      h.created_at      AS created_at,
      r.id              AS run_id,
      d.company_number  AS company_number,
      d.company_name    AS company_name,
      e.decision        AS decision,
      e.category        AS category,
      e.severity        AS severity,
      e.llm_reasoning   AS llm_reasoning,
      e.human_override  AS human_override,
      e.override_reason AS override_reason
    FROM screening_hits h
    LEFT JOIN screening_evaluations e ON e.hit_id = h.id
    LEFT JOIN runs r       ON r.id = h.run_id
    LEFT JOIN dossiers d   ON d.id = r.dossier_id
    WHERE h.party_id = ${partyId}::uuid
    ORDER BY h.created_at DESC
  `)).rows;

  // Composite key mirrors the unique constraint + the evaluators' matching
  // logic: sanctions overrides key on list_entry_id (evidence_url null),
  // adverse-media overrides key on evidence_url (list_entry_id null).
  const overrideKey = (listSource, listEntryId, evidenceUrl) =>
    `${listSource}::${listEntryId ?? ''}::${evidenceUrl ?? ''}`;
  const overrides = await getOverridesForParty(partyId);
  const overrideByKey = new Map();
  for (const o of overrides) {
    overrideByKey.set(overrideKey(o.listSource, o.listEntryId, o.evidenceUrl), o);
  }

  const counts = { confirmed: 0, needsReview: 0, dismissed: 0, total: 0 };
  const emptyBucket = () => ({ confirmed: 0, needsReview: 0, dismissed: 0 });
  const byList = {
    ofac_sdn: emptyBucket(),
    uk_hmt: emptyBucket(),
    adverse_media: emptyBucket(),
  };
  let worst = 'clean';

  const hits = hitRows.map((row) => {
    const partyOverride =
      overrideByKey.get(overrideKey(row.list_source, row.list_entry_id, row.evidence_url)) || null;
    // Effective decision precedence: per-run human override, then the
    // cross-dossier party override, then the raw LLM decision.
    const effective =
      row.human_override || partyOverride?.decision || row.decision || 'unevaluated';

    if (effective === 'confirmed') counts.confirmed += 1;
    else if (effective === 'needs_review') counts.needsReview += 1;
    else if (effective === 'dismissed') counts.dismissed += 1;
    if (effective !== 'unevaluated') counts.total += 1;

    if (byList[row.list_source] && effective !== 'unevaluated') {
      if (effective === 'confirmed') byList[row.list_source].confirmed += 1;
      else if (effective === 'needs_review') byList[row.list_source].needsReview += 1;
      else if (effective === 'dismissed') byList[row.list_source].dismissed += 1;
    }

    if (rankStatus(effective) > rankStatus(worst)) worst = effective;

    return {
      hitId: row.hit_id,
      listSource: row.list_source,
      listEntryId: row.list_entry_id,
      evidenceUrl: row.evidence_url || null,
      subjectName: row.subject_name,
      matchScore: row.match_score != null ? Number(row.match_score) : null,
      createdAt: row.created_at,
      runId: row.run_id,
      companyNumber: row.company_number,
      companyName: row.company_name,
      decision: row.decision || null,
      category: row.category || null,
      severity: row.severity || null,
      llmReasoning: row.llm_reasoning || null,
      humanOverride: row.human_override || null,
      overrideReason: row.override_reason || null,
      partyOverride: partyOverride
        ? { decision: partyOverride.decision, reason: partyOverride.reason ?? null }
        : null,
      isSanctions: SANCTIONS_LIST_SOURCES.includes(row.list_source),
      effectiveDecision: effective,
    };
  });

  return {
    partyId,
    counts,
    worstStatus: worst,
    byList,
    hits,
    overrides,
  };
}

// ---------------------------------------------------------------------------
// Party watchlist
// ---------------------------------------------------------------------------

// Upsert (idempotent on party_id). Re-flagging refreshes reason/addedBy.

async function addPartyToWatchlist({ partyId, reason, addedBy }) {
  if (!partyId) throw new Error('addPartyToWatchlist: partyId required');
  const [row] = await db
    .insert(partyWatchlist)
    .values({ partyId, reason: reason ?? null, addedBy: addedBy ?? null })
    .onConflictDoUpdate({
      target: partyWatchlist.partyId,
      set: {
        reason: sql`excluded.reason`,
        addedBy: sql`excluded.added_by`,
        createdAt: sql`now()`,
      },
    })
    .returning();
  return row;
}

async function removePartyFromWatchlist(partyId) {
  if (!partyId) return false;
  const rows = await db
    .delete(partyWatchlist)
    .where(eq(partyWatchlist.partyId, partyId))
    .returning({ id: partyWatchlist.id });
  return rows.length > 0;
}

async function isPartyWatched(partyId) {
  if (!partyId) return false;
  const [row] = await db
    .select({ id: partyWatchlist.id })
    .from(partyWatchlist)
    .where(eq(partyWatchlist.partyId, partyId))
    .limit(1);
  return !!row;
}

// Watched parties for the Watchlist page — joins the party master so the row
// can show name/type, plus the party's linked-dossier count.

async function listWatchedParties({ limit = 100, offset = 0 } = {}) {
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 200);
  const off = Math.max(Number(offset) || 0, 0);
  const result = await db.execute(sql`
    SELECT
      w.id            AS watchlist_id,
      w.reason        AS reason,
      w.added_by      AS added_by,
      w.created_at    AS added_at,
      p.id            AS party_id,
      p.full_name     AS full_name,
      p.party_type    AS party_type,
      (
        SELECT COUNT(DISTINCT pl.dossier_id)::int
        FROM party_links pl
        WHERE pl.party_id = p.id
      ) AS linked_dossier_count
    FROM party_watchlist w
    INNER JOIN parties p ON p.id = w.party_id
    ORDER BY w.created_at DESC
    LIMIT ${lim} OFFSET ${off}
  `);
  return result.rows;
}

// ---------------------------------------------------------------------------
// Phase 4 — Party review queue read + resolve
// ---------------------------------------------------------------------------

async function listOpenReviewQueueItems({ limit = 100, offset = 0 } = {}) {
  // Returns the open queue with the joined display name of both parties
  // so the UI can render side-by-side without an extra fetch per row.
  const rows = await db.execute(sql`
    SELECT
      q.id,
      q.party_id,
      q.candidate_party_id,
      q.score,
      q.confidence,
      q.matched_via,
      q.evidence,
      q.raised_by_run_id,
      q.created_at,
      p_new.full_name AS new_party_name,
      p_new.party_type AS new_party_type,
      p_new.needs_review AS new_party_needs_review,
      p_cand.full_name AS candidate_party_name,
      p_cand.party_type AS candidate_party_type
    FROM party_review_queue q
    INNER JOIN parties p_new ON p_new.id = q.party_id
    INNER JOIN parties p_cand ON p_cand.id = q.candidate_party_id
    WHERE q.status = 'open'
    ORDER BY q.score DESC, q.created_at DESC
    LIMIT ${Math.min(Math.max(Number(limit) || 100, 1), 500)}
    OFFSET ${Math.max(Number(offset) || 0, 0)}
  `);
  return rows.rows;
}

async function getReviewQueueItem(id) {
  if (!id) return null;
  const [row] = await db
    .select()
    .from(partyReviewQueue)
    .where(eq(partyReviewQueue.id, id))
    .limit(1);
  return row || null;
}

// Used by the 'reject' path on POST /review-queue/:id/resolve. Merge
// resolutions go through services/party/merge.js which itself flips the
// queue item's status — this helper is the simpler reject case.

async function resolveReviewQueueItem({ id, status, resolvedBy, reason }) {
  if (!id || !status) throw new Error('resolveReviewQueueItem: id and status required');
  if (!['merged', 'rejected'].includes(status)) {
    throw new Error(`resolveReviewQueueItem: status must be 'merged' | 'rejected'`);
  }
  const [row] = await db
    .update(partyReviewQueue)
    .set({
      status,
      resolvedBy: resolvedBy ?? null,
      resolvedAt: sql`now()`,
      resolutionReason: reason ?? null,
    })
    .where(eq(partyReviewQueue.id, id))
    .returning();
  return row || null;
}

// Bulk-flip a list of link ids to 'historical' and append a status_history
// row for each. Used by the resolver's historical-reconciliation pass.

async function markLinksHistorical(linkIds, { runId, reason } = {}) {
  if (!Array.isArray(linkIds) || !linkIds.length) return [];
  const ids = linkIds.filter(Boolean);
  if (!ids.length) return [];

  // Pull current statuses BEFORE the update so we can record from→to.
  const prior = await db
    .select({ id: partyLinks.id, status: partyLinks.status })
    .from(partyLinks)
    .where(inArray(partyLinks.id, ids));

  await db
    .update(partyLinks)
    .set({ status: 'historical', updatedAt: sql`now()` })
    .where(inArray(partyLinks.id, ids));

  for (const p of prior) {
    if (p.status === 'historical') continue;
    await db.insert(partyLinkStatusHistory).values({
      linkId: p.id,
      fromStatus: p.status,
      toStatus: 'historical',
      runId: runId ?? null,
      reason: reason ?? 'not observed in latest run',
    });
  }
  return prior;
}

// ---------------------------------------------------------------------------
// Users / authentication (R1)
// ---------------------------------------------------------------------------

// Username lookup is case-insensitive (login normalises to lower-case; the
// unique lower() index in migration 0020 backs this). Returns the full row
// incl. password_hash — callers must never serialise password_hash to a client.

module.exports = {
  insertPartyMatchLog,
  insertParty,
  deletePartyById,
  findPartyByAppointmentId,
  findPartyByRegistration,
  findPartyById,
  listPartiesPage,
  getPartyDetail,
  insertNewParty,
  updatePartyFields,
  upsertPartyLink,
  appendPartyStatusTransition,
  enqueueReviewItem,
  getOpenLinksForDossier,
  setPartyScreeningOverride,
  clearPartyScreeningOverride,
  getOverridesForParty,
  getOverridesForParties,
  getPartyScreeningSummary,
  addPartyToWatchlist,
  removePartyFromWatchlist,
  isPartyWatched,
  listWatchedParties,
  listOpenReviewQueueItems,
  getReviewQueueItem,
  resolveReviewQueueItem,
  markLinksHistorical,
};
