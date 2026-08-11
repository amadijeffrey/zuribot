import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// Member (subscriber) authentication. Deliberately separate from admin auth:
// the two have different lifetimes, audiences and blast radius, and a token
// issued for one must never be accepted by the other — hence the `aud` claim.
const BCRYPT_ROUNDS = 12;
const AUDIENCE = 'user';

export const MIN_PASSWORD_LENGTH = 8;

// A valid bcrypt hash of a random value, so a login attempt for an unknown email
// costs the same ~250ms as a real one. A malformed placeholder short-circuits in
// ~0ms and leaks which emails are registered.
const NON_MATCHING_HASH = '$2b$12$Ejr7pQ1kkbnJk0Yl7HHTAOWZ0zsMkbrCPRKt0YQPQxJXhVR4RgKQe';

export interface UserIdentity {
  id: string;
  email: string | null;
  name: string | null;
}

export const hashPassword = (plain: string): Promise<string> =>
  bcrypt.hash(plain, BCRYPT_ROUNDS);

// Returns the member on success, null otherwise. Never distinguishes "no such
// account" from "wrong password" — that difference lets an attacker enumerate
// which emails are registered.
export const verifyCredentials = async (
  email: string,
  password: string,
): Promise<UserIdentity | null> => {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

  const hash = user?.passwordHash ?? NON_MATCHING_HASH;
  const ok = await bcrypt.compare(password, hash);

  // A user created by the WhatsApp bot has no passwordHash and cannot log in
  // until they register — which is correct, nobody has set a password for them.
  if (!user || !user.passwordHash || !ok) {
    logger.warn('Failed member login attempt', { email: email.toLowerCase() });
    return null;
  }

  return { id: user.id, email: user.email, name: user.name };
};

export const issueToken = (user: UserIdentity): string => {
  if (!env.JWT_SECRET) throw new Error('JWT_SECRET is not configured');

  return jwt.sign({ sub: user.id, aud: AUDIENCE }, env.JWT_SECRET, {
    expiresIn: env.JWT_EXPIRES_IN,
  } as jwt.SignOptions);
};

// Verifies the token and re-reads the account, so a deleted user's token stops
// working immediately rather than when it happens to expire.
export const verifyToken = async (token: string): Promise<UserIdentity | null> => {
  if (!env.JWT_SECRET) return null;

  try {
    const payload = jwt.verify(token, env.JWT_SECRET, { audience: AUDIENCE }) as jwt.JwtPayload;
    if (!payload.sub) return null;

    const user = await prisma.user.findUnique({ where: { id: String(payload.sub) } });
    if (!user) return null;

    return { id: user.id, email: user.email, name: user.name };
  } catch {
    return null;
  }
};

export const changePassword = async (
  userId: string,
  currentPassword: string,
  newPassword: string,
): Promise<boolean> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.passwordHash) return false;

  if (!(await bcrypt.compare(currentPassword, user.passwordHash))) {
    logger.warn('Member password change rejected — current password incorrect', { userId });
    return false;
  }

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await hashPassword(newPassword) },
  });

  logger.info('Member password changed', { userId });
  return true;
};
