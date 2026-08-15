import crypto from 'crypto';
import { Prisma } from '@prisma/client';
import { logger } from './logger';

// Deliberately excludes 0/O and 1/I/L: member IDs get read aloud, written down
// and typed back in, and those pairs are the ones people get wrong.
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const LENGTH = 6;
const PREFIX = 'ZCN-';

// 31^6 ≈ 887 million combinations. At 10,000 members a single insert has a
// ~0.001% chance of colliding, but across a lifetime a collision will eventually
// happen — hence the retry below rather than pretending it can't.
export const generateMemberId = (): string => {
  let out = '';
  // randomInt avoids the modulo bias of `randomBytes[i] % 31`, which would make
  // the first 8 letters of the alphabet slightly more likely.
  for (let i = 0; i < LENGTH; i++) out += ALPHABET[crypto.randomInt(0, ALPHABET.length)];
  return PREFIX + out;
};

// Coerce a member ID as a human typed it into the stored form. IDs are read
// aloud and written down, so an admin searching for one arrives with stray
// whitespace, lowercase, or only the six-character code. Normalising here means
// the lookup stays an exact match on the unique index rather than a scan.
export const normalizeMemberId = (input: string): string => {
  const trimmed = input.trim().toUpperCase();
  return trimmed.startsWith(PREFIX) ? trimmed : PREFIX + trimmed;
};

// True only when the unique violation is on member_id. A duplicate email or
// phone number must surface to the caller as a conflict, not be silently retried.
const isMemberIdCollision = (error: unknown): boolean => {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = (error.meta as { target?: string[] | string } | undefined)?.target;
  const fields = Array.isArray(target) ? target.join(',') : String(target ?? '');
  return fields.toLowerCase().includes('member');
};

// Runs `create` with a fresh member ID, retrying only on an ID collision.
//
// Uniqueness is enforced by the database rather than by checking availability
// first: a check-then-insert would be a TOCTOU race, where two concurrent
// registrations both see an ID as free and both try to use it.
export const withMemberId = async <T>(
  create: (memberId: string) => Promise<T>,
  maxAttempts = 5,
): Promise<T> => {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const memberId = generateMemberId();
    try {
      return await create(memberId);
    } catch (error) {
      if (!isMemberIdCollision(error) || attempt === maxAttempts) throw error;
      logger.warn('Member ID collision — retrying', { memberId, attempt });
    }
  }
  // Unreachable: the final attempt either returns or throws.
  throw new Error('Could not allocate a member ID');
};
