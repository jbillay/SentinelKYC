// Phase 3 — party master round-trips against a real (test) Postgres: insert,
// strong-key lookups, field patch, watchlist, delete.
import { it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { describeIntegration, getRepo, truncateRunData, closePool } from './helpers/appHarness.mjs';

describeIntegration('repo: parties', () => {
  let db;
  beforeAll(() => { db = getRepo(); });
  afterAll(closePool);
  beforeEach(truncateRunData);

  async function makeIndividual(over = {}) {
    return db.insertParty({
      partyType: 'individual',
      fullName: 'John Smith',
      surname: 'Smith',
      forename: 'John',
      dateOfBirthYear: 1975,
      dateOfBirthMonth: 4,
      nationality: ['British'],
      chOfficerAppointmentId: 'appt-123',
      ...over,
    });
  }

  it('inserts an individual and finds it by id', async () => {
    const p = await makeIndividual();
    expect(p.partyType).toBe('individual');
    const got = await db.findPartyById(p.id);
    expect(got.fullName).toBe('John Smith');
  });

  it('finds a party by CH appointment id', async () => {
    await makeIndividual();
    expect(await db.findPartyByAppointmentId('appt-123')).toMatchObject({ fullName: 'John Smith' });
    expect(await db.findPartyByAppointmentId('nope')).toBeNull();
  });

  it('finds a corporate party by registration number + country', async () => {
    await db.insertParty({
      partyType: 'organisation',
      fullName: 'PARENT CO LTD',
      registrationNumber: '09999999',
      registrationCountry: 'gb',
    });
    expect(await db.findPartyByRegistration({ country: 'gb', number: '09999999' })).toMatchObject({
      fullName: 'PARENT CO LTD',
    });
    expect(await db.findPartyByRegistration({ number: 'absent' })).toBeNull();
  });

  it('patches a subset of party fields', async () => {
    const p = await makeIndividual();
    const updated = await db.updatePartyFields(p.id, { countryOfResidence: 'gb', needsReview: true });
    expect(updated.countryOfResidence).toBe('gb');
    expect(updated.needsReview).toBe(true);
    expect(updated.fullName).toBe('John Smith'); // untouched
  });

  it('adds, checks and removes a watchlist membership (idempotent upsert)', async () => {
    const p = await makeIndividual();
    await db.addPartyToWatchlist({ partyId: p.id, reason: 'PEP', addedBy: 'reviewer-1' });
    await db.addPartyToWatchlist({ partyId: p.id, reason: 'PEP again' }); // upsert, no dup
    expect(await db.isPartyWatched(p.id)).toBe(true);
    expect(await db.removePartyFromWatchlist(p.id)).toBe(true);
    expect(await db.isPartyWatched(p.id)).toBe(false);
    expect(await db.removePartyFromWatchlist(p.id)).toBe(false); // already gone
  });

  it('deletes a party', async () => {
    const p = await makeIndividual();
    await db.deletePartyById(p.id);
    expect(await db.findPartyById(p.id)).toBeNull();
  });
});
