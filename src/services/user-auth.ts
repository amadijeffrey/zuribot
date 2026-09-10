import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { prisma } from '../config/database';
import { env, isLocal } from '../config/env';
import { logger } from '../utils/logger';
import { sendPasswordResetEmail } from './email';

// Member (subscriber) authentication. Deliberately separate from admin auth:
// the two have different lifetimes, audiences and blast radius, and a token
// issued for one must never be accepted by the other — hence the `aud` claim.
const BCRYPT_ROUNDS = 12;
const AUDIENCE = 'user';

export const MIN_PASSWORD_LENGTH = 8;

const PASSWORD_RESET_TOKEN_BYTES = 32;
const PASSWORD_RESET_EXPIRY_MS = 5 * 60 * 1000;

const hashResetToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');

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

// Starts a reset: emails a link if, and only if, `email` belongs to an
// account that can actually log in (a WhatsApp-bot-only user has no
// passwordHash to reset). Never signals which case applied — same
// enumeration-safety principle as verifyCredentials, including timing: the
// not-found path awaits a comparable-cost dummy compare so response time
// alone can't reveal whether an email is registered.
export const createPasswordResetToken = async (email: string): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { email: email.toLowerCase() } });

  if (!user || !user.passwordHash) {
    await bcrypt.compare('reset-token-timing-equalizer', NON_MATCHING_HASH);
    logger.info('Password reset requested for unknown or password-less account', {
      email: email.toLowerCase(),
    });
    return;
  }

  const token = crypto.randomBytes(PASSWORD_RESET_TOKEN_BYTES).toString('hex');
  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordResetTokenHash: hashResetToken(token),
      passwordResetExpiresAt: new Date(Date.now() + PASSWORD_RESET_EXPIRY_MS),
    },
  });

  // Only place the raw token is ever visible outside the email itself — gated
  // on isLocal (not just log level) since a debug log can still reach a
  // shipped aggregator, and this token is a bearer credential.
  if (isLocal) {
    logger.debug('Password reset token generated', { userId: user.id, token });
  }

  await sendPasswordResetEmail(user.id, token);
  logger.info('Password reset requested', { userId: user.id });
};

// Redeems a reset token: valid only while unexpired and unused (both fields
// are cleared here, so a second attempt with the same token always fails).
export const resetPasswordWithToken = async (
  token: string,
  newPassword: string,
): Promise<boolean> => {
  const user = await prisma.user.findFirst({
    where: {
      passwordResetTokenHash: hashResetToken(token),
      passwordResetExpiresAt: { gt: new Date() },
    },
  });

  if (!user) {
    logger.warn('Password reset rejected — token invalid or expired');
    return false;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: {
      passwordHash: await hashPassword(newPassword),
      passwordResetTokenHash: null,
      passwordResetExpiresAt: null,
    },
  });

  logger.info('Password reset completed', { userId: user.id });
  return true;
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
