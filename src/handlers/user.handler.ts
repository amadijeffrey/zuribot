import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../config/database';
import { SUBSCRIPTION_PLANS } from '../config/constants';
import { initializePayment, verifyPayment } from '../services/payment';
import { getSubscriptionForPlan } from '../services/subscription';
import { logger } from '../utils/logger';

const PLAN_IDS = Object.keys(SUBSCRIPTION_PLANS);

// GET /plans — public plan catalogue for the frontend's plan picker. Fields are
// picked explicitly so gated data (inviteLink, keywords) never leaks. `id` is
// the value the frontend passes back as `planId` when calling /users/register.
export const listPlans = async (_req: Request, res: Response): Promise<void> => {
  const plans = Object.values(SUBSCRIPTION_PLANS).map((plan) => ({
    id: plan.id,
    name: plan.name,
    amount: plan.amount,
    description: plan.description,
  }));

  res.json({ plans });
};

const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  email: z.string().trim().toLowerCase().email('A valid email is required'),
  // E.164-ish: optional leading +, 7–15 digits, no leading zero.
  phoneNumber: z
    .string()
    .trim()
    .regex(/^\+?[1-9]\d{6,14}$/, 'A valid phone number is required'),
  planId: z
    .string()
    .refine((id) => PLAN_IDS.includes(id), { message: `planId must be one of: ${PLAN_IDS.join(', ')}` }),
});

// POST /users/register — web registration. Creates/updates the user, then
// returns a Paystack payment link. No password (auth is out of scope) and no
// WhatsApp messaging: post-payment delivery goes through email + the frontend
// redirect (see registrationStatus).
export const register = async (req: Request, res: Response): Promise<void> => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Validation failed',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const { name, email, phoneNumber, planId } = parsed.data;

  try {
    // phoneNumber is the unique identity; a user may already exist (e.g. from
    // the bot). Upsert so we attach/refresh their name + email either way.
    const user = await prisma.user.upsert({
      where: { phoneNumber },
      update: { name, email },
      create: { phoneNumber, name, email },
    });

    // Don't let someone double-pay for a plan they already hold.
    const existing = await getSubscriptionForPlan(user.id, planId);
    if (existing) {
      res.status(409).json({
        error: 'You already have an active subscription for this plan',
      });
      return;
    }

    const payment = await initializePayment({
      userId: user.id,
      planId,
      email,
      channel: 'WEB',
    });

    res.status(201).json({
      reference: payment.reference,
      authorizationUrl: payment.authorizationUrl,
    });
  } catch (error: any) {
    logger.error('Registration failed', { error: error.message, phoneNumber, planId });
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
};

// GET /users/registration-status?reference=... — called by the frontend success
// page. Verifies the payment on demand (so it works even if the Paystack webhook
// is delayed) and returns the invite link once the subscription is active.
export const registrationStatus = async (req: Request, res: Response): Promise<void> => {
  const reference = String(req.query.reference || '').trim();
  if (!reference) {
    res.status(400).json({ error: 'reference query parameter is required' });
    return;
  }

  try {
    let payment = await prisma.payment.findUnique({ where: { reference } });
    if (!payment) {
      res.status(404).json({ error: 'Payment not found' });
      return;
    }

    // Verify-on-demand: if the webhook hasn't landed yet, confirm with Paystack
    // ourselves. verifyPayment activates the subscription (idempotently) on success.
    if (payment.status === 'PENDING') {
      await verifyPayment(reference);
      payment = await prisma.payment.findUnique({ where: { reference } });
    }

    if (!payment || payment.status === 'PENDING') {
      res.json({ status: 'pending' });
      return;
    }

    if (payment.status === 'FAILED') {
      res.json({ status: 'failed' });
      return;
    }

    // SUCCESS — resolve the subscription this payment activated.
    const subscription = payment.subscriptionId
      ? await prisma.subscription.findUnique({ where: { id: payment.subscriptionId } })
      : await prisma.subscription.findFirst({
          where: { userId: payment.userId, planId: payment.planId, status: { in: ['ACTIVE', 'GRACE'] } },
          orderBy: { createdAt: 'desc' },
        });

    if (!subscription || (subscription.status !== 'ACTIVE' && subscription.status !== 'GRACE')) {
      // Paid but not activated (e.g. underpayment flagged for review) — don't
      // expose an invite link; tell the frontend it's still processing.
      res.json({ status: 'processing' });
      return;
    }

    const plan = SUBSCRIPTION_PLANS[payment.planId as keyof typeof SUBSCRIPTION_PLANS];
    res.json({
      status: 'active',
      planName: plan?.name,
      inviteLink: plan?.inviteLink,
      expiryDate: subscription.expiryDate,
    });
  } catch (error: any) {
    logger.error('registration-status failed', { error: error.message, reference });
    res.status(500).json({ error: 'Could not resolve registration status' });
  }
};
