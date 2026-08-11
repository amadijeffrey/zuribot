import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { env } from '../config/env';
import { logger } from '../utils/logger';

// Guards the scheduled-sweep route. The endpoint mutates subscription state and
// sends notifications, so it must never be publicly triggerable.
//
// Vercel Cron sends `Authorization: Bearer $CRON_SECRET` automatically when the
// CRON_SECRET env var is set on the project. Any external scheduler can do the same.
export const cronAuthMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  // Fail closed: with no secret configured there is no way to authenticate, so
  // the route stays shut rather than open.
  if (!env.CRON_SECRET) {
    logger.error('CRON_SECRET not configured — refusing cron request', { path: req.path });
    res.status(503).json({ error: 'Cron endpoint not configured' });
    return;
  }

  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token || !timingSafeEqual(token, env.CRON_SECRET)) {
    logger.warn('Invalid cron secret attempt', { ip: req.ip, path: req.path });
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  next();
};

const timingSafeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  // timingSafeEqual throws on length mismatch, so compare lengths first. Length
  // is not the secret; the value is.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};
