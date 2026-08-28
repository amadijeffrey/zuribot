import { prisma } from '../config/database';
import { env } from '../config/env';
import { GRACE_PERIOD_DAYS } from '../config/constants';
import { resolvePlan } from './plan';
import { sendTextMessage, sendCtaUrlMessage } from './whatsapp';
import {
  sendGracePeriodEmail,
  sendExpiryEmail,
  sendExtensionEmail,
  sendExpiryDigestToAdmins,
  ExpiredSubscriberSummary,
} from './email';
import { logger } from '../utils/logger';
import { SubscriptionStats } from '../types';

export const getActiveSubscription = async (userId: string) => {
  return prisma.subscription.findFirst({
    where: {
      userId,
      status: { in: ['ACTIVE', 'GRACE'] },
    },
    orderBy: { createdAt: 'desc' },
  });
};

export const getActiveSubscriptions = async (userId: string) => {
  return prisma.subscription.findMany({
    where: {
      userId,
      status: { in: ['ACTIVE', 'GRACE'] },
    },
    orderBy: { createdAt: 'desc' },
  });
};

export const getUserLatestSubscription = async (userId: string) => {
  return prisma.subscription.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
};

// Returns the user's ACTIVE or GRACE subscription for a SPECIFIC plan. Used by
// the keyword-subscribe path so multi-plan users don't accidentally create a
// duplicate row for a plan they already hold.
export const getSubscriptionForPlan = async (userId: string, planId: string) => {
  return prisma.subscription.findFirst({
    where: { userId, planId, status: { in: ['ACTIVE', 'GRACE'] } },
    orderBy: { createdAt: 'desc' },
  });
};

export const moveToGracePeriod = async (subscriptionId: string): Promise<void> => {
  const subscription = await prisma.subscription.update({
    where: { id: subscriptionId },
    data: {
      status: 'GRACE',
      graceEndDate: new Date(Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000),
    },
    include: { user: true },
  });

  logger.info('Subscription moved to grace period', {
    subscriptionId,
    userId: subscription.userId,
  });

  // Email, not WhatsApp. This ran unconditionally against WhatsApp before —
  // ignoring both ENABLE_WHATSAPP_NOTIFICATIONS and the subscription's channel —
  // so a member moved to grace by the invoice.payment_failed webhook got a failed
  // send and no notification at all. Best-effort: a member's access has already
  // changed and a bounced email must not roll that back or abort the caller.
  try {
    await sendGracePeriodEmail(subscription.userId, subscription.planId);
  } catch (error: any) {
    logger.error('Grace period email failed', { subscriptionId, error: error.message });
  }
};

export const expireSubscription = async (subscriptionId: string): Promise<void> => {
  const subscription = await prisma.subscription.update({
    where: { id: subscriptionId },
    data: { status: 'EXPIRED' },
    include: { user: true },
  });

  logger.info('Subscription expired', {
    subscriptionId,
    userId: subscription.userId,
  });

  // See moveToGracePeriod — same fix, same reasoning.
  try {
    await sendExpiryEmail(subscription.userId, subscription.planId);
  } catch (error: any) {
    logger.error('Expiry email failed', { subscriptionId, error: error.message });
  }
};

export const getExpiredSubscriptions = async (take?: number) => {
  const now = new Date();
  // For recurring subs, give the renewal webhook a 24h buffer to arrive before
  // we treat the sub as expired.
  const recurringBuffer = new Date(now.getTime() - 24 * 60 * 60 * 1000);

  return prisma.subscription.findMany({
    where: {
      status: 'ACTIVE',
      OR: [
        { paystackSubscriptionCode: null, expiryDate: { lte: now } },
        { paystackSubscriptionCode: { not: null }, expiryDate: { lte: recurringBuffer } },
      ],
    },
    include: { user: true },
    orderBy: { expiryDate: 'asc' },
    ...(take ? { take } : {}),
  });
};

export const getGracePeriodExpired = async (take?: number) => {
  return prisma.subscription.findMany({
    where: {
      status: 'GRACE',
      graceEndDate: { lte: new Date() },
    },
    include: { user: true },
    orderBy: { graceEndDate: 'asc' },
    ...(take ? { take } : {}),
  });
};

export interface ExpirySweepResult {
  movedToGrace: number;
  expired: number;
  skipped: number;
  notifyFailures: number;
}

