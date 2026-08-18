import { Router } from 'express';
import {
  listPlans,
  register,
  login,
  me,
  updateProfile,
  subscribe,
  changePlan,
  renewSubscription,
  cancelSubscription,
  updatePassword,
  paymentStatus,
} from '../handlers/user.handler';
import { userAuthMiddleware } from '../middleware/user-auth';
import { asyncHandler } from '../middleware/error';
import {
  apiRateLimiter,
  memberLoginRateLimiter,
  registerRateLimiter,
  memberActionRateLimiter,
  memberReadRateLimiter,
} from '../middleware/rate-limit';

const router = Router();

// Every handler here is async; asyncHandler routes a rejection to the error
// middleware instead of letting it terminate the process.
//
// --- public ---
router.post('/register', registerRateLimiter, asyncHandler(register));
// Separate bucket from the admin login limiter — see memberLoginRateLimiter.
router.post('/login', memberLoginRateLimiter, asyncHandler(login));
// Called by the frontend success page with the reference from the Paystack
// redirect, so it cannot require a session.
router.get('/payment-status', apiRateLimiter, asyncHandler(paymentStatus));
// Unauthenticated on purpose, unlike /plans below: the membership-apply form's
// optional plan picker runs before an account (and therefore a session) exists.
// Same handler, same data — just reachable without a token.
router.get('/plans/public', apiRateLimiter, asyncHandler(listPlans));

// --- member session required ---
// Rate limiters run AFTER auth so they can key on the member rather than the IP.
// Plans are behind auth: browsing them is only useful once you can subscribe, and
// each listing runs a capacity check per plan.
router.get('/plans', userAuthMiddleware, memberReadRateLimiter, asyncHandler(listPlans));
router.get('/me', userAuthMiddleware, memberReadRateLimiter, asyncHandler(me));
// Completes the profile info registration deliberately left optional —
// occupation/sector/business/source/whyJoin/goal90. Called from
// membership-activation after the account (and, if a plan was chosen, its
// payment) already exists.
router.patch('/edit', userAuthMiddleware, memberActionRateLimiter, asyncHandler(updateProfile));
// Subscribing is authenticated: the member is identified by their session, never
// by an identifier in the request body.
router.post('/subscribe', userAuthMiddleware, memberActionRateLimiter, asyncHandler(subscribe));
// Pay for another period of the same plan — this is how a member in their grace
// period restores the subscription they already have.
router.post('/subscriptions/:id/renew', userAuthMiddleware, memberActionRateLimiter, asyncHandler(renewSubscription));
// Upgrade or downgrade an existing subscription (plan and/or interval).
router.post('/subscriptions/:id/change', userAuthMiddleware, memberActionRateLimiter, asyncHandler(changePlan));
// Cancel at period end — access continues until expiryDate, Paystack stops
// auto-charging. No immediate-revoke path.
router.post('/subscriptions/:id/cancel', userAuthMiddleware, memberActionRateLimiter, asyncHandler(cancelSubscription));
router.post('/change-password', userAuthMiddleware, memberActionRateLimiter, asyncHandler(updatePassword));

export default router;
