// S5 — integration tests for services/party/merge.js.
// Requires TEST_DATABASE_URL (throwaway Postgres).

import { it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { describeIntegration, getRepo, getPool, truncateRunData, closePool } from './helpers/appHarness.mjs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

describeIntegration('mergeParties', () => {
  let repo;
  let mergeParties, MergeError;

  beforeAll(() => {
    repo = getRepo();
    ({ mergeParties, MergeError } = require('../services/party/merge.js'));
  });
  afterAll(closePool);
  beforeEach(truncateRunData);

  async function makeParty(over = {}) {
    return repo.insertParty({
      partyType: 'individual',
      fullName: 'Test Person',
      ...over,
    });
  }

  // ─── input validation ────────────────────────────────────────────────────

  it('throws MergeError (invalid_payload) when winnerId is missing', async () => {
    await expect(mergeParties({ loserId: 'x', userId: 'u1' })).rejects.toMatchObject({
      code: 'invalid_payload',
    });
  });

  it('throws MergeError (invalid_payload) when winner === loser', async () => {
    await expect(mergeParties({ winnerId: 'x', loserId: 'x', userId: 'u1' })).rejects.toMatchObject({
      code: 'invalid_payload',
    });
  });

  it('throws MergeError (invalid_payload) when userId is missing', async () => {
    await expect(mergeParties({ winnerId: 'a', loserId: 'b' })).rejects.toMatchObject({
      code: 'invalid_payload',
    });
  });

  it('throws MergeError (not_found) when winner does not exist', async () => {
    const loser = await makeParty({ fullName: 'Loser' });
    await expect(
      mergeParties({ winnerId: '00000000-0000-0000-0000-000000000000', loserId: loser.id, userId: 'u1' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('throws MergeError (not_found) when loser does not exist', async () => {
    const winner = await makeParty({ fullName: 'Winner' });
    await expect(
      mergeParties({ winnerId: winner.id, loserId: '00000000-0000-0000-0000-000000000000', userId: 'u1' }),
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  // ─── basic merge ──────────────────────────────────────────────────────────

  it('sets mergedIntoPartyId on the loser', async () => {
    const winner = await makeParty({ fullName: 'Winner' });
    const loser = await makeParty({ fullName: 'Loser' });
    const result = await mergeParties({ winnerId: winner.id, loserId: loser.id, userId: 'u1', reason: 'dup' });
    expect(result.winnerId).toBe(winner.id);
    expect(result.loserId).toBe(loser.id);
    const loserAfter = await repo.findPartyById(loser.id);
    expect(loserAfter.mergedIntoPartyId).toBe(winner.id);
  });

  it('returns zeros when there are no links or overrides to move', async () => {
    const winner = await makeParty({ fullName: 'W' });
    const loser = await makeParty({ fullName: 'L' });
    const result = await mergeParties({ winnerId: winner.id, loserId: loser.id, userId: 'u1' });
    expect(result.movedLinks).toBe(0);
    expect(result.deletedDuplicateLinks).toBe(0);
    expect(result.mergedOverrides).toBe(0);
    expect(result.queueResolved).toBe(0);
  });

  // ─── invalid_state guards ─────────────────────────────────────────────────

  it('throws invalid_state when the loser is already merged', async () => {
    const a = await makeParty({ fullName: 'A' });
    const b = await makeParty({ fullName: 'B' });
    const c = await makeParty({ fullName: 'C' });
    await mergeParties({ winnerId: a.id, loserId: b.id, userId: 'u1' });
    // b is now merged into a — cannot be loser again
    await expect(mergeParties({ winnerId: c.id, loserId: b.id, userId: 'u1' })).rejects.toMatchObject({
      code: 'invalid_state',
    });
  });

  it('throws invalid_state when the winner is itself merged', async () => {
    const a = await makeParty({ fullName: 'A' });
    const b = await makeParty({ fullName: 'B' });
    const c = await makeParty({ fullName: 'C' });
    await mergeParties({ winnerId: a.id, loserId: b.id, userId: 'u1' });
    // b is merged — b cannot serve as winner
    await expect(mergeParties({ winnerId: b.id, loserId: c.id, userId: 'u1' })).rejects.toMatchObject({
      code: 'invalid_state',
    });
  });

  // ─── link migration ───────────────────────────────────────────────────────

  it('re-points a loser party_link onto the winner', async () => {
    const pool = getPool();
    const winner = await makeParty({ fullName: 'Winner' });
    const loser = await makeParty({ fullName: 'Loser' });

    // Create a dossier and a link on the loser
    const dossierRes = await pool.query(
      `INSERT INTO dossiers (company_number, company_name, case_status)
       VALUES ('12345678', 'Test Co', 'pending') RETURNING id`,
    );
    const dossierId = dossierRes.rows[0].id;
    await pool.query(
      `INSERT INTO party_links (party_id, dossier_id, role, status)
       VALUES ($1::uuid, $2::uuid, 'officer', 'active')`,
      [loser.id, dossierId],
    );

    const result = await mergeParties({ winnerId: winner.id, loserId: loser.id, userId: 'u1' });
    expect(result.movedLinks).toBe(1);

    const linkRes = await pool.query(
      `SELECT party_id FROM party_links WHERE dossier_id = $1::uuid`,
      [dossierId],
    );
    expect(linkRes.rows[0].party_id).toBe(winner.id);
  });

  it('deletes a duplicate loser link when winner already has an identical one', async () => {
    const pool = getPool();
    const winner = await makeParty({ fullName: 'Winner' });
    const loser = await makeParty({ fullName: 'Loser' });

    const dossierRes = await pool.query(
      `INSERT INTO dossiers (company_number, company_name, case_status)
       VALUES ('99887766', 'Dupe Co', 'pending') RETURNING id`,
    );
    const dossierId = dossierRes.rows[0].id;
    // Both winner and loser have a link with identical (role, dates)
    await pool.query(
      `INSERT INTO party_links (party_id, dossier_id, role, status) VALUES
       ($1::uuid, $2::uuid, 'officer', 'active'),
       ($3::uuid, $2::uuid, 'officer', 'active')`,
      [winner.id, dossierId, loser.id],
    );

    const result = await mergeParties({ winnerId: winner.id, loserId: loser.id, userId: 'u1' });
    expect(result.deletedDuplicateLinks).toBe(1);
    expect(result.movedLinks).toBe(0);

    // Only one link should remain (the winner's)
    const linkRes = await pool.query(
      `SELECT COUNT(*)::int AS cnt FROM party_links WHERE dossier_id = $1::uuid`,
      [dossierId],
    );
    expect(linkRes.rows[0].cnt).toBe(1);
  });

  // ─── review-queue resolution ──────────────────────────────────────────────

  it('resolves open review-queue items involving the loser', async () => {
    const pool = getPool();
    const winner = await makeParty({ fullName: 'Winner' });
    const loser = await makeParty({ fullName: 'Loser', needsReview: true });

    await pool.query(
      `INSERT INTO party_review_queue (party_id, candidate_party_id, score, confidence, matched_via, status)
       VALUES ($1::uuid, $2::uuid, 0.95, 'EXACT', 'token_set', 'open')`,
      [loser.id, winner.id],
    );

    const result = await mergeParties({ winnerId: winner.id, loserId: loser.id, userId: 'u1' });
    expect(result.queueResolved).toBe(1);

    const qRes = await pool.query(
      `SELECT status FROM party_review_queue WHERE party_id = $1::uuid`,
      [loser.id],
    );
    expect(qRes.rows[0].status).toBe('merged');
  });

  it('closes unrelated open queue items involving loser as "rejected"', async () => {
    const pool = getPool();
    const winner = await makeParty({ fullName: 'Winner' });
    const loser = await makeParty({ fullName: 'Loser' });
    const third = await makeParty({ fullName: 'Third' });

    await pool.query(
      `INSERT INTO party_review_queue (party_id, candidate_party_id, score, confidence, matched_via, status)
       VALUES ($1::uuid, $2::uuid, 0.80, 'HIGH', 'token_set', 'open')`,
      [loser.id, third.id],
    );

    const result = await mergeParties({ winnerId: winner.id, loserId: loser.id, userId: 'u1' });
    expect(result.queueResolved).toBe(1);

    const qRes = await pool.query(
      `SELECT status FROM party_review_queue WHERE party_id = $1::uuid`,
      [loser.id],
    );
    expect(qRes.rows[0].status).toBe('rejected');
  });
});
