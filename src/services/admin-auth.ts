import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// bcryptjs is pure JS — no native build step, so it can't break a serverless
// deploy the way node-bcrypt's prebuilt binaries sometimes do.
const BCRYPT_ROUNDS = 12;
const AUDIENCE = 'admin';

export const MIN_PASSWORD_LENGTH = 12;

// A valid bcrypt hash of a random value — nothing will ever match it. Used to
// keep failed-login timing constant; see verifyCredentials.
const NON_MATCHING_HASH = '$2b$12$9F3ud/pap/R.grG9Esr4r.pnfQ38hlwyLkoRS.hR.3tnMdA5sV91a';

export interface AdminIdentity {
  id: string;
  email: string;
  name: string | null;
}

export const hashPassword = (plain: string): Promise<string> =>
  bcrypt.hash(plain, BCRYPT_ROUNDS);

// Returns the admin on success, null on any failure. Deliberately does not
// distinguish "no such account" from "wrong password" — that difference lets an
// attacker enumerate valid admin emails.
export const verifyCredentials = async (
  email: string,
  password: string,
): Promise<AdminIdentity | null> => {
  const admin = await prisma.admin.findUnique({ where: { email: email.toLowerCase() } });

  // Compare against a real (never-matching) hash when the account is missing or
  // has no password, so an unknown email costs the same ~250ms as a known one.
  // A malformed placeholder would short-circuit in ~0ms and leak which emails
  // are valid admins.
  const hash = admin?.passwordHash ?? NON_MATCHING_HASH;
  const ok = await bcrypt.compare(password, hash);

  if (!admin || !admin.passwordHash || !admin.isActive || !ok) {
    logger.warn('Failed admin login attempt', { email: email.toLowerCase() });
    return null;
  }

  await prisma.admin.update({
    where: { id: admin.id },
    data: { lastLoginAt: new Date() },
  });

  return { id: admin.id, email: admin.email, name: admin.name };
};

export const issueToken = (admin: AdminIdentity): string => {
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');

  return jwt.sign(
    { sub: admin.id, email: admin.email, aud: AUDIENCE },
    env.JWT_SECRET,
    { expiresIn: env.JWT_EXPIRES_IN } as jwt.SignOptions,
  );
};

// Verifies the token AND re-checks the account, so deactivating an admin takes
// effect immediately rather than when their token happens to expire.
export const verifyToken = async (token: string): Promise<AdminIdentity | null> => {
  if (!env.JWT_SECRET) return null;

  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { audience: AUDIENCE }) as jwt.JwtPayload;
    if (!payload.sub) return null;

    const admin = await prisma.admin.findUnique({ where: { id: String(payload.sub) } });
    if (!admin || !admin.isActive) return null;

    return { id: admin.id, email: admin.email, name: admin.name };
  } catch {
    return null;
  }
};

export const changePassword = async (
  adminId: string,
  currentPassword: string,
  newPassword: string,
): Promise<boolean> => {
  const admin = await prisma.admin.findUnique({ where: { id: adminId } });
  if (!admin?.passwordHash) return false;

  if (!(await bcrypt.compare(currentPassword, admin.passwordHash))) {
    logger.warn('Password change rejected — current password incorrect', { adminId });
    return false;
  }

  await prisma.admin.update({
    where: { id: adminId },
    data: { passwordHash: await hashPassword(newPassword) },
  });

  logger.info('Admin password changed', { adminId });
  return true;
};
