import { Request, Response } from 'express';
import { prisma } from '../config/database';
import {
  getActiveSubscription,
  getSubscriptionStats,
  getSubscriptions,
  extendSubscription as extendSub,
  moveToGracePeriod,
} from '../services/subscription';
import { sendTextMessage, sendCtaUrlMessage } from '../services/whatsapp';
import { SUBSCRIPTION_PLANS } from '../config/constants';
import { logger } from '../utils/logger';

export const getUsers = async (req: Request, res: Response): Promise<void> => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const skip = (page - 1) * limit;

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        subscriptions: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    }),
    prisma.user.count(),
  ]);

  res.json({
    data: users,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

export const getUser = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      subscriptions: { orderBy: { createdAt: 'desc' } },
      payments: { orderBy: { createdAt: 'desc' } },
    },
  });

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  res.json(user);
};

export const getSubscriptionsHandler = async (req: Request, res: Response): Promise<void> => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const status = req.query.status as string | undefined;
  const planId = req.query.planId as string | undefined;

  const result = await getSubscriptions(page, limit, status, planId);
  res.json(result);
};

export const getStats = async (_req: Request, res: Response): Promise<void> => {
  const [subscriptionStats, userCount, paymentStats] = await Promise.all([
    getSubscriptionStats(),
    prisma.user.count(),
    prisma.payment.groupBy({
      by: ['status'],
      _count: true,
      _sum: { amount: true },
    }),
  ]);

  const totalRevenue = paymentStats
    .filter(p => p.status === 'SUCCESS')
    .reduce((sum, p) => sum + (p._sum.amount || 0), 0);

  res.json({
    users: { total: userCount },
    subscriptions: subscriptionStats,
    payments: {
      total: paymentStats.reduce((sum, p) => sum + p._count, 0),
      byStatus: paymentStats.reduce((acc, p) => {
        acc[p.status] = p._count;
        return acc;
      }, {} as Record<string, number>),
      totalRevenue: totalRevenue / 100,
    },
  });
};

export const resendGroupLink = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const subscription = await getActiveSubscription(id);
  if (!subscription) {
    res.status(400).json({ error: 'User has no active subscription' });
    return;
  }

  const plan = SUBSCRIPTION_PLANS[subscription.planId as keyof typeof SUBSCRIPTION_PLANS];
  if (!plan?.inviteLink) {
    res.status(400).json({ error: 'No invite link configured for this plan' });
    return;
  }

  await sendCtaUrlMessage(
    user.phoneNumber,
    `Tap the button below to join your exclusive *${plan.name}* group.`,
    'Join the group',
    plan.inviteLink,
    'This link is exclusive to your subscription.'
  );

  logger.info('Group link resent', { userId: id, adminAction: true });
  res.json({ success: true, message: 'Group link sent' });
};

export const sendMessageToUser = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { message } = req.body;

  if (!message) {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const messageId = await sendTextMessage(user.phoneNumber, message);

  logger.info('Manual message sent', { userId: id, adminAction: true });
  res.json({ success: true, messageId });
};

export const simulatePaymentFailed = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const subscription = await prisma.subscription.findUnique({ where: { id } });
  if (!subscription) {
    res.status(404).json({ error: 'Subscription not found' });
    return;
  }

  if (subscription.status !== 'ACTIVE') {
    res.status(400).json({ error: `Subscription is not ACTIVE (current: ${subscription.status})` });
    return;
  }

  await moveToGracePeriod(id);
  logger.info('Grace period simulated', { subscriptionId: id, adminAction: true });
  res.json({ success: true, message: 'Subscription moved to GRACE period' });
};

export const extendSubscription = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { days } = req.body;

  if (!days || days < 1) {
    res.status(400).json({ error: 'Valid days value is required' });
    return;
  }

  try {
    const result = await extendSub(id, days);
    logger.info('Subscription extended', { subscriptionId: id, days, adminAction: true });
    res.json({ success: true, newExpiryDate: result.newExpiryDate });
  } catch (error: any) {
    res.status(404).json({ error: error.message });
  }
};

export const broadcast = async (req: Request, res: Response): Promise<void> => {
  const { message, filter } = req.body;

  if (!message) {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  let users;

  switch (filter) {
    case 'active':
      const activeSubscriptions = await prisma.subscription.findMany({
        where: { status: 'ACTIVE' },
        include: { user: true },
      });
      users = activeSubscriptions.map(s => s.user);
      break;
    case 'expired':
      const expiredSubscriptions = await prisma.subscription.findMany({
        where: { status: 'EXPIRED' },
        include: { user: true },
      });
      users = expiredSubscriptions.map(s => s.user);
      break;
    default:
      users = await prisma.user.findMany();
  }

  const uniqueUsers = Array.from(new Map(users.map(u => [u.id, u])).values());

  let sent = 0;
  let failed = 0;

  for (const user of uniqueUsers) {
    try {
      await sendTextMessage(user.phoneNumber, message);
      sent++;
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      failed++;
      logger.error('Broadcast message failed', { userId: user.id, error });
    }
  }

  logger.info('Broadcast completed', { sent, failed, filter });
  res.json({ success: true, sent, failed, total: uniqueUsers.length });
};

export const getPayments = async (req: Request, res: Response): Promise<void> => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const status = req.query.status as string;
  const skip = (page - 1) * limit;

  const where: any = {};
  if (status) where.status = status;

  const [payments, total] = await Promise.all([
    prisma.payment.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { user: true },
    }),
    prisma.payment.count({ where }),
  ]);

  res.json({
    data: payments,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};
