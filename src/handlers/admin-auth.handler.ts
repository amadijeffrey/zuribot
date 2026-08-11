import { Request, Response } from 'express';
import { z } from 'zod';
import { env } from '../config/env';
import {
  verifyCredentials,
  issueToken,
  changePassword,
  MIN_PASSWORD_LENGTH,
} from '../services/admin-auth';
import { logger } from '../utils/logger';

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`),
});

// POST /api/admin/auth/login — public (rate limited). Returns a short-lived JWT.
//
// The dashboard should keep this token server-side (a Next.js route handler +
// httpOnly cookie) and proxy admin calls, rather than holding it in browser JS
// where XSS can read it.
export const login = async (req: Request, res: Response): Promise<void> => {
  if (!env.JWT_SECRET) {
    logger.error('Admin login attempted but JWT_SECRET is not configured');
    res.status(503).json({ error: 'Login is not configured' });
    return;
  }

  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  const admin = await verifyCredentials(parsed.data.email, parsed.data.password);
  if (!admin) {
    // Same response for unknown account, wrong password, and deactivated admin.
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  logger.info('Admin logged in', { adminId: admin.id, email: admin.email });
  res.json({
    token: issueToken(admin),
    expiresIn: env.JWT_EXPIRES_IN,
    admin: { id: admin.id, email: admin.email, name: admin.name },
  });
};

// GET /api/admin/auth/me — who the current session belongs to.
export const me = async (req: Request, res: Response): Promise<void> => {
  if (!req.admin) {
    // Authenticated via the legacy shared key, which carries no identity.
    res.json({ admin: null, authMethod: 'api-key' });
    return;
  }
  res.json({ admin: req.admin, authMethod: 'session' });
};

// POST /api/admin/auth/change-password — session only, so the shared key can't
// be used to take over an admin account.
export const updatePassword = async (req: Request, res: Response): Promise<void> => {
  if (!req.admin) {
    res.status(403).json({ error: 'A logged-in admin session is required' });
    return;
  }

  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Validation failed',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const ok = await changePassword(
    req.admin.id,
    parsed.data.currentPassword,
    parsed.data.newPassword,
  );

  if (!ok) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }

  res.json({ success: true, message: 'Password updated' });
};
