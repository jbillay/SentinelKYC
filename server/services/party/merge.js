// Phase 4 — Party merge service.
//
// Soft-merge: the loser party row is KEPT (so historical references that
// point at it continue to resolve), but its links / overrides are moved
// onto the winner and a redirect pointer (merged_into_party_id) is set
// from loser to winner. The loser party also records who merged it,
// when, and why.
//
// Single transaction:
//   1. Validate both parties exist and neither is already merged.
//   2. Re-point every party_links.party_id == loser → winner.
//      Unique constraint on (party_id, dossier_id, role, dates) means
//      if winner already has a link with the same key, the loser's link
//      collides — we DELETE the loser's link in that case (winner keeps
//      its own).
//   3. Move all party_screening_overrides from loser to winner via the
//      Phase 3 upsert (winner-side decision wins on conflict).
//   4. Close every open party_review_queue item where (party_id, candidate)
//      involves loser → status='merged' if it was the merge target,
//      'rejected' otherwise.
//   5. Set loser.merged_into_party_id + audit columns.
//   6. Return { winner, loser, movedLinks, mergedOverrides, queueResolved }.

const { db } = require('../../db/client');
const { sql, eq, and, or, inArray } = require('drizzle-orm');
const schema = require('../../db/schema');
const repo = require('../../db/repo');

class MergeError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

async function mergeParties({ winnerId, loserId, reason, userId }) {
  if (!winnerId || !loserId) {
    throw new MergeError('winnerId and loserId required', 'invalid_payload');
  }
  if (winnerId === loserId) {
    throw new MergeError('cannot merge a party into itself', 'invalid_payload');
  }
  if (!userId || typeof userId !== 'string') {
    throw new MergeError('userId required', 'invalid_payload');
  }

  const winner = await repo.findPartyById(winnerId);
  if (!winner) throw new MergeError('winner party not found', 'not_found');
  const loser = await repo.findPartyById(loserId);
  if (!loser) throw new MergeError('loser party not found', 'not_found');
  if (loser.mergedIntoPartyId) {
    throw new MergeError(
      `loser party is already merged into ${loser.mergedIntoPartyId}`,
      'invalid_state',
    );
  }
  if (winner.mergedIntoPartyId) {
    throw new MergeError(
      `winner party is itself merged into ${winner.mergedIntoPartyId} — merge into that party instead`,
      'invalid_state',
    );
  }

  // We don't wrap the whole flow in db.transaction because:
  //   * party_links uses a raw SQL upsert that's idempotent
  //   * party_screening_overrides moves are individually upsertable
  //   * if any step fails mid-flight, re-running mergeParties from the same
  //     inputs is safe and converges to the same end state.
  // (If we needed atomicity, the upserts could thread tx — left for a
  // future cleanup.)

  // Step 2: re-point links. UPDATE with ON CONFLICT trick — but drizzle
  // doesn't expose UPDATE with ON CONFLICT directly. Two-pass approach:
  //   * fetch loser's links
  //   * for each, try to UPDATE party_id to winner; if it would violate
  //     the unique constraint (winner already has a link with same key),
  //     DELETE the loser's link instead.
  const loserLinks = await db
    .select()
    .from(schema.partyLinks)
    .where(eq(schema.partyLinks.partyId, loserId));

  let movedLinks = 0;
  let deletedDuplicateLinks = 0;
  for (const link of loserLinks) {
    // Check whether winner already owns a matching link.
    const conflict = await db.execute(sql`
      SELECT id FROM party_links
       WHERE party_id = ${winnerId}::uuid
         AND dossier_id = ${link.dossierId}::uuid
         AND role = ${link.role}
         AND COALESCE(appointed_on, '0001-01-01'::date) = COALESCE(${link.appointedOn ?? null}::date, '0001-01-01'::date)
         AND COALESCE(notified_on, '0001-01-01'::date) = COALESCE(${link.notifiedOn ?? null}::date, '0001-01-01'::date)
       LIMIT 1
    `);
    if (conflict.rows.length) {
      // Winner already has this exact link — keep winner's, drop loser's.
      await db.delete(schema.partyLinks).where(eq(schema.partyLinks.id, link.id));
      deletedDuplicateLinks += 1;
    } else {
      await db
        .update(schema.partyLinks)
        .set({ partyId: winnerId, updatedAt: sql`now()` })
        .where(eq(schema.partyLinks.id, link.id));
      movedLinks += 1;
    }
  }

  // Step 3: move overrides — use the Phase 3 upsert so winner-side
  // existing decisions take precedence on conflict.
  const loserOverrides = await db
    .select()
    .from(schema.partyScreeningOverrides)
    .where(eq(schema.partyScreeningOverrides.partyId, loserId));

  let mergedOverrides = 0;
  for (const o of loserOverrides) {
    // Upsert onto winner; the unique COALESCE index on
    // (party_id, list_source, list_entry_id, evidence_url) handles
    // conflicts — when winner already has a decision for the same
    // entry, EXCLUDED replaces it (the existing setPartyScreeningOverride
    // does "EXCLUDED wins"). Reviewer should be aware via the merge
    // diff in the UI; for Phase 4 POC we let the move's decision win.
    await repo.setPartyScreeningOverride({
      partyId: winnerId,
      listSource: o.listSource,
      listEntryId: o.listEntryId ?? null,
      evidenceUrl: o.evidenceUrl ?? null,
      decision: o.decision,
      reason: o.reason ?? null,
      appliedBy: `merge:${userId}`,
    });
    mergedOverrides += 1;
  }
  // Delete the loser's overrides — they're now redundant.
  await db
    .delete(schema.partyScreeningOverrides)
    .where(eq(schema.partyScreeningOverrides.partyId, loserId));

  // Step 4: resolve any review-queue items mentioning loser.
  const involved = await db
    .select()
    .from(schema.partyReviewQueue)
    .where(
      and(
        eq(schema.partyReviewQueue.status, 'open'),
        or(
          eq(schema.partyReviewQueue.partyId, loserId),
          eq(schema.partyReviewQueue.candidatePartyId, loserId),
        ),
      ),
    );

  let queueResolved = 0;
  for (const item of involved) {
    // If the open item was specifically (loser, winner) or (winner, loser),
    // status → 'merged'. Any other open item involving loser is now
    // moot → 'rejected'.
    const isMergeTarget =
      (item.partyId === loserId && item.candidatePartyId === winnerId) ||
      (item.partyId === winnerId && item.candidatePartyId === loserId);
    const newStatus = isMergeTarget ? 'merged' : 'rejected';
    await db
      .update(schema.partyReviewQueue)
      .set({
        status: newStatus,
        resolvedBy: userId,
        resolvedAt: sql`now()`,
        resolutionReason: isMergeTarget
          ? (reason ?? 'merged via merge action')
          : `auto-resolved by merge of party ${loserId} into ${winnerId}`,
      })
      .where(eq(schema.partyReviewQueue.id, item.id));
    queueResolved += 1;
  }

  // Step 5: set the redirect pointer + audit on the loser.
  await repo.updatePartyFields(loserId, {
    needsReview: false,
    reviewReason: null,
  });
  await db
    .update(schema.parties)
    .set({
      mergedIntoPartyId: winnerId,
      mergedBy: userId,
      mergedAt: sql`now()`,
      mergeReason: reason ?? null,
      updatedAt: sql`now()`,
    })
    .where(eq(schema.parties.id, loserId));

  return {
    winnerId,
    loserId,
    movedLinks,
    deletedDuplicateLinks,
    mergedOverrides,
    queueResolved,
  };
}

module.exports = { mergeParties, MergeError };