// Advances subscriptions whose time has run out.
//
// GRACE→EXPIRED always runs. ACTIVE→GRACE is opt-in via includeGraceTransition
// and is currently OFF for the scheduled sweep — see cron.routes.ts.
//
// Safe to run repeatedly and concurrently (cron + admin trigger at once): each
// row is advanced with a conditional updateMany, so only the caller that
// actually flips the status sends the notification. Batched so a backlog can't
// exceed the serverless function limit — re-run until counts come back zero.
export interface ExpirySweepOptions {
  batchSize?: number;
  /**
   * Whether to also advance ACTIVE subscriptions past their expiry into GRACE.
   * Off by default: the scheduled sweep currently runs the GRACE→EXPIRED step
   * only, with entry into GRACE driven by the invoice.payment_failed webhook.
   */
  includeGraceTransition?: boolean;
}

export const runExpirySweep = async (
  { batchSize = 100, includeGraceTransition = false }: ExpirySweepOptions = {},
): Promise<ExpirySweepResult> => {
  const result: ExpirySweepResult = { movedToGrace: 0, expired: 0, skipped: 0, notifyFailures: 0 };

  // Notifications are best-effort: a failed WhatsApp/SMTP call must not abort the
  // sweep or undo a status change the user's access already depends on.
  const notify = async (fn: () => Promise<void>, ctx: object) => {
    try {
      await fn();
    } catch (error: any) {
      result.notifyFailures++;
      logger.error('Sweep notification failed', { ...ctx, error: error.message });
    }
  };

  for (const sub of includeGraceTransition ? await getExpiredSubscriptions(batchSize) : []) {
    const claim = await prisma.subscription.updateMany({
      where: { id: sub.id, status: 'ACTIVE' },
      data: {
        status: 'GRACE',
        graceEndDate: new Date(Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000),
      },
    });

    if (claim.count === 0) {
      result.skipped++;
      continue;
    }

    result.movedToGrace++;
    logger.info('Sweep: subscription moved to grace period', {
      subscriptionId: sub.id,
      userId: sub.userId,
    });

    await notify(
      () =>
        sub.channel === 'WHATSAPP' && env.ENABLE_WHATSAPP_NOTIFICATIONS
          ? sendGracePeriodNotification(sub.user.phoneNumber, sub.planId)
          : sendGracePeriodEmail(sub.userId, sub.planId),
      { subscriptionId: sub.id, stage: 'grace' },
    );
  }

  // Collected across the batch so the operators get one digest rather than an
  // email per member — see sendExpiryDigestToAdmins.
  const expiredForAdmins: ExpiredSubscriberSummary[] = [];

  for (const sub of await getGracePeriodExpired(batchSize)) {
    const claim = await prisma.subscription.updateMany({
      where: { id: sub.id, status: 'GRACE' },
      data: { status: 'EXPIRED' },
    });

    if (claim.count === 0) {
      result.skipped++;
      continue;
    }

    result.expired++;
    logger.info('Sweep: subscription expired', { subscriptionId: sub.id, userId: sub.userId });

    await notify(
      () =>
        sub.channel === 'WHATSAPP' && env.ENABLE_WHATSAPP_NOTIFICATIONS
          ? sendExpiryNotification(sub.user.phoneNumber, sub.planId)
          : sendExpiryEmail(sub.userId, sub.planId),
      { subscriptionId: sub.id, stage: 'expired' },
    );

    expiredForAdmins.push({
      memberId: sub.user.memberId,
      name: sub.user.name,
      email: sub.user.email,
      phoneNumber: sub.user.phoneNumber,
      planName: (await resolvePlan(sub.planId))?.name ?? sub.planId,
      expiryDate: sub.expiryDate,
    });
  }

  // After the loop, so one run produces one email. Only rows this run actually
  // flipped are included — a subscription another caller claimed first was
  // skipped above and is somebody else's digest.
  await sendExpiryDigestToAdmins(expiredForAdmins);

  logger.info('Expiry sweep complete', { ...result });
  return result;
};

export const sendActivationConfirmation = async (
  userId: string,
  planId: string
): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    logger.error('User not found for activation confirmation', { userId });
    return;
  }

  const plan = await resolvePlan(planId);
  // Must be THIS plan's subscription: a user can hold several, and
  // getActiveSubscription returns whichever is newest regardless of plan —
  // which would quote the wrong expiry date back to them.
  const subscription = await getSubscriptionForPlan(userId, planId);
  const expiryDate = subscription?.expiryDate.toLocaleDateString() || 'N/A';

  const message = `🎉 *Payment Successful!*\n\n` +
    `Your *${plan?.name}* subscription is now active!\n\n` +
    `📅 *Expires:* ${expiryDate}\n\n` +
    `Reply *STATUS* anytime to check your subscription.`;

  await sendTextMessage(user.phoneNumber, message);

  // One CTA per group — WhatsApp allows a single URL per CTA message, so a
  // multi-group plan sends several.
  for (const group of plan?.groupLinks ?? []) {
    await sendCtaUrlMessage(
      user.phoneNumber,
      `Tap below to join *${group.name}*.`,
      'Join the group',
      group.inviteLink,
      'This link is exclusive to your subscription.'
    );
  }
  logger.info('Activation confirmation sent', { userId, planId });
};

