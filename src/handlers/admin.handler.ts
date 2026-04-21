import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { 
  getActiveSubscription, 
  getSubscriptionStats, 
  getSubscriptions,
  extendSubscription as extendSub 
} from '../services/subscription';
import { sendTextMessage } from '../services/whatsapp';
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
      subscriptions: { orderBy: { createdAt: 'desc' }, include: { group: true } },
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

  const group = await prisma.group.findUnique({
    where: { planId: subscription.planId },
  });

  if (!group) {
    res.status(400).json({ error: 'Group not found for this plan' });
    return;
  }

  await sendTextMessage(
    user.phoneNumber,
    `Here's your group invite link:\n\n${group.inviteLink}\n\n_This link is exclusive to subscribers._`
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

export const getGroups = async (_req: Request, res: Response): Promise<void> => {
  const groups = await prisma.group.findMany({
    include: { _count: { select: { subscriptions: true } } },
  });
  res.json(groups);
};

export const createGroup = async (req: Request, res: Response): Promise<void> => {
  const { planId, name, inviteLink } = req.body;

  if (!planId || !name || !inviteLink) {
    res.status(400).json({ error: 'planId, name, and inviteLink are required' });
    return;
  }

  const group = await prisma.group.create({
    data: { planId, name, inviteLink },
  });

  res.status(201).json(group);
};

export const updateGroup = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { name, inviteLink, isActive } = req.body;

  const group = await prisma.group.update({
    where: { id },
    data: {
      ...(name && { name }),
      ...(inviteLink && { inviteLink }),
      ...(typeof isActive === 'boolean' && { isActive }),
    },
  });

  res.json(group);
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
