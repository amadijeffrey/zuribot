import { Request, Response } from 'express';
import { z } from 'zod';
import { BillingInterval } from '@prisma/client';
import { prisma } from '../config/database';
import {
  initializePayment,
  initializePlanChange,
  initializeRenewalPayment,
  disablePaystackSubscription,
  verifyPayment,
  PlanFullError,
  SamePlanError,
} from '../services/payment';
import {
  getPurchasablePlans,
  resolvePlan,
  checkCapacity,
  checkCoverage,
  priceForSubscription,
} from '../services/plan';
import { getSubscriptionForPlan } from '../services/subscription';
import { sendWelcomeEmail, sendMembershipActivationEmail } from '../services/email';
import {
  hashPassword,
  verifyCredentials,
  issueToken,
  changePassword,
  MIN_PASSWORD_LENGTH,
} from '../services/user-auth';
import { env } from '../config/env';
import { withMemberId } from '../utils/member-id';
import { logger } from '../utils/logger';

// GET /users/plans — public plan catalogue for the frontend's plan picker.
// Invite links are never exposed here; they are delivered by email on activation.
export const listPlans = async (_req: Request, res: Response): Promise<void> => {
  const plans = await getPurchasablePlans();

  const payload = await Promise.all(
    plans.map(async (plan) => {
      const capacity = await checkCapacity(plan.code);
      return {
        code: plan.code,
        name: plan.name,
        description: plan.description,
        benefits: plan.benefits.map((b) => ({ name: b.name, type: b.type })),
        soldOut: !capacity.hasCapacity,
        seatsRemaining: capacity.remaining,
        // `interval` is what the client sends back when subscribing — the
        // PlanPrice UUID stays internal.
        prices: plan.prices
          .filter((pr) => pr.isActive)
          .map((pr) => ({
            interval: pr.interval,
            amount: pr.amount,
            durationDays: pr.durationDays,
          })),
      };
    }),
  );

  res.json({ plans: payload });
};

const publicUser = (u: {
  id: string;
  memberId: string | null;
  name: string | null;
  email: string | null;
  phoneNumber: string;
}) => ({
  id: u.id,
  memberId: u.memberId,
  name: u.name,
  email: u.email,
  phoneNumber: u.phoneNumber,
});

const intervalSchema = z
  .string()
  .transform((v) => v.trim().toUpperCase())
  .pipe(z.nativeEnum(BillingInterval));

const registerSchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(100),
  email: z.string().trim().toLowerCase().email('A valid email is required'),
  password: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`),
  // E.164-ish: optional leading +, 7–15 digits, no leading zero.
  phoneNumber: z
    .string()
    .trim()
    .regex(/^\+?[1-9]\d{6,14}$/, 'A valid phone number is required'),
  dateOfBirth: z.coerce.date().max(new Date(), { message: 'Date of birth must be in the past' }).optional(),
  state: z.string().trim().max(100).optional(),
  country: z.string().trim().max(100).optional(),
  // Optional plan selection — subscribing at registration is a convenience, not
  // a requirement; a member can equally join free and subscribe later from the
  // dashboard. Everything that used to be optional here (occupation, sector,
  // businessName, source, whyJoin, goal90) is now collected after activation via
  // PATCH /users/edit instead — see updateProfile.
  planId: z.string().trim().min(1).optional(),
  interval: intervalSchema.optional(),
});

type RegisteredUser = {
  id: string;
  memberId: string | null;
  name: string | null;
  email: string | null;
  phoneNumber: string;
};

// Shared tail for both the "claimed an existing bot row" and "brand new user"
// paths. With no plan, membership is free and welcomes immediately (unchanged
// behaviour) — welcomeEmailSentAt is stamped here so handleInitialPayment
// knows, if this member ever does subscribe later, to send the regular
// per-plan activation email rather than welcoming them a second time. With a
// plan, welcoming is deferred to activation — handleInitialPayment stamps it
// itself once the charge actually succeeds — so nobody gets a "you're in"
// email before their card has been charged.
const finishRegistration = async (
  res: Response,
  user: RegisteredUser,
  planId: string | undefined,
  interval: BillingInterval | undefined,
): Promise<void> => {
  if (!planId) {
    const sent = await sendWelcomeEmail(user.id);
    if (sent) {
      await prisma.user.update({ where: { id: user.id }, data: { welcomeEmailSentAt: new Date() } });
    }
    res.status(201).json({ token: issueToken(user), user: publicUser(user) });
    return;
  }

  try {
    const payment = await initializePayment({
      userId: user.id,
      planId,
      interval,
      email: user.email!,
      channel: 'WEB',
      origin: 'registration',
    });
    res.status(201).json({
      token: issueToken(user),
      user: publicUser(user),
      reference: payment.reference,
      authorizationUrl: payment.authorizationUrl,
    });
  } catch (error: any) {
    // The account exists either way — a checkout hiccup shouldn't make it look
    // like registration itself failed. They can subscribe from the dashboard.
    logger.error('Registration checkout failed', {
      error: error.message,
      userId: user.id,
      planId,
    });
    res.status(201).json({
      token: issueToken(user),
      user: publicUser(user),
      checkoutError:
        'Your account was created, but we could not start checkout. You can subscribe from your dashboard.',
    });
  }
};

// POST /users/register — creates a member account. Membership is free and carries
// no plan by default: registering and subscribing are separate steps, so a
// member can join, receive the free community group, and subscribe later or
// never. planId/interval are an optional convenience for subscribing in the
// same step.
export const register = async (req: Request, res: Response): Promise<void> => {
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Validation failed',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const { password, planId, interval, ...profile } = parsed.data;

  // Validated before anything is written: a bad plan/interval should never
  // create an account and leave the member wondering why checkout never showed.
  if (planId) {
    const plan = await resolvePlan(planId);
    if (!plan || !plan.isActive) {
      res.status(400).json({ error: `Unknown or unavailable plan: ${planId}` });
      return;
    }

    const purchasable = plan.prices.filter((pr) => pr.isActive);
    if (!interval && purchasable.length > 1) {
      res.status(400).json({
        error: 'This plan has multiple billing options — an interval is required',
        availableIntervals: purchasable.map((pr) => pr.interval),
      });
      return;
    }
    if (interval && !purchasable.some((pr) => pr.interval === interval)) {
      res.status(400).json({
        error: `${interval} is not available for this plan`,
        availableIntervals: purchasable.map((pr) => pr.interval),
      });
      return;
    }
  }

  try {
    const hash = await hashPassword(password);
    // Create-only. The previous upsert-by-phone silently rewrote an existing
    // member's name and email, which let anyone take over an account by
    // registering with someone else's phone number.
    const clash = await prisma.user.findFirst({
      where: { OR: [{ phoneNumber: profile.phoneNumber }, { email: profile.email }] },
      select: { id: true, phoneNumber: true, passwordHash: true, memberId: true },
    });

    if (clash) {
      // A bot-created user has no password. Let them claim that record by
      // registering with the same phone number, rather than being locked out of
      // their own subscription history.
      if (!clash.passwordHash && clash.phoneNumber === profile.phoneNumber) {
        const claimed = await withMemberId((memberId) =>
          prisma.user.update({
            where: { id: clash.id },
            data: {
              ...profile,
              passwordHash: hash,
              // Bot-created rows predate member IDs.
              ...(clash.memberId ? {} : { memberId }),
            },
          }),
        );
        logger.info('Existing bot user claimed their account', { userId: claimed.id });
        await finishRegistration(res, claimed, planId, interval);
        return;
      }

      res.status(409).json({
        error: 'An account with this email or phone number already exists. Please log in.',
      });
      return;
    }

    const user = await withMemberId((memberId) =>
      prisma.user.create({ data: { ...profile, memberId, passwordHash: hash } }),
    );

    logger.info('Member registered', { userId: user.id });
    await finishRegistration(res, user, planId, interval);
  } catch (error: any) {
    logger.error('Registration failed', { error: error.message, email: profile.email });
    res.status(500).json({ error: 'Registration failed. Please try again.' });
  }
};

const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(1),
});

// POST /users/login
export const login = async (req: Request, res: Response): Promise<void> => {
  if (!env.JWT_SECRET) {
    logger.error('Member login attempted but JWT_SECRET is not configured');
    res.status(503).json({ error: 'Login is not configured' });
    return;
  }

  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Email and password are required' });
    return;
  }

  const user = await verifyCredentials(parsed.data.email, parsed.data.password);
  if (!user) {
    // Same response for unknown account and wrong password.
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }

  res.json({ token: issueToken(user), expiresIn: env.JWT_EXPIRES_IN, user });
};

// GET /users/me — profile plus current subscriptions. Auth required.
export const me = async (req: Request, res: Response): Promise<void> => {
  const user = await prisma.user.findUnique({
    where: { id: req.member!.id },
    include: { subscriptions: { orderBy: { createdAt: 'desc' } } },
  });

  if (!user) {
    res.status(404).json({ error: 'Account not found' });
    return;
  }

  const subscriptions = await Promise.all(
    user.subscriptions.map(async (s) => {
      const plan = await resolvePlan(s.planId);
      const price = await priceForSubscription(s.planId, s.planPriceId);
      return {
        // Needed to call POST /users/subscriptions/:id/change.
        id: s.id,
        planId: s.planId,
        planName: plan?.name,
        interval: price?.interval,
        amount: price?.amount,
        status: s.status,
        expiryDate: s.expiryDate,
        cancelAtPeriodEnd: s.cancelAtPeriodEnd,
      };
    }),
  );

  res.json({
    user: {
      ...publicUser(user),
      dateOfBirth: user.dateOfBirth,
      occupation: user.occupation,
      businessName: user.businessName,
      sector: user.sector,
      state: user.state,
      country: user.country,
      source: user.source,
      whyJoin: user.whyJoin,
      goal90: user.goal90,
    },
    subscriptions,
  });
};

const updateProfileSchema = z.object({
  occupation: z.string().trim().min(1, 'occupation is required').max(100),
  businessName: z.string().trim().max(150).optional(),
  sector: z.string().trim().min(1, 'sector is required').max(100),
  source: z.string().trim().min(1, 'source is required').max(200),
  whyJoin: z.string().trim().min(1, 'whyJoin is required').max(2000),
  goal90: z.string().trim().min(1, 'goal90 is required').max(2000),
});

// PATCH /users/edit — completes the profile info registration deliberately
// left for after signup (see membership-activation). occupation/sector/
// source/whyJoin are required — this is the mandatory second half of
// registration, not an optional nice-to-have — businessName is the only
// field a member may genuinely have none of (e.g. not currently running a
// business), so it stays optional.
export const updateProfile = async (req: Request, res: Response): Promise<void> => {
  const parsed = updateProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    return;
  }

  const user = await prisma.user.update({
    where: { id: req.member!.id },
    data: parsed.data,
  });

  logger.info('Member profile updated', { userId: user.id, fields: Object.keys(parsed.data) });

  // This is the actual delivery point for the group invite links a new
  // member is owed — the welcome email sent at registration only points
  // here (see sendWelcomeEmail's activationUrl CTA); it never carries the
  // links itself. Fires every time profile completion succeeds.
  await sendMembershipActivationEmail(user.id);

  res.json({
    user: {
      ...publicUser(user),
      dateOfBirth: user.dateOfBirth,
      occupation: user.occupation,
      businessName: user.businessName,
      sector: user.sector,
      state: user.state,
      country: user.country,
      source: user.source,
      whyJoin: user.whyJoin,
      goal90: user.goal90,
    },
  });
};

const subscribeSchema = z.object({
  planId: z.string().min(1, 'planId is required'),
  // Billing interval, e.g. "ANNUAL". Accepted in any case; normalised to the
  // enum's uppercase form, which is what the rest of the API uses.
  interval: intervalSchema.optional(),
  // Only 'registration' (passed by /membership-activation/plans, the retry
  // page for a member who hasn't finished activation yet) means anything
  // different — see InitializePaymentParams.origin. Defaults to 'dashboard'.
  origin: z.enum(['registration', 'dashboard']).optional(),
});

// POST /users/subscribe — starts a payment for the authenticated member.
// Separate from registration: a member subscribes from their dashboard, may hold
// several plans, and re-subscribes without creating another account.
export const subscribe = async (req: Request, res: Response): Promise<void> => {
  const parsed = subscribeSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Validation failed',
      details: parsed.error.flatten().fieldErrors,
    });
    return;
  }

  const { planId, interval, origin } = parsed.data;
  const member = req.member!;

  const plan = await resolvePlan(planId);
  if (!plan || !plan.isActive) {
    res.status(400).json({ error: `Unknown or unavailable plan: ${planId}` });
    return;
  }

  const purchasable = plan.prices.filter((pr) => pr.isActive);

  // A tiered plan must say which interval — defaulting would silently charge the
  // cheapest option to someone who meant to buy the annual one.
  if (!interval && purchasable.length > 1) {
    res.status(400).json({
      error: 'This plan has multiple billing options — an interval is required',
      availableIntervals: purchasable.map((pr) => pr.interval),
    });
    return;
  }

  if (interval && !purchasable.some((pr) => pr.interval === interval)) {
    res.status(400).json({
      error: `${interval} is not available for this plan`,
      availableIntervals: purchasable.map((pr) => pr.interval),
    });
    return;
  }

  try {
    const existing = await getSubscriptionForPlan(member.id, planId);
    if (existing) {
      // GRACE is not "already subscribed" — their access has lapsed and they are
      // trying to recover it. Point them at renewal rather than refusing outright.
      res.status(409).json({
        error:
          existing.status === 'GRACE'
            ? 'This subscription is in its grace period — renew it instead'
            : 'You already have an active subscription for this plan',
        subscriptionId: existing.id,
        status: existing.status,
        renewUrl: `/api/users/subscriptions/${existing.id}/renew`,
      });
      return;
    }

    // Refuse to charge for a plan that adds nothing. Someone holding Apex buying
    // Premium would pay again for groups they already have — a charge that ends
    // up as a support ticket or a chargeback rather than revenue.
    const coverage = await checkCoverage(member.id, planId);
    if (coverage.fullyCovered) {
      const names = await Promise.all(coverage.coveredBy.map(async (c) => (await resolvePlan(c))?.name ?? c));
      res.status(409).json({
        error: `Your ${names.join(' and ')} already includes everything in ${plan.name}`,
        coveredBy: coverage.coveredBy,
      });
      return;
    }

    if (!member.email) {
      res.status(400).json({ error: 'Your account has no email address' });
      return;
    }

    const payment = await initializePayment({
      userId: member.id,
      planId,
      interval,
      email: member.email,
      channel: 'WEB',
      origin,
    });

    res.status(201).json({
      reference: payment.reference,
      authorizationUrl: payment.authorizationUrl,
    });
  } catch (error: any) {
    // A capped plan filling up is an expected outcome, not a server fault.
    if (error instanceof PlanFullError) {
      res.status(409).json({ error: 'This plan is fully subscribed', planId });
      return;
    }
    logger.error('Subscribe failed', { error: error.message, userId: member.id, planId });
    res.status(500).json({ error: 'Could not start payment. Please try again.' });
  }
};

// POST /users/subscriptions/:id/renew — pay for another period of the SAME plan.
//
// Distinct from /subscribe (which creates a new subscription) and from /change
// (which switches plan or interval). This renews in place: the existing row is
// reactivated and extended, so a member in their grace period recovers the
// subscription they already have rather than starting a second one.
export const renewSubscription = async (req: Request, res: Response): Promise<void> => {
  const member = req.member!;

  const subscription = await prisma.subscription.findUnique({ where: { id: req.params.id } });
  if (!subscription || subscription.userId !== member.id) {
    res.status(404).json({ error: 'Subscription not found' });
    return;
  }

  // ACTIVE is allowed too — renewing early just extends from the current expiry,
  // so no paid time is lost.
  if (subscription.status !== 'ACTIVE' && subscription.status !== 'GRACE') {
    res.status(400).json({
      error: `This subscription has ${subscription.status.toLowerCase()} — subscribe again instead`,
    });
    return;
  }

  try {
    const payment = await initializeRenewalPayment(subscription.id);
    res.status(201).json({
      reference: payment.reference,
      authorizationUrl: payment.authorizationUrl,
    });
  } catch (error: any) {
    logger.error('Renewal failed', { error: error.message, subscriptionId: subscription.id });
    res.status(500).json({ error: 'Could not start the renewal. Please try again.' });
  }
};

// POST /users/subscriptions/:id/cancel — cancel at period end. Access continues
// through expiryDate; Paystack is told to stop auto-charging so no further
// payment is taken. Same end state as the subscription.not_renew webhook, just
// member-initiated instead of Paystack-initiated. No refund/immediate-revoke
// path exists — see the cancelAtPeriodEnd field this sets.
export const cancelSubscription = async (req: Request, res: Response): Promise<void> => {
  const member = req.member!;

  const subscription = await prisma.subscription.findUnique({ where: { id: req.params.id } });
  if (!subscription || subscription.userId !== member.id) {
    res.status(404).json({ error: 'Subscription not found' });
    return;
  }

  if (subscription.status !== 'ACTIVE' && subscription.status !== 'GRACE') {
    res.status(400).json({
      error: `This subscription has ${subscription.status.toLowerCase()} — there's nothing to cancel`,
    });
    return;
  }

  if (subscription.cancelAtPeriodEnd) {
    res.status(409).json({ error: 'This subscription is already set to cancel at period end' });
    return;
  }

  try {
    // Fire-and-forget, same as every other call site — disablePaystackSubscription
    // logs and swallows its own failures rather than throwing.
    if (subscription.paystackSubscriptionCode && subscription.paystackEmailToken) {
      await disablePaystackSubscription(
        subscription.paystackSubscriptionCode,
        subscription.paystackEmailToken,
      );
    }

    const updated = await prisma.subscription.update({
      where: { id: subscription.id },
      data: { cancelAtPeriodEnd: true },
    });

    logger.info('Subscription cancelled by member (at period end)', {
      subscriptionId: subscription.id,
      userId: member.id,
    });
    res.json({ success: true, cancelAtPeriodEnd: true, expiryDate: updated.expiryDate });
  } catch (error: any) {
    logger.error('Cancel failed', { error: error.message, subscriptionId: subscription.id });
    res.status(500).json({ error: 'Could not cancel your subscription. Please try again.' });
  }
};

