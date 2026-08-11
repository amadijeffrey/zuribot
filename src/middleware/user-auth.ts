import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../services/user-auth';

// Guards member-only routes. Distinct from authMiddleware (admins) — the token
// audience means an admin token is rejected here and vice versa.
export const userAuthMiddleware = async (
  req: Request,
  res: Response,
  next: NextFunction,
): Promise<void> => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';

  if (!token) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }

  const user = await verifyToken(token);
  if (!user) {
    res.status(401).json({ error: 'Invalid or expired session' });
    return;
  }

  req.member = user;
  next();
};
