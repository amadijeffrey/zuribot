// Prisma mocked: this proves the credential and token logic, not the storage.
const db = {
  user: { findUnique: jest.fn(), update: jest.fn() },
  admin: { findUnique: jest.fn() },
};
jest.mock('../../src/config/database', () => ({ prisma: db }));

import bcrypt from 'bcryptjs';
import * as userAuth from '../../src/services/user-auth';
import * as adminAuth from '../../src/services/admin-auth';

beforeEach(() => jest.clearAllMocks());

describe('member credentials', () => {
  it('accepts the right password', async () => {
    const hash = await bcrypt.hash('correct-horse', 12);
    db.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.c', name: 'A', passwordHash: hash });
    expect(await userAuth.verifyCredentials('a@b.c', 'correct-horse')).toMatchObject({ id: 'u1' });
  });

  it('rejects the wrong password', async () => {
    const hash = await bcrypt.hash('correct-horse', 12);
    db.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.c', name: 'A', passwordHash: hash });
    expect(await userAuth.verifyCredentials('a@b.c', 'wrong')).toBeNull();
  });

  it('rejects an account that has no password set (bot-created)', async () => {
    db.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.c', name: 'A', passwordHash: null });
    expect(await userAuth.verifyCredentials('a@b.c', 'anything')).toBeNull();
  });

  it('does not reveal whether an email is registered, by result or by timing', async () => {
    const hash = await bcrypt.hash('correct-horse', 12);

    db.user.findUnique.mockResolvedValue(null);
    let t = Date.now();
    const unknown = await userAuth.verifyCredentials('nobody@x.com', 'guess');
    const unknownMs = Date.now() - t;

    db.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.c', name: 'A', passwordHash: hash });
    t = Date.now();
    const known = await userAuth.verifyCredentials('a@b.c', 'guess');
    const knownMs = Date.now() - t;

    expect(unknown).toBeNull();
    expect(known).toBeNull();
    // A malformed placeholder hash would short-circuit in ~0ms and leak which
    // addresses exist; both paths must do real bcrypt work.
    expect(unknownMs).toBeGreaterThan(50);
    expect(Math.abs(unknownMs - knownMs)).toBeLessThan(Math.max(unknownMs, knownMs));
  });
});

describe('token audience separation', () => {
  it('rejects a member token on the admin verifier', async () => {
    const token = userAuth.issueToken({ id: 'u1', email: 'a@b.c', name: 'A' });
    db.admin.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.c', name: 'A', isActive: true });
    expect(await adminAuth.verifyToken(token)).toBeNull();
  });

  it('rejects an admin token on the member verifier', async () => {
    const token = adminAuth.issueToken({ id: 'a1', email: 'admin@b.c', name: 'Admin' });
    db.user.findUnique.mockResolvedValue({ id: 'a1', email: 'admin@b.c', name: 'Admin' });
    expect(await userAuth.verifyToken(token)).toBeNull();
  });

  it('accepts a member token on its own verifier', async () => {
    const token = userAuth.issueToken({ id: 'u1', email: 'a@b.c', name: 'A' });
    db.user.findUnique.mockResolvedValue({ id: 'u1', email: 'a@b.c', name: 'A' });
    expect(await userAuth.verifyToken(token)).toMatchObject({ id: 'u1' });
  });

  it('rejects a token signed with a different secret', async () => {
    const jwt = require('jsonwebtoken');
    const forged = jwt.sign({ sub: 'u1', aud: 'user' }, 'a-totally-different-secret-key-32ch');
    expect(await userAuth.verifyToken(forged)).toBeNull();
  });

  it('deactivating an admin invalidates their token immediately', async () => {
    const token = adminAuth.issueToken({ id: 'a1', email: 'admin@b.c', name: 'Admin' });
    db.admin.findUnique.mockResolvedValue({ id: 'a1', email: 'admin@b.c', name: 'Admin', isActive: false });
    expect(await adminAuth.verifyToken(token)).toBeNull();
  });
});
