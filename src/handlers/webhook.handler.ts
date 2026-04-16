import { Request, Response } from 'express';
import crypto from 'crypto';
import { env } from '../config/env';
import { prisma } from '../config/database';
import { messageQueue } from '../jobs/queue';
import { logger } from '../utils/logger';
import { updateMessageStatus } from '../services/message';

export const verifyWebhook = (req: Request, res: Response): void => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  logger.info('Webhook verification attempt', { mode, tokenReceived: !!token });

  if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN) {
    logger.info('Webhook verified successfully');
    res.status(200).send(challenge);
    return;
  }

  logger.warn('Webhook verification failed');
  res.status(403).send('Forbidden');
};

export const handleWebhook = async (req: Request, res: Response): Promise<void> => {
  // IMPORTANT: Always respond with 200 quickly to prevent webhook retries
  res.status(200).send('EVENT_RECEIVED');

  try {
    // Verify request signature
    if (!verifySignature(req)) {
      logger.error('Invalid webhook signature');
      return;
    }

    const body = req.body;

    // Log webhook if enabled
    if (env.ENABLE_WEBHOOK_LOGGING) {
      await prisma.webhookLog.create({
        data: {
          source: 'whatsapp',
          eventType: body.entry?.[0]?.changes?.[0]?.field || 'unknown',
          payload: body,
          processed: false,
        },
      });
    }

    // Check if this is a WhatsApp message webhook
    if (body.object !== 'whatsapp_business_account') {
      logger.warn('Unknown webhook object type', { object: body.object });
      return;
    }

    // Process entries
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;

        const value = change.value;
        const contacts = value.contacts || [];
        const messages = value.messages || [];
        const statuses = value.statuses || [];

        // Process incoming messages - queue for async processing
        for (const message of messages) {
          const contact = contacts.find((c: any) => c.wa_id === message.from);

          await messageQueue.add('process-message', {
            message,
            contact,
            timestamp: new Date().toISOString(),
          }, {
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
          });

          logger.info('Message queued for processing', {
            messageId: message.id,
            from: message.from,
            type: message.type,
          });
        }

        // Process status updates (sent, delivered, read)
        for (const status of statuses) {
          await updateMessageStatus(status.id, status.status);
        }
      }
    }
  } catch (error) {
    logger.error('Error processing webhook', { error });
  }
};

const verifySignature = (req: Request): boolean => {
  const signature = req.headers['x-hub-signature-256'] as string;

  if (!signature) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', env.WHATSAPP_APP_SECRET)
    .update(JSON.stringify(req.body))
    .digest('hex');

  const expectedHeader = `sha256=${expectedSignature}`;

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedHeader)
    );
  } catch {
    return false;
  }
};