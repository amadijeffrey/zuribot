import { Request, Response } from 'express';
import crypto from 'crypto';
import { env } from '../config/env';
import { prisma } from '../config/database';
import { processWebhookEvent, verifyPayment, getSubscriptionManageLink } from '../services/payment';
import { logger } from '../utils/logger';

// Paystack sends no event ID, so a replay is only detectable by fingerprinting
// the payload. Hashing the raw bytes would make every retry look distinct if
// Paystack re-serialises, so the key is built from the fields that identify the
// event itself.
const eventKey = (body: any): string | null => {
  const d = body?.data;
  if (!body?.event || !d) return null;

  const identity = [
    body.event,
    d.id ?? d.reference ?? d.invoice_code ?? d.subscription_code ?? '',
    d.status ?? '',
    d.paid_at ?? d.updatedAt ?? '',
  ].join('|');

  return crypto.createHash('sha256').update(identity).digest('hex');
};

export const handlePaystackWebhook = async (req: Request, res: Response): Promise<void> => {
  const signature = req.headers['x-paystack-signature'] as string;
  const signatureValid = verifySignature(req, signature);

  // Persist the inbound event BEFORE acking and BEFORE returning on bad
  // signature, so we always have an audit trail / replay source — even
  // for events we reject (a real Paystack outage + signature mismatch
  // would otherwise vanish silently, as happened during the prior bug).
  const key = eventKey(req.body);

  // Replay guard. Handlers are individually idempotent, so a replay cannot
  // double-charge — but every alert path would fire again, and an attacker
  // replaying one captured payload could bury real alerts under duplicates.
  if (signatureValid && key) {
    const seen = await prisma.webhookLog.findUnique({ where: { eventKey: key } });
    if (seen?.processed) {
      logger.info('Duplicate Paystack webhook ignored', {
        event: req.body?.event,
        originalLogId: seen.id,
      });
      res.status(200).send('OK');
      return;
    }
  }

  let log = null;
  let duplicate = false;

  if (env.ENABLE_WEBHOOK_LOGGING) {
    try {
      log = await prisma.webhookLog.create({
        data: {
          source: 'paystack',
          eventType: req.body?.event ?? 'unknown',
          eventKey: key,
          payload: req.body,
          processed: false,
          error: signatureValid ? null : 'signature_invalid',
        },
      });
    } catch (error: any) {
      // Two deliveries of the same event can both pass the check above before
      // either has been recorded. The unique index settles the race; the loser
      // must NOT process, or both would run and both would alert.
      if (error?.code === 'P2002') duplicate = true;
      else throw error;
    }
  }

  if (duplicate) {
    logger.info('Concurrent duplicate Paystack webhook ignored', { event: req.body?.event });
    res.status(200).send('OK');
    return;
  }

  if (!signatureValid) {
    logger.error('Invalid Paystack webhook signature', { webhookLogId: log?.id });
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  // Process BEFORE responding. On serverless platforms (Vercel) the function
  // is frozen/terminated once the response is flushed, so any async work kicked
  // off after res.send() may never run — which previously left the webhook
  // logged but the subscription never created. Paystack's delivery timeout is
  // generous enough to await the work here.
  try {
    await processWebhookEvent(req.body);

    if (log) {
      await prisma.webhookLog.update({
        where: { id: log.id },
        data: { processed: true },
      });
    }
  } catch (error: any) {
    logger.error('Error processing Paystack webhook', {
      error: error.message,
      event: req.body?.event,
      webhookLogId: log?.id,
    });

    if (log) {
      await prisma.webhookLog.update({
        where: { id: log.id },
        data: { error: error.message },
      });
    }
  }

  res.status(200).send('OK');
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

const verifySignature = (req: Request, signature: string): boolean => {
  if (!signature || !req.rawBody) return false;

  const hash = crypto
    .createHmac('sha512', env.PAYSTACK_SECRET_KEY)
    .update(req.rawBody)
    .digest('hex');

  return hash === signature;
};
// GET /paystack/manage/:subscriptionCode/:emailToken
//
// Redirects a member to Paystack's hosted page for replacing the card bound to
// their subscription. Linked from the grace-period email.
//
// Unauthenticated on purpose. Paystack's manage link carries a token that
// expires in ~24 hours, but the grace period runs for GRACE_PERIOD_DAYS — so
// embedding a link directly in the email means anyone opening it a day later
// gets a dead page, precisely while we still want them to fix their billing.
// Minting at click time removes that.
//
// `emailToken` is the per-subscription secret Paystack itself uses to authorize
// that page — it is what Paystack puts in its own customer emails — so requiring
// it here is the same trust model, not a weaker one. Matching it against the
// stored value means the URL cannot be walked by guessing subscription codes.
//
// Deliberately not behind a session: this is an email CTA aimed at someone whose
// billing is already failing, and a login wall between them and the fix costs
// exactly the conversions we are trying to save.
export const handleManageSubscription = async (req: Request, res: Response): Promise<void> => {
  const { subscriptionCode, emailToken } = req.params;

  const subscription = await prisma.subscription.findUnique({
    where: { paystackSubscriptionCode: subscriptionCode },
    select: { id: true, paystackEmailToken: true },
  });

  // Same response for unknown subscription and wrong token, so this cannot be
  // used to discover which subscription codes exist.
  if (!subscription || !subscription.paystackEmailToken || subscription.paystackEmailToken !== emailToken) {
    logger.warn('Invalid manage-subscription link', { subscriptionCode });
    res.status(404).json({ error: 'This link is no longer valid. Please log in to manage your subscription.' });
    return;
  }

  const link = await getSubscriptionManageLink(subscriptionCode);

  if (!link) {
    logger.error('Could not mint manage link for a valid subscription', {
      subscriptionId: subscription.id,
      subscriptionCode,
    });
    res.status(502).json({ error: 'Could not reach the payment provider. Please try again shortly.' });
    return;
  }

  res.redirect(302, link);
};
