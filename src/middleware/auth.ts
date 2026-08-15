import { Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { env } from '../config/env';
import { verifyToken } from '../services/admin-auth';
import { asyncHandler } from './error';
import { setRequestActor } from '../utils/request-context';
import { logger } from '../utils/logger';

// Accepts either:
//   1. `Authorization: Bearer <jwt>`  — dashboard login, identifies a real Admin
//   2. `x-api-key: <ADMIN_API_KEY>`   — legacy shared key, no identity
//
// The key path is kept so existing tooling/scripts keep working during the
// migration. It grants the same access with no attribution, so remove it once
// the dashboard is the only consumer.
// Wrapped at the definition rather than at each of its ~20 mount points: it
// awaits a database read, so an unwrapped rejection here would crash the process
// on any transient DB error — and one forgotten wrap would reintroduce that.
export const authMiddleware = asyncHandler(async (
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (token) {
    const admin = await verifyToken(token);
    if (!admin) {
      res.status(401).json({ error: 'Invalid or expired session' });
      return;
    }
    req.admin = admin;
    setRequestActor(`admin:${admin.id}`);
    next();
    return;
  }

  const apiKey = req.headers['x-api-key'] as string;

  if (!apiKey) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  if (!timingSafeEqual(apiKey, env.ADMIN_API_KEY)) {
    logger.warn('Invalid admin API key attempt', { ip: req.ip, path: req.path });
    res.status(403).json({ error: 'Invalid API key' });
    return;
  }

  setRequestActor('admin:legacy-shared-key');
  logger.warn('Admin request authenticated with legacy shared key (no identity)', {
    path: req.path,
  });
  next();
});

const timingSafeEqual = (a: string, b: string): boolean => {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
};
