import { Router } from 'express';
import { isLocal } from '../config/env';
import * as adminHandler from '../handlers/admin.handler';
import * as adminAuthHandler from '../handlers/admin-auth.handler';
import { authMiddleware } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';
import { adminRateLimiter, loginRateLimiter } from '../middleware/rate-limit';

const router = Router();

// Every handler below is async and talks to the database, so each is wrapped in
// asyncHandler — an unwrapped rejection is invisible to Express and terminates
// the process rather than returning a 500.

// Rate limit ahead of authentication, so unauthenticated traffic is bounded too.
// Mounted after authMiddleware (as it was before) this only ever counted
// requests that had already presented a valid session, leaving anyone free to
// hammer the admin surface with rejected ones. Per-IP now that trust proxy is
// set, so one source burning its allowance cannot lock out a real admin
// elsewhere.
router.use(adminRateLimiter);

// Login is the one public admin route — it must sit above authMiddleware,
// otherwise there'd be no way to obtain a session in the first place. Its own
// stricter limiter nests inside the router-wide one.
router.post('/auth/login', loginRateLimiter, asyncHandler(adminAuthHandler.login));

// Everything below requires a session (or the legacy shared key).
router.use(authMiddleware);

router.get('/auth/me', asyncHandler(adminAuthHandler.me));
router.post('/auth/change-password', asyncHandler(adminAuthHandler.updatePassword));

// Users
router.get('/users', asyncHandler(adminHandler.getUsers));
router.get('/users/:id', asyncHandler(adminHandler.getUser));
router.post('/users/:id/resend-link', asyncHandler(adminHandler.resendGroupLink));
router.post('/users/:id/send-message', asyncHandler(adminHandler.sendMessageToUser));

// Subscriptions
router.get('/subscriptions', asyncHandler(adminHandler.getSubscriptionsHandler));
router.post('/subscriptions/run-sweep', asyncHandler(adminHandler.runSweep));
router.post('/subscriptions/:id/extend', asyncHandler(adminHandler.extendSubscription));
// Test tooling: mutates real subscription state, so it exists only on a local
// machine. Guarded here rather than inside the handler so the route simply does
// not exist anywhere else.
//
// Keyed on APP_ENV rather than NODE_ENV: the docker dev stack runs
// NODE_ENV=production, so this route used to be missing locally, and a staging
// box running NODE_ENV=development would have exposed it on the internet.
if (isLocal) {
  router.post(
    '/subscriptions/:id/simulate-payment-failed',
    asyncHandler(adminHandler.simulatePaymentFailed),
  );
}

// Payments
// Filters via query string — ?status, ?hours, ?order, ?page, ?limit.
router.get('/payments', asyncHandler(adminHandler.getPayments));

// Plans
router.get('/plans', asyncHandler(adminHandler.getPlans));
router.get('/plans/verify', asyncHandler(adminHandler.verifyPlans));

// Manual WhatsApp group removals (WhatsApp's API can't do this for us)
router.get('/removals', asyncHandler(adminHandler.pendingRemovals));
router.post('/removals/:id/confirm', asyncHandler(adminHandler.confirmRemoval));

// Pull state from Paystack rather than waiting on webhooks
router.post('/reconcile', asyncHandler(adminHandler.reconcile));

// Stats & Broadcast
router.get('/stats', asyncHandler(adminHandler.getStats));
router.post('/broadcast', asyncHandler(adminHandler.broadcast));

export default router;