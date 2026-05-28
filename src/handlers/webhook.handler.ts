import { Request, Response } from 'express';
import crypto from 'crypto';
import { env } from '../config/env';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { processMessage, updateMessageStatus } from '../services/message';

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
  const signatureValid = verifySignature(req);
  const body = req.body;

  // Persist the inbound event up front as an audit trail / replay source.
  const log = env.ENABLE_WEBHOOK_LOGGING
    ? await prisma.webhookLog.create({
        data: {
          source: 'whatsapp',
          eventType: body?.entry?.[0]?.changes?.[0]?.field || 'unknown',
          payload: body,
          processed: false,
          error: signatureValid ? null : 'signature_invalid',
        },
      })
    : null;

  // Invalid signature and unknown object type are permanent conditions — a
  // retry would always fail the same way. Ack with 200 so WhatsApp stops
  // resending, and drop (the event is already logged above).
  if (!signatureValid) {
    logger.error('Invalid webhook signature', { webhookLogId: log?.id });
    res.status(200).send('EVENT_RECEIVED');
    return;
  }

  if (body.object !== 'whatsapp_business_account') {
    logger.warn('Unknown webhook object type', { object: body.object });
    res.status(200).send('EVENT_RECEIVED');
    return;
  }

  // ACK-AFTER: process synchronously, then ack. If anything throws we return
  // 500 so WhatsApp retries the whole payload. The message.id dedup guard in
  // processMessage makes the replay safe — already-processed messages are
  // skipped, only the failed one re-runs.
  try {
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;

        const value = change.value;
        const contacts = value.contacts || [];
        const messages = value.messages || [];
        const statuses = value.statuses || [];

        for (const message of messages) {
          const contact = contacts.find((c: any) => c.wa_id === message.from);
          await processMessage({ message, contact });
        }

        // Status updates (sent, delivered, read) — idempotent updateMany.
        for (const status of statuses) {
          await updateMessageStatus(status.id, status.status);
        }
      }
    }

    if (log) {
      await prisma.webhookLog.update({
        where: { id: log.id },
        data: { processed: true },
      });
    }

    res.status(200).send('EVENT_RECEIVED');
  } catch (error: any) {
    logger.error('Error processing webhook — returning 500 for WhatsApp retry', {
      error,
      webhookLogId: log?.id,
    });
    if (log) {
      await prisma.webhookLog.update({
        where: { id: log.id },
        data: { error: error?.message || 'unknown' },
      });
    }
    res.status(500).send('PROCESSING_FAILED');
  }
};

const verifySignature = (req: Request): boolean => {
  const signature = req.headers['x-hub-signature-256'] as string;

  if (!signature || !req.rawBody) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', env.WHATSAPP_APP_SECRET)
    .update(req.rawBody)
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