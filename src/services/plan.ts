import { BillingInterval, BenefitType } from '@prisma/client';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';

// Plans are read on nearly every payment/webhook path but change rarely, so they
// are cached in-process rather than hitting the DB each time. On serverless the
// cache is per-instance and dies with it; the TTL bounds staleness after an
// admin edits a plan. Call invalidatePlanCache() to drop it immediately.
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface PlanPriceInfo {
  id: string;
  interval: BillingInterval;
  amount: number;
  durationDays: number;
  paystackPlanCode: string;
  isActive: boolean;
}

export interface BenefitInfo {
  code: string;
  type: BenefitType;
  name: string;
  inviteLink: string | null;
}

export interface ResolvedPlan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  keywords: string[];
  maxSubscribers: number | null;
  isActive: boolean;
  sortOrder: number;
  prices: PlanPriceInfo[];
  benefits: BenefitInfo[];
  /** Cheapest active price — what a caller gets when no interval is specified. */
  defaultPrice?: PlanPriceInfo;
  /** WhatsApp groups this plan grants, with a usable invite link. */
  groupLinks: { name: string; inviteLink: string }[];
}

let cache: { plans: ResolvedPlan[]; at: number } | null = null;

export const invalidatePlanCache = (): void => {
  cache = null;
  freeBenefitCache = undefined;
};

// The group every member gets on registration. Not part of any plan, so it never
// appears in plan entitlements and is never revoked when a subscription lapses.
export const FREE_GROUP_BENEFIT_CODE = 'group-free';

let freeBenefitCache: BenefitInfo | null | undefined;

export const getFreeGroupBenefit = async (): Promise<BenefitInfo | null> => {
  if (freeBenefitCache !== undefined) return freeBenefitCache;

  const row = await prisma.benefit.findUnique({ where: { code: FREE_GROUP_BENEFIT_CODE } });
  freeBenefitCache =
    row && row.isActive
      ? { code: row.code, type: row.type, name: row.name, inviteLink: row.inviteLink }
      : null;
  return freeBenefitCache;
};

const load = async (): Promise<ResolvedPlan[]> => {
  const rows = await prisma.plan.findMany({
    include: {
      prices: { orderBy: { amount: 'asc' } },
      benefits: { include: { benefit: true } },
    },
    orderBy: { sortOrder: 'asc' },
  });

  return rows.map((p) => {
    const prices: PlanPriceInfo[] = p.prices.map((pr) => ({
      id: pr.id,
      interval: pr.interval,
      amount: pr.amount,
      durationDays: pr.durationDays,
      paystackPlanCode: pr.paystackPlanCode,
      isActive: pr.isActive,
    }));

    const benefits: BenefitInfo[] = p.benefits
      .filter((pb) => pb.benefit.isActive)
      .map((pb) => ({
        code: pb.benefit.code,
        type: pb.benefit.type,
        name: pb.benefit.name,
        inviteLink: pb.benefit.inviteLink,
      }));

    return {
      id: p.id,
      code: p.code,
      name: p.name,
      description: p.description,
      keywords: p.keywords,
      maxSubscribers: p.maxSubscribers,
      isActive: p.isActive,
      sortOrder: p.sortOrder,
      prices,
      benefits,
      defaultPrice: prices.find((pr) => pr.isActive) ?? prices[0],
      groupLinks: benefits
        .filter((b) => b.type === 'WHATSAPP_GROUP' && b.inviteLink)
        .map((b) => ({ name: b.name, inviteLink: b.inviteLink as string })),
    };
  });
};

// All plans, including retired ones — renewals for a retired plan must still
// resolve. Use getPurchasablePlans() for anything a customer can buy.
export const getAllPlans = async (): Promise<ResolvedPlan[]> => {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.plans;

  const plans = await load();
  cache = { plans, at: Date.now() };
  logger.debug('Plan cache refreshed', { count: plans.length });
  return plans;
};

// Plans a customer may subscribe to: active, and with at least one active price.
export const getPurchasablePlans = async (): Promise<ResolvedPlan[]> =>
  (await getAllPlans()).filter((p) => p.isActive && p.prices.some((pr) => pr.isActive));

export const resolvePlan = async (code: string): Promise<ResolvedPlan | undefined> =>
  (await getAllPlans()).find((p) => p.code === code);

export const resolvePlanPrice = async (
  planPriceId: string,
): Promise<{ plan: ResolvedPlan; price: PlanPriceInfo } | undefined> => {
  for (const plan of await getAllPlans()) {
    const price = plan.prices.find((pr) => pr.id === planPriceId);
    if (price) return { plan, price };
  }
  return undefined;
};

