import { Request, Response } from 'express';
import { prisma } from '../config/database';
import {
  getActiveSubscription,
  getSubscriptionStats,
  getSubscriptions,
  extendSubscription as extendSub,
  moveToGracePeriod,
  runExpirySweep,
} from '../services/subscription';
import { verifyPlanConfiguration, runReconciliation } from '../services/payment';
import { getPendingRemovals, markAccessRevoked } from '../services/removal';
import { sendCustomEmail, resendGroupLinksEmail } from '../services/email';
import { getAllPlans, resolvePlan } from '../services/plan';
import { SAFE_USER_SELECT } from '../services/user';
import { normalizeMemberId } from '../utils/member-id';
import { logger } from '../utils/logger';

export const getUsers = async (req: Request, res: Response): Promise<void> => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const memberId = req.query.memberId as string | undefined;
  const skip = (page - 1) * limit;

  // member_id is unique, so this narrows to at most one row — but it still goes
  // through the paginated shape rather than a bare object, so the admin UI can
  // reuse one list renderer whether or not the filter is applied.
  const where: any = {};
  if (memberId) where.memberId = normalizeMemberId(memberId);

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      select: {
        ...SAFE_USER_SELECT,
        subscriptions: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    }),
    prisma.user.count({ where }),
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
    select: {
      ...SAFE_USER_SELECT,
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

  const plan = await resolvePlan(subscription.planId);
  if (!plan?.groupLinks.length) {
    res.status(400).json({ error: 'No invite links configured for this plan' });
    return;
  }

  const delivered = await resendGroupLinksEmail(id, subscription.planId);
  if (!delivered) {
    res.status(400).json({ error: 'Could not email the links — user has no email address' });
    return;
  }

  logger.info('Group links resent', { userId: id, count: plan.groupLinks.length, adminAction: true });
  res.json({ success: true, message: `${plan.groupLinks.length} group link(s) emailed` });
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

  const { subject } = req.body;
  const delivered = await sendCustomEmail(id, subject || 'A message from ZuriCircle', message);

  if (!delivered) {
    res.status(400).json({ error: 'Could not send — user has no email address' });
    return;
  }

  logger.info('Manual message sent', { userId: id, adminAction: true });
  res.json({ success: true });
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

// Manual trigger for the same sweep the scheduler runs. Useful while cron is
// disabled, for re-running after a fix, and for verifying behaviour in production.
// Idempotent, so it is safe to run alongside a scheduled sweep.
export const runSweep = async (_req: Request, res: Response): Promise<void> => {
  try {
    const result = await runExpirySweep();
    logger.info('Expiry sweep run', { ...result, adminAction: true });
    res.json({ success: true, ...result });
  } catch (error: any) {
    logger.error('Admin expiry sweep failed', { error: error.message });
    res.status(500).json({ error: 'Sweep failed' });
  }
};

// GET /admin/plans — lightweight list for the subscriptions filter. `code` is
// what /admin/subscriptions?planId= expects. Retired plans are included, not
// just purchasable ones: they still have subscribers worth filtering to.
export const getPlans = async (_req: Request, res: Response): Promise<void> => {
  try {
    const [plans, counts] = await Promise.all([
      getAllPlans(),
      // One groupBy rather than a count per plan. Subscription.planId holds the
      // plan CODE, not the Plan row's uuid.
      prisma.subscription.groupBy({ by: ['planId'], _count: true }),
    ]);

    const subscriberCounts = new Map(counts.map((c) => [c.planId, c._count]));

    res.json({
      plans: plans.map((plan) => ({
        code: plan.code,
        name: plan.name,
        isActive: plan.isActive,
        // All statuses, so a filter option isn't hidden just because everyone on
        // that plan has expired.
        subscriberCount: subscriberCounts.get(plan.code) ?? 0,
      })),
    });
  } catch (error: any) {
    logger.error('Admin plan listing failed', { error: error.message });
    res.status(500).json({ error: 'Could not load plans' });
  }
};

// Compares each plan's local amount/durationDays against what Paystack actually
// bills. Run after any plan change on either side.
export const verifyPlans = async (_req: Request, res: Response): Promise<void> => {
  try {
    const checks = await verifyPlanConfiguration();
    const drifted = checks.filter(c => !c.ok);
    res.status(drifted.length ? 409 : 200).json({
      ok: drifted.length === 0,
      drifted: drifted.length,
      checks,
    });
  } catch (error: any) {
    logger.error('Plan verification failed', { error: error.message });
    res.status(500).json({ error: 'Plan verification failed' });
  }
};

// Members whose access should be withdrawn from WhatsApp groups. Computed so an
// admin never removes someone still entitled via another live plan.
export const pendingRemovals = async (_req: Request, res: Response): Promise<void> => {
  try {
    const pending = await getPendingRemovals();
    res.json({
      count: pending.length,
      pending: pending.filter(p => p.removeFrom.length > 0),
      // Nothing to do for these — every group they held is still granted by
      // another live subscription. Listed so they can be cleared off the queue.
      noActionNeeded: pending.filter(p => p.removeFrom.length === 0),
    });
  } catch (error: any) {
    logger.error('Pending removals failed', { error: error.message });
    res.status(500).json({ error: 'Could not compute pending removals' });
  }
};

// Records that the manual WhatsApp removal was done, clearing it off the list.
export const confirmRemoval = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const changed = await markAccessRevoked(id);
  logger.info('Removal confirmed', { subscriptionId: id, changed, adminAction: true });
  res.json({ success: true, alreadyRecorded: !changed });
};

// Pulls state from Paystack instead of waiting for webhooks. Safe to re-run.
export const reconcile = async (req: Request, res: Response): Promise<void> => {
  try {
    const result = await runReconciliation({
      includeSubscriptions: req.query.subscriptions === 'true',
    });
    res.json({ success: true, ...result });
  } catch (error: any) {
    logger.error('Reconciliation failed', { error: error.message });
    res.status(500).json({ error: 'Reconciliation failed' });
  }
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
        include: { user: { select: SAFE_USER_SELECT } },
      });
      users = activeSubscriptions.map(s => s.user);
      break;
    case 'expired':
      const expiredSubscriptions = await prisma.subscription.findMany({
        where: { status: 'EXPIRED' },
        include: { user: { select: SAFE_USER_SELECT } },
      });
      users = expiredSubscriptions.map(s => s.user);
      break;
    default:
      users = await prisma.user.findMany();
  }

  const uniqueUsers = Array.from(new Map(users.map(u => [u.id, u])).values());

  const { subject } = req.body;
  let sent = 0;
  let failed = 0;

  // Sent in parallel batches rather than one-at-a-time with a sleep: email is an
  // HTTP call of a few hundred ms, so batching keeps a broadcast inside the
  // serverless time limit instead of timing out partway and leaving no record of
  // who was reached.
  const BATCH = 20;
  for (let i = 0; i < uniqueUsers.length; i += BATCH) {
    const results = await Promise.all(
      uniqueUsers
        .slice(i, i + BATCH)
        .map(u =>
          sendCustomEmail(u.id, subject || 'An update from ZuriCircle', message).catch(() => false),
        ),
    );
    sent += results.filter(Boolean).length;
    failed += results.filter(r => !r).length;
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
      include: { user: { select: SAFE_USER_SELECT } },
    }),
    prisma.payment.count({ where }),
  ]);

  res.json({
    data: payments,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};