// Renewal confirmation — same access-extended message, but no group invite
// CTA (the user is already in the group; re-sending the link is noise and
// can confuse them into thinking they need to re-join).
export const sendRenewalConfirmation = async (
  userId: string,
  planId: string,
): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    logger.error('User not found for renewal confirmation', { userId });
    return;
  }

  const plan = await resolvePlan(planId);
  const subscription = await getSubscriptionForPlan(userId, planId);
  const expiryDate = subscription?.expiryDate.toLocaleDateString() || 'N/A';

  const message = `🔄 *Renewal Successful!*\n\n` +
    `Your *${plan?.name}* subscription has been renewed.\n\n` +
    `📅 *New expiry:* ${expiryDate}\n\n` +
    `Reply *STATUS* anytime to check your subscription.`;

  await sendTextMessage(user.phoneNumber, message);
  logger.info('Renewal confirmation sent', { userId, planId });
};

const sendGracePeriodNotification = async (
  phoneNumber: string,
  planId: string
): Promise<void> => {
  const plan = await resolvePlan(planId);

  const message = `⚠️ *Subscription Expired*\n\n` +
    `Your *${plan?.name}* subscription has expired.\n\n` +
    `You have a ${GRACE_PERIOD_DAYS}-day grace period to renew and maintain your access.\n\n` +
    `Reply *RENEW* to renew now.`;

  await sendTextMessage(phoneNumber, message);
};

const sendExpiryNotification = async (
  phoneNumber: string,
  planId: string
): Promise<void> => {
  const plan = await resolvePlan(planId);

  const message = `❌ *Access Revoked*\n\n` +
    `Your *${plan?.name}* subscription and grace period have ended.\n\n` +
    `You no longer have access to the exclusive group.\n\n` +
    `Reply *UPGRADE* to resubscribe anytime.`;

  await sendTextMessage(phoneNumber, message);
};

export const sendExpiryReminder = async (
  phoneNumber: string,
  planId: string,
  daysRemaining: number
): Promise<void> => {
  const plan = await resolvePlan(planId);
  const emoji = daysRemaining === 1 ? '🚨' : daysRemaining <= 3 ? '⚠️' : '📢';

  const message = `${emoji} *Subscription Expiring Soon*\n\n` +
    `Your *${plan?.name}* subscription expires in ${daysRemaining} day${daysRemaining > 1 ? 's' : ''}.` 
   

  await sendTextMessage(phoneNumber, message);
  logger.info('Expiry reminder sent', { phoneNumber, planId, daysRemaining });
};

export const getSubscriptionStats = async (): Promise<SubscriptionStats> => {
  const [active, grace, expired, total] = await Promise.all([
    prisma.subscription.count({ where: { status: 'ACTIVE' } }),
    prisma.subscription.count({ where: { status: 'GRACE' } }),
    prisma.subscription.count({ where: { status: 'EXPIRED' } }),
    prisma.subscription.count(),
  ]);

  return { active, grace, expired, total };
};

export const getSubscriptions = async (
  page = 1,
  limit = 20,
  status?: string,
  planId?: string
) => {
  const skip = (page - 1) * limit;
  const where: any = {};
  
  if (status) where.status = status;
  if (planId) where.planId = planId;

  const [subscriptions, total] = await Promise.all([
    prisma.subscription.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { user: true },
    }),
    prisma.subscription.count({ where }),
  ]);

  return {
    data: subscriptions,
    pagination: {
      page,
      limit,
      total,
      pages: Math.ceil(total / limit),
    },
  };
};

export const extendSubscription = async (
  subscriptionId: string,
  days: number
) => {
  const subscription = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: { user: true },
  });

  if (!subscription) {
    throw new Error('Subscription not found');
  }

  // Extend from the later of (current expiry, now). If the sub already lapsed,
  // adding days to a past expiryDate would still leave it in the past.
  const base = subscription.expiryDate > new Date() ? subscription.expiryDate : new Date();
  const newExpiryDate = new Date(base);
  newExpiryDate.setDate(newExpiryDate.getDate() + days);

  const updated = await prisma.subscription.update({
    where: { id: subscriptionId },
    data: { expiryDate: newExpiryDate, status: 'ACTIVE' },
  });

  await sendExtensionEmail(subscription.userId, subscription.planId, days, newExpiryDate);

  logger.info('Subscription extended', { subscriptionId, days });

  return { subscription: updated, newExpiryDate };
};