const changePlanSchema = z.object({
  planId: z.string().min(1, 'planId is required'),
  interval: intervalSchema.optional(),
});

// POST /users/subscriptions/:id/change — upgrade or downgrade.
//
// The new plan takes effect once payment succeeds, and unused days on the old
// plan carry over rather than being refunded. Same path in both directions.
export const changePlan = async (req: Request, res: Response): Promise<void> => {
  const parsed = changePlanSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    return;
  }

  const { planId, interval } = parsed.data;
  const member = req.member!;

  // Ownership: a member may only change their own subscription.
  const subscription = await prisma.subscription.findUnique({ where: { id: req.params.id } });
  if (!subscription || subscription.userId !== member.id) {
    res.status(404).json({ error: 'Subscription not found' });
    return;
  }

  if (subscription.status !== 'ACTIVE' && subscription.status !== 'GRACE') {
    res.status(400).json({
      error: `Cannot change a ${subscription.status.toLowerCase()} subscription — subscribe instead`,
    });
    return;
  }

  const plan = await resolvePlan(planId);
  if (!plan?.isActive) {
    res.status(400).json({ error: `Unknown or unavailable plan: ${planId}` });
    return;
  }

  const purchasable = plan.prices.filter((pr) => pr.isActive);
  if (!interval && purchasable.length > 1) {
    res.status(400).json({
      error: 'This plan has multiple billing options — an interval is required',
      availableIntervals: purchasable.map((pr) => pr.interval),
    });
    return;
  }

  try {
    const payment = await initializePlanChange(subscription.id, planId, interval);
    res.status(201).json({
      reference: payment.reference,
      authorizationUrl: payment.authorizationUrl,
    });
  } catch (error: any) {
    if (error instanceof SamePlanError) {
      res.status(409).json({ error: 'You are already on this plan and billing interval' });
      return;
    }
    if (error instanceof PlanFullError) {
      res.status(409).json({ error: 'This plan is fully subscribed', planId });
      return;
    }
    logger.error('Plan change failed', { error: error.message, subscriptionId: subscription.id });
    res.status(500).json({ error: 'Could not start the plan change. Please try again.' });
  }
};

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z
    .string()
    .min(MIN_PASSWORD_LENGTH, `Password must be at least ${MIN_PASSWORD_LENGTH} characters`),
});

