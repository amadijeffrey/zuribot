import { env } from './env';

// Plans, prices and benefits now live in the database (see prisma/schema.prisma
// and src/services/plan.ts). They are no longer constants: pricing, invite links
// and plan availability change without a deploy, and a retired plan stays
// resolvable for existing subscribers via Plan.isActive.

// Every plan is priced in kobo, in this currency. Paystack reports the currency
// a charge actually settled in, and comparing amounts without comparing currency
// would let 5,000 of a weaker currency satisfy a ₦5,000 plan. If you ever sell in
// more than one currency this belongs on PlanPrice instead of here.
export const PLAN_CURRENCY = 'NGN';

export const UPGRADE_KEYWORDS = ['UPGRADE', 'PLANS', 'OPTIONS'];

export const SUBSCRIPTION_STATUS = {
  ACTIVE: 'ACTIVE',
  GRACE: 'GRACE',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;

export const PAYMENT_STATUS = {
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
} as const;

export const GRACE_PERIOD_DAYS = env.GRACE_PERIOD_DAYS;