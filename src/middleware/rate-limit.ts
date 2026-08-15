import rateLimit, { Options } from 'express-rate-limit';
import { Request } from 'express';
import { env } from '../config/env';
import { logger } from '../utils/logger';

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

// Skips rate limiting for local development. Two independent conditions,
// because the two dev flows look completely different to this process:
//
//   • `npm run dev` runs it directly on the host — a request from your machine
//     genuinely arrives from a loopback address, and NODE_ENV is 'development'.
//   • `./scripts/dev.sh` runs the docker stack, where NODE_ENV is 'production'
//     (inherited from docker-compose.yml) and Docker rewrites the source address
//     to the bridge gateway, so the container never sees 127.0.0.1. Nothing about
//     the request identifies it as local — only an explicit flag can.
//
// The loopback branch is gated on NODE_ENV so it cannot fire in production. That
// matters: `trust proxy` makes req.ip come from X-Forwarded-For, and without the
// gate anyone able to reach the app directly on the Docker network could send
// `X-Forwarded-For: 127.0.0.1` and bypass every limit on the service.
const skipLocal = (req: Request): boolean => {
  if (env.DISABLE_RATE_LIMIT) return true;
  return env.NODE_ENV !== 'production' && LOOPBACK.has(req.ip ?? '');
};

if (env.DISABLE_RATE_LIMIT) {
  logger.warn(
    'DISABLE_RATE_LIMIT is set — ALL rate limiting is off, including admin and member login. Intended for local development only.',
  );
}

// Applied through this wrapper rather than added to each limiter by hand, so a
// limiter added later cannot silently miss the skip.
const limiter = (options: Partial<Options>) => rateLimit({ ...options, skip: skipLocal });

export const apiRateLimiter = limiter({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const webhookRateLimiter = limiter({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 1000,
  message: { error: 'Rate limit exceeded' },
});

// Deliberately strict: this endpoint guards every destructive admin operation,
// so brute-force resistance matters more than convenience for a single operator.
export const loginRateLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Members get their own bucket rather than sharing the admin one: each
// rateLimit() call owns a private store, so a single shared instance would let
// failed member logins consume the admin allowance and vice versa.
//
// Also more generous than the admin limit, because members are many and sit
// behind shared egress IPs — office NAT, and mobile carriers that put large
// numbers of subscribers behind one address. A limit sized for one operator
// would lock out unrelated members on the same IP. Only failures count, so 30
// bad passwords per 15 minutes is far too slow to brute-force a bcrypt hash
// while leaving room for people who simply mistype.
export const memberLoginRateLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 30,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Registration runs bcrypt at 12 rounds (~300ms of CPU each), so the generic
// API limit would allow a single IP to burn ~30s of CPU per window.
export const registerRateLimiter = limiter({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: { error: 'Too many registration attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// For authenticated actions that cost money or CPU: starting a payment, changing
// a plan, changing a password. Keyed by member id where available so one abusive
// account can't be masked by rotating IPs — and so shared IPs (offices, mobile
// carriers) don't throttle unrelated members.
export const memberActionRateLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req: any) => req.member?.id ?? req.ip,
  message: { error: 'Too many attempts, please try again shortly' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Ordinary authenticated reads.
export const memberReadRateLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 120,
  keyGenerator: (req: any) => req.member?.id ?? req.ip,
  message: { error: 'Too many requests, please try again shortly' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const adminRateLimiter = limiter({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Admin rate limit exceeded' },
});