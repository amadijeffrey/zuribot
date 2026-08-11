import { prisma } from '../config/database';
import { resolvePlan } from './plan';
import { logger } from '../utils/logger';

// WhatsApp's API cannot remove group members, so an admin does it by hand. This
// turns "these subscriptions expired" into an unambiguous instruction, and —
// critically — works out which groups the member must KEEP access to.
//
// The trap it avoids: Apex grants the Health and Wealth groups, which the
// standalone plans also grant. If someone's `health` plan lapses while their
// `apex` plan is live, removing them from the Health Group would cut off a
// paying customer. Entitlement is the union across every live plan, so a group
// is only revoked when no remaining plan grants it.

export interface PendingRemoval {
  subscriptionId: string;
  userId: string;
  name: string | null;
  phoneNumber: string;
  email: string | null;
  expiredPlan: string;
  status: string;
  expiredAt: Date;
  /** Groups to remove them from — no live plan grants these any more. */
  removeFrom: string[];
  /** Groups to leave them in — still granted by another live subscription. */
  keepIn: string[];
}

const groupBenefitsOf = async (planCode: string): Promise<Map<string, string>> => {
  const plan = await resolvePlan(planCode);
  const map = new Map<string, string>(); // code -> display name
  for (const b of plan?.benefits ?? []) {
    if (b.type === 'WHATSAPP_GROUP') map.set(b.code, b.name);
  }
  return map;
};

export const getPendingRemovals = async (limit = 100): Promise<PendingRemoval[]> => {
  const ended = await prisma.subscription.findMany({
    where: {
      status: { in: ['EXPIRED', 'CANCELLED'] },
      accessRevokedAt: null,
    },
    include: { user: true },
    orderBy: { updatedAt: 'asc' },
    take: limit,
  });

  const results: PendingRemoval[] = [];
  if (ended.length === 0) return results;

  // One query for every affected user's live subscriptions, rather than one per
  // ended subscription. The loop below then works purely in memory.
  const liveByUser = new Map<string, string[]>();
  const live = await prisma.subscription.findMany({
    where: {
      userId: { in: [...new Set(ended.map((s) => s.userId))] },
      status: { in: ['ACTIVE', 'GRACE'] },
    },
    select: { userId: true, planId: true },
  });
  for (const l of live) {
    liveByUser.set(l.userId, [...(liveByUser.get(l.userId) ?? []), l.planId]);
  }

  for (const sub of ended) {
    const granted = await groupBenefitsOf(sub.planId);
    if (granted.size === 0) continue; // plan granted no groups; nothing to revoke

    // Everything this user is still entitled to, across all their live plans.
    const stillEntitled = new Set<string>();
    for (const planId of liveByUser.get(sub.userId) ?? []) {
      for (const code of (await groupBenefitsOf(planId)).keys()) stillEntitled.add(code);
    }

    const removeFrom: string[] = [];
    const keepIn: string[] = [];
    for (const [code, name] of granted) {
      (stillEntitled.has(code) ? keepIn : removeFrom).push(name);
    }

    results.push({
      subscriptionId: sub.id,
      userId: sub.userId,
      name: sub.user.name,
      phoneNumber: sub.user.phoneNumber,
      email: sub.user.email,
      expiredPlan: (await resolvePlan(sub.planId))?.name ?? sub.planId,
      status: sub.status,
      expiredAt: sub.expiryDate,
      removeFrom,
      keepIn,
    });
  }

  return results;
};

// Marks the manual removal as done so it drops off the list. Idempotent.
export const markAccessRevoked = async (subscriptionId: string): Promise<boolean> => {
  const updated = await prisma.subscription.updateMany({
    where: { id: subscriptionId, accessRevokedAt: null },
    data: { accessRevokedAt: new Date() },
  });

  logger.info('Access revocation recorded', { subscriptionId, changed: updated.count });
  return updated.count > 0;
};
