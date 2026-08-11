import { Router } from 'express';
import { env } from '../config/env';
import * as adminHandler from '../handlers/admin.handler';
import * as adminAuthHandler from '../handlers/admin-auth.handler';
import { authMiddleware } from '../middleware/auth';
import { adminRateLimiter, loginRateLimiter } from '../middleware/rate-limit';

const router = Router();

// Login is the one public admin route — it must sit above authMiddleware,
// otherwise there'd be no way to obtain a session in the first place.
router.post('/auth/login', loginRateLimiter, adminAuthHandler.login);

// Everything below requires a session (or the legacy shared key).
router.use(authMiddleware);
router.use(adminRateLimiter);

router.get('/auth/me', adminAuthHandler.me);
router.post('/auth/change-password', adminAuthHandler.updatePassword);

// Users
router.get('/users', adminHandler.getUsers);
router.get('/users/:id', adminHandler.getUser);
router.post('/users/:id/resend-link', adminHandler.resendGroupLink);
router.post('/users/:id/send-message', adminHandler.sendMessageToUser);

// Subscriptions
router.get('/subscriptions', adminHandler.getSubscriptionsHandler);
router.post('/subscriptions/run-sweep', adminHandler.runSweep);
router.post('/subscriptions/:id/extend', adminHandler.extendSubscription);
// Test tooling: mutates real subscription state, so it is never mounted in
// production. Guarded here rather than inside the handler so the route simply
// does not exist there.
if (env.NODE_ENV !== 'production') {
  router.post('/subscriptions/:id/simulate-payment-failed', adminHandler.simulatePaymentFailed);
}

// Payments
router.get('/payments', adminHandler.getPayments);

// Plans
router.get('/plans', adminHandler.getPlans);
router.get('/plans/verify', adminHandler.verifyPlans);

// Manual WhatsApp group removals (WhatsApp's API can't do this for us)
router.get('/removals', adminHandler.pendingRemovals);
router.post('/removals/:id/confirm', adminHandler.confirmRemoval);

// Pull state from Paystack rather than waiting on webhooks
router.post('/reconcile', adminHandler.reconcile);

// Stats & Broadcast
router.get('/stats', adminHandler.getStats);
router.post('/broadcast', adminHandler.broadcast);

export default router;