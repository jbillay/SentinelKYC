// Integration tests for db/repo/users.js against the test Postgres.
import { it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { createRequire } from 'node:module';
import {
  describeIntegration,
  getRepo,
  getPool,
  closePool,
} from './helpers/appHarness.mjs';

const require = createRequire(import.meta.url);

describeIntegration('repo: users', () => {
  let repo;
  let passwords;

  beforeAll(async () => {
    repo = getRepo();
    passwords = require('../services/auth/passwords');
    // Truncate users between runs to avoid uniqueness collisions.
    await getPool().query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
  }, 30_000);

  afterAll(closePool);

  beforeEach(async () => {
    await getPool().query('TRUNCATE TABLE users RESTART IDENTITY CASCADE');
  });

  it('upsertUser creates a new user row', async () => {
    const hash = await passwords.hashPassword('Hunter22!');
    const user = await repo.upsertUser({ username: 'alice', passwordHash: hash, role: 'analyst' });
    expect(user).toMatchObject({ username: 'alice', role: 'analyst', active: true });
    expect(user.id).toBeTruthy();
    expect(user.passwordHash).toBe(hash);
  });

  it('upsertUser is idempotent — updates the hash on re-seed', async () => {
    const hash1 = await passwords.hashPassword('Pass1!');
    const hash2 = await passwords.hashPassword('Pass2!');
    const u1 = await repo.upsertUser({ username: 'bob', passwordHash: hash1, role: 'analyst' });
    const u2 = await repo.upsertUser({ username: 'bob', passwordHash: hash2, role: 'reviewer' });
    expect(u1.id).toBe(u2.id);       // same row
    expect(u2.passwordHash).toBe(hash2);
    expect(u2.role).toBe('reviewer');
  });

  it('getUserByUsername finds the seeded user', async () => {
    const hash = await passwords.hashPassword('Pass1!');
    const created = await repo.upsertUser({ username: 'carol', passwordHash: hash });
    const found = await repo.getUserByUsername('carol');
    expect(found.id).toBe(created.id);
    expect(found.username).toBe('carol');
  });

  it('getUserByUsername is case-insensitive', async () => {
    const hash = await passwords.hashPassword('Pass1!');
    await repo.upsertUser({ username: 'Dave', passwordHash: hash });
    const found = await repo.getUserByUsername('dave');
    expect(found).not.toBeNull();
    expect(found.username).toBe('Dave');
  });

  it('getUserByUsername returns null for unknown username', async () => {
    const result = await repo.getUserByUsername('nobody');
    expect(result).toBeNull();
  });

  it('getUserById returns the user or null', async () => {
    const hash = await passwords.hashPassword('Pass1!');
    const created = await repo.upsertUser({ username: 'eve', passwordHash: hash });
    const found = await repo.getUserById(created.id);
    expect(found.username).toBe('eve');

    const missing = await repo.getUserById('00000000-0000-4000-8000-000000000000');
    expect(missing).toBeNull();
  });

  it('updateUserProfile patches displayName and email', async () => {
    const hash = await passwords.hashPassword('Pass1!');
    const user = await repo.upsertUser({ username: 'frank', passwordHash: hash });
    const updated = await repo.updateUserProfile(user.id, { displayName: 'Frank B', email: 'frank@test.com' });
    expect(updated.displayName).toBe('Frank B');
    expect(updated.email).toBe('frank@test.com');
    expect(updated.username).toBe('frank'); // untouched
  });

  it('updateUserPassword stores the new hash', async () => {
    const hash1 = await passwords.hashPassword('Old1!');
    const hash2 = await passwords.hashPassword('New1!');
    const user = await repo.upsertUser({ username: 'grace', passwordHash: hash1 });
    await repo.updateUserPassword(user.id, hash2);
    const reloaded = await repo.getUserById(user.id);
    expect(reloaded.passwordHash).toBe(hash2);
    expect(await passwords.verifyPassword('New1!', reloaded.passwordHash)).toBe(true);
  });

  it('touchUserLogin updates last_login_at', async () => {
    const hash = await passwords.hashPassword('Pass1!');
    const user = await repo.upsertUser({ username: 'henry', passwordHash: hash });
    expect(user.lastLoginAt).toBeNull();
    await repo.touchUserLogin(user.id);
    const reloaded = await repo.getUserById(user.id);
    expect(reloaded.lastLoginAt).not.toBeNull();
  });

  it('listUsers returns all users ordered by username', async () => {
    const hash = await passwords.hashPassword('Pass1!');
    await repo.upsertUser({ username: 'zara', passwordHash: hash, role: 'admin' });
    await repo.upsertUser({ username: 'aaron', passwordHash: hash, role: 'analyst' });
    const list = await repo.listUsers();
    expect(list.length).toBeGreaterThanOrEqual(2);
    expect(list[0].username).toBe('aaron'); // alphabetical
    // No passwordHash in list
    expect(list[0].passwordHash).toBeUndefined();
  });
});
