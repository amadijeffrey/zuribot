import { Router } from 'express';
import { verifyWebhook, handleWebhook } from '../handlers/webhook.handler';
import { webhookRateLimiter } from '../middleware/rate-limit';

const router = Router();

// Apply rate limiter to webhooks
router.use(webhookRateLimiter);

// Webhook verification (GET) - Meta verifies this endpoint
router.get('/webhook', verifyWebhook);

// Webhook handler (POST) - Receives messages and events
router.post('/webhook', handleWebhook);

export default router;