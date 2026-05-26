import { Router } from 'express';
import { handlePaystackWebhook, handleVerifyPayment } from '../handlers/paystack.handler';
import { webhookRateLimiter } from '../middleware/rate-limit';
import { authMiddleware } from '../middleware/auth';

const router = Router();

// Paystack webhook endpoint
router.post('/paystack/webhook', webhookRateLimiter, handlePaystackWebhook);

// Manual payment verification — state-changing (creates Subscription via
// handleInitialPayment), so require admin auth instead of leaving it open.
router.get('/payment/verify/:reference', authMiddleware, handleVerifyPayment);

export default router;