import { Router } from 'express';
import {
  listPlans,
  register,
  login,
  me,
  subscribe,
  changePlan,
  renewSubscription,
  updatePassword,
  paymentStatus,
} from '../handlers/user.handler';
import { userAuthMiddleware } from '../middleware/user-auth';
import {
  apiRateLimiter,
  loginRateLimiter,
  registerRateLimiter,
  memberActionRateLimiter,
  memberReadRateLimiter,
} from '../middleware/rate-limit';

const router = Router();

// --- public ---
router.post('/register', registerRateLimiter, register);
// Stricter limit: this endpoint guards every member account.
router.post('/login', loginRateLimiter, login);
// Called by the frontend success page with the reference from the Paystack
// redirect, so it cannot require a session.
router.get('/payment-status', apiRateLimiter, paymentStatus);

// --- member session required ---
// Rate limiters run AFTER auth so they can key on the member rather than the IP.
// Plans are behind auth: browsing them is only useful once you can subscribe, and
// each listing runs a capacity check per plan.
router.get('/plans', userAuthMiddleware, memberReadRateLimiter, listPlans);
router.get('/me', userAuthMiddleware, memberReadRateLimiter, me);
// Subscribing is authenticated: the member is identified by their session, never
// by an identifier in the request body.
router.post('/subscribe', userAuthMiddleware, memberActionRateLimiter, subscribe);
// Pay for another period of the same plan — this is how a member in their grace
// period restores the subscription they already have.
router.post('/subscriptions/:id/renew', userAuthMiddleware, memberActionRateLimiter, renewSubscription);
// Upgrade or downgrade an existing subscription (plan and/or interval).
router.post('/subscriptions/:id/change', userAuthMiddleware, memberActionRateLimiter, changePlan);
router.post('/change-password', userAuthMiddleware, memberActionRateLimiter, updatePassword);

export default router;
