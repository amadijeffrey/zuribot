import rateLimit from 'express-rate-limit';

export const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const webhookRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 1000,
  message: { error: 'Rate limit exceeded' },
});

// Deliberately strict: this endpoint guards every destructive admin operation,
// so brute-force resistance matters more than convenience for a single operator.
export const loginRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Registration runs bcrypt at 12 rounds (~300ms of CPU each), so the generic
// API limit would allow a single IP to burn ~30s of CPU per window.
export const registerRateLimiter = rateLimit({
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
export const memberActionRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  keyGenerator: (req: any) => req.member?.id ?? req.ip,
  message: { error: 'Too many attempts, please try again shortly' },
  standardHeaders: true,
  legacyHeaders: false,
});

// Ordinary authenticated reads.
export const memberReadRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 120,
  keyGenerator: (req: any) => req.member?.id ?? req.ip,
  message: { error: 'Too many requests, please try again shortly' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const adminRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Admin rate limit exceeded' },
});