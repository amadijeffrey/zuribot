import { Request, Response, NextFunction } from 'express';
import { verifyToken } from '../services/user-auth';
import { asyncHandler } from './error';
import { setRequestActor } from '../utils/request-context';

// Guards member-only routes. Distinct from authMiddleware (admins) — the token
// audience means an admin token is rejected here and vice versa.
//
// Wrapped at the definition for the same reason as authMiddleware: it awaits a
// database read on every request it guards.
export const userAuthMiddleware = asyncHandler(async (
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
  // From here on every line logged for this request identifies the member,
  // including lines emitted by services that never see the request object.
  setRequestActor(`member:${user.id}`);
  next();
});