// POST /users/change-password
export const updatePassword = async (req: Request, res: Response): Promise<void> => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    return;
  }

  const ok = await changePassword(
    req.member!.id,
    parsed.data.currentPassword,
    parsed.data.newPassword,
  );

  if (!ok) {
    res.status(401).json({ error: 'Current password is incorrect' });
    return;
  }

  res.json({ success: true, message: 'Password updated' });
};

// GET /users/payment-status?reference=… — called by the frontend after Paystack
// redirects back. Verifies on demand so it resolves even when the webhook is
// delayed. Returns the outcome only: group links are delivered by email, which
// handles multi-group plans and gives the customer a durable record.
export const paymentStatus = async (req: Request, res: Response): Promise<void> => {
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

    if (payment.status === 'PENDING') {
      await verifyPayment(reference);
      payment = await prisma.payment.findUnique({ where: { reference } });
    }

    if (!payment || payment.status === 'PENDING') {
      res.json({ status: 'pending', reference });
      return;
    }

    if (payment.status === 'FAILED') {
      res.json({ status: 'failed', reference });
      return;
    }

    const subscription = payment.subscriptionId
      ? await prisma.subscription.findUnique({ where: { id: payment.subscriptionId } })
      : await prisma.subscription.findFirst({
          where: {
            userId: payment.userId,
            planId: payment.planId,
            status: { in: ['ACTIVE', 'GRACE'] },
          },
          orderBy: { createdAt: 'desc' },
        });

    if (!subscription || (subscription.status !== 'ACTIVE' && subscription.status !== 'GRACE')) {
      // Paid but not activated (underpayment, oversold plan, or an activation
      // error). Admins are alerted; surface the reference for support.
      res.json({ status: 'processing', reference });
      return;
    }

    const plan = await resolvePlan(payment.planId);
    res.json({ status: 'active', planName: plan?.name, reference });
  } catch (error: any) {
    logger.error('payment-status failed', { error: error.message, reference });
    res.status(500).json({ error: 'Could not resolve payment status' });
  }
};
