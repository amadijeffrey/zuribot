import { Router } from 'express';
import { handlePaystackWebhook, handleVerifyPayment } from '../handlers/paystack.handler';
import { webhookRateLimiter } from '../middleware/rate-limit';

const router = Router();

// Paystack webhook endpoint
router.post('/paystack/webhook', webhookRateLimiter, handlePaystackWebhook);

// Manual payment verification endpoint
router.get('/payment/verify/:reference', handleVerifyPayment);

export default router;