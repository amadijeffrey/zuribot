import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export const authMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const apiKey = req.headers['x-api-key'] as string;

  if (!apiKey) {
    res.status(401).json({ error: 'API key required' });
    return;
  }

  if (apiKey !== env.ADMIN_API_KEY) {
    logger.warn('Invalid admin API key attempt', { ip: req.ip, path: req.path });
    res.status(403).json({ error: 'Invalid API key' });
    return;
  }

  next();
};