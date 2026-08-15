import { Router } from 'express';
import { verifyWebhook, handleWebhook } from '../handlers/webhook.handler';
import { webhookRateLimiter } from '../middleware/rate-limit';
import { asyncHandler } from '../middleware/error';

const router = Router();

// Apply rate limiter to webhooks
router.use(webhookRateLimiter);

// Webhook verification (GET) - Meta verifies this endpoint. Synchronous, so
// Express already routes any throw to the error handler.
router.get('/webhook', verifyWebhook);

// Webhook handler (POST) - Receives messages and events
router.post('/webhook', asyncHandler(handleWebhook));

export default router;