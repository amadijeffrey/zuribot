import { Router } from 'express';
import { handlePaystackWebhook, handleVerifyPayment } from '../handlers/paystack.handler';
import { webhookRateLimiter } from '../middleware/rate-limit';
import { authMiddleware } from '../middleware/auth';
import { asyncHandler } from '../middleware/error';

const router = Router();

// Paystack webhook endpoint. The handler swallows its own processing errors so
// Paystack always gets a 200, but the surrounding database writes (webhook log,
// replay lookup) can still reject — asyncHandler keeps that from killing the
// process mid-charge.
router.post('/paystack/webhook', webhookRateLimiter, asyncHandler(handlePaystackWebhook));

// Manual payment verification — state-changing (creates Subscription via
// handleInitialPayment), so require admin auth instead of leaving it open.
router.get('/payment/verify/:reference', authMiddleware, asyncHandler(handleVerifyPayment));

export default router;