// Reverse lookup from a Paystack plan code, used when a webhook identifies the
// plan only by that code.
export const findByPaystackPlanCode = async (
  paystackPlanCode: string,
): Promise<{ plan: ResolvedPlan; price: PlanPriceInfo } | undefined> => {
  for (const plan of await getAllPlans()) {
    const price = plan.prices.find((pr) => pr.paystackPlanCode === paystackPlanCode);
    if (price) return { plan, price };
  }
  return undefined;
};

// Price a subscription should be billed/extended at: the interval actually
// purchased, falling back to the plan default for rows predating tiered pricing.
export const priceForSubscription = async (
  planCode: string,
  planPriceId: string | null,
): Promise<PlanPriceInfo | undefined> => {
  if (planPriceId) {
    const found = await resolvePlanPrice(planPriceId);
    if (found) return found.price;
  }
  return (await resolvePlan(planCode))?.defaultPrice;
};

export const matchPlanByKeyword = async (text: string): Promise<ResolvedPlan | undefined> => {
  const upper = text.trim().toUpperCase();
  for (const plan of await getPurchasablePlans()) {
    if (plan.keywords.some((k) => upper === k || upper.includes(k))) return plan;
  }
  return undefined;
};

// Live subscriber count for a capped plan (Apex). ACTIVE and GRACE both hold a
// seat — a grace-period subscriber has not lost their place yet.
export const countLiveSubscribers = async (planCode: string): Promise<number> =>
  prisma.subscription.count({
    where: { planId: planCode, status: { in: ['ACTIVE', 'GRACE'] } },
  });

export interface CoverageResult {
  /** True when live subscriptions already grant every benefit of `planCode`. */
  fullyCovered: boolean;
  /** Plan codes providing that cover, for a message the member can act on. */
  coveredBy: string[];
  /** Benefits the new plan would add — empty when fully covered. */
  wouldAdd: string[];
}

// Would subscribing to `planCode` actually give this member anything?
//
// Compares BENEFITS rather than plan names, so it stays correct if what a plan
// includes changes later — no hard-coded "apex beats premium" hierarchy.
export const checkCoverage = async (
  userId: string,
  planCode: string,
): Promise<CoverageResult> => {
  const target = await resolvePlan(planCode);
  const wanted = new Set((target?.benefits ?? []).map((b) => b.code));
  if (wanted.size === 0) return { fullyCovered: false, coveredBy: [], wouldAdd: [] };

  const live = await prisma.subscription.findMany({
    where: { userId, status: { in: ['ACTIVE', 'GRACE'] } },
    select: { planId: true },
  });

  const coveredBy: string[] = [];
  const held = new Set<string>();

  for (const { planId } of live) {
    if (planId === planCode) continue; // same plan is handled separately
    const plan = await resolvePlan(planId);
    const codes = (plan?.benefits ?? []).map((b) => b.code);
    if (codes.some((c) => wanted.has(c))) coveredBy.push(planId);
    for (const c of codes) held.add(c);
  }

  const wouldAdd = [...wanted].filter((c) => !held.has(c));
  return { fullyCovered: wouldAdd.length === 0, coveredBy, wouldAdd };
};

export interface CapacityResult {
  hasCapacity: boolean;
  limit: number | null;
  used: number;
  remaining: number | null;
}

// Capacity check for checkout. Counts live subscribers plus recent PENDING
// payments, so a burst of simultaneous checkouts can't oversell the last seats.
// This is the soft check; activation re-checks authoritatively under a lock.
export const checkCapacity = async (
  planCode: string,
  pendingWindowMinutes = 30,
): Promise<CapacityResult> => {
  const plan = await resolvePlan(planCode);
  const limit = plan?.maxSubscribers ?? null;
  if (limit === null) return { hasCapacity: true, limit: null, used: 0, remaining: null };

  const since = new Date(Date.now() - pendingWindowMinutes * 60 * 1000);
  const [live, pending] = await Promise.all([
    countLiveSubscribers(planCode),
    // DISTINCT user, not row: a member with several abandoned checkouts holds one
    // seat, not several. Counting rows let a single authenticated user exhaust a
    // capped plan for everyone by repeatedly starting a payment.
    prisma.payment.findMany({
      where: { planId: planCode, status: 'PENDING', createdAt: { gte: since } },
      distinct: ['userId'],
      select: { userId: true },
    }),
  ]);

  const used = live + pending.length;
  return {
    hasCapacity: used < limit,
    limit,
    used,
    remaining: Math.max(0, limit - used),
  };
};
