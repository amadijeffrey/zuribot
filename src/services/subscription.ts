import { prisma } from '../config/database';
import { SUBSCRIPTION_PLANS, GRACE_PERIOD_DAYS } from '../config/constants';
import { sendTextMessage, sendCtaUrlMessage } from './whatsapp';
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

  await sendGracePeriodNotification(subscription.user.phoneNumber, subscription.planId);
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

  await sendExpiryNotification(subscription.user.phoneNumber, subscription.planId);
};

export const getExpiredSubscriptions = async () => {
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
  });
};

export const getGracePeriodExpired = async () => {
  return prisma.subscription.findMany({
    where: {
      status: 'GRACE',
      graceEndDate: { lte: new Date() },
    },
    include: { user: true },
  });
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

  const plan = SUBSCRIPTION_PLANS[planId as keyof typeof SUBSCRIPTION_PLANS];
  const subscription = await getActiveSubscription(userId);
  const expiryDate = subscription?.expiryDate.toLocaleDateString() || 'N/A';

  const message = `🎉 *Payment Successful!*\n\n` +
    `Your *${plan?.name}* subscription is now active!\n\n` +
    `📅 *Expires:* ${expiryDate}\n\n` +
    `Reply *STATUS* anytime to check your subscription.`;

  await sendTextMessage(user.phoneNumber, message);

  if (plan?.inviteLink) {
    await sendCtaUrlMessage(
      user.phoneNumber,
      `Tap the button below to join your exclusive *${plan?.name}* group.`,
      'Join the group',
      plan.inviteLink,
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

  const plan = SUBSCRIPTION_PLANS[planId as keyof typeof SUBSCRIPTION_PLANS];
  const subscription = await getActiveSubscription(userId);
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
  const plan = SUBSCRIPTION_PLANS[planId as keyof typeof SUBSCRIPTION_PLANS];

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
  const plan = SUBSCRIPTION_PLANS[planId as keyof typeof SUBSCRIPTION_PLANS];

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
  const plan = SUBSCRIPTION_PLANS[planId as keyof typeof SUBSCRIPTION_PLANS];
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

  await sendTextMessage(
    subscription.user.phoneNumber,
    `Good news! Your subscription has been extended by ${days} days.\n\nNew expiry date: ${newExpiryDate.toLocaleDateString()}`
  );

  logger.info('Subscription extended', { subscriptionId, days });

  return { subscription: updated, newExpiryDate };
};