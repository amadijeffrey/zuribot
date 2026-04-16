import { Request, Response } from 'express';
import crypto from 'crypto';
import { env } from '../config/env';
import { prisma } from '../config/database';
import { processWebhookEvent, verifyPayment } from '../services/payment';
import { logger } from '../utils/logger';

export const handlePaystackWebhook = async (req: Request, res: Response): Promise<void> => {
  const signature = req.headers['x-paystack-signature'] as string;

  if (!verifySignature(req.body, signature)) {
    logger.error('Invalid Paystack webhook signature');
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  // Respond quickly to acknowledge receipt
  res.status(200).send('OK');

  try {
    // Log webhook if enabled
    if (env.ENABLE_WEBHOOK_LOGGING) {
      await prisma.webhookLog.create({
        data: {
          source: 'paystack',
          eventType: req.body.event,
          payload: req.body,
          processed: false,
        },
      });
    }

    // Process the webhook event
    await processWebhookEvent(req.body);

    // Mark as processed
    if (env.ENABLE_WEBHOOK_LOGGING) {
      await prisma.webhookLog.updateMany({
        where: {
          source: 'paystack',
          payload: { equals: req.body },
        },
        data: { processed: true },
      });
    }
  } catch (error: any) {
    logger.error('Error processing Paystack webhook', {
      error: error.message,
      event: req.body.event,
    });

    if (env.ENABLE_WEBHOOK_LOGGING) {
      await prisma.webhookLog.updateMany({
        where: {
          source: 'paystack',
          payload: { equals: req.body },
        },
        data: { error: error.message },
      });
    }
  }
};

export const handleVerifyPayment = async (req: Request, res: Response): Promise<void> => {
  const { reference } = req.params;

  try {
    const isValid = await verifyPayment(reference);

    if (isValid) {
      res.json({ success: true, message: 'Payment verified and subscription activated' });
    } else {
      res.json({ success: false, message: 'Payment not successful' });
    }
  } catch (error) {
    logger.error('Payment verification error', { reference, error });
    res.status(500).json({ error: 'Verification failed' });
  }
};

const verifySignature = (body: any, signature: string): boolean => {
  if (!signature) return false;

  const hash = crypto
    .createHmac('sha512', env.PAYSTACK_SECRET_KEY)
    .update(JSON.stringify(body))
    .digest('hex');

  return hash === signature;
};