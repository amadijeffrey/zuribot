import { prisma } from '../src/config/database';
import { invalidatePlanCache } from '../src/services/plan';

// Everything a test creates carries this marker so cleanup can be exhaustive
// without touching real rows.
export const TEST_TAG = 'jesttest';

export const uniqueEmail = () => `${TEST_TAG}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}@example.test`;
export const uniquePhone = () => `+2347${Math.floor(1000000000 + Math.random() * 8999999999)}`.slice(0, 14);

export const makeUser = async (overrides: Record<string, any> = {}) =>
  prisma.user.create({
    data: {
      email: uniqueEmail(),
      phoneNumber: uniquePhone(),
      name: 'Jest User',
      memberId: `ZCN-T${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      ...overrides,
    },
  });

// A plan the tests own outright, so assertions never depend on seeded data that
// an operator might change.
export const makeTestPlan = async (opts: {
  code: string;
  maxSubscribers?: number | null;
  prices: { interval: 'MONTHLY' | 'SEMIANNUAL' | 'ANNUAL'; amount: number; durationDays: number }[];
  groupLinks?: number;
}) => {
  const plan = await prisma.plan.create({
    data: {
      code: opts.code,
      name: `Test ${opts.code}`,
      maxSubscribers: opts.maxSubscribers ?? null,
      isActive: true,
    },
  });

  for (const p of opts.prices) {
    await prisma.planPrice.create({
      data: {
        planId: plan.id,
        interval: p.interval,
        amount: p.amount,
        durationDays: p.durationDays,
        paystackPlanCode: `PLN_${opts.code}_${p.interval}`.slice(0, 40),
        isActive: true,
      },
    });
  }

  for (let i = 1; i <= (opts.groupLinks ?? 1); i++) {
    const benefit = await prisma.benefit.create({
      data: {
        code: `${opts.code}-group-${i}`,
        type: 'WHATSAPP_GROUP',
        name: `${opts.code} Group ${i}`,
        inviteLink: `https://chat.whatsapp.com/${opts.code}${i}`,
      },
    });
    await prisma.planBenefit.create({ data: { planId: plan.id, benefitId: benefit.id } });
  }

  invalidatePlanCache();
  return plan;
};

// Shape of a Paystack charge.success payload, with only the fields the code reads.
export const chargeSuccess = (o: {
  reference: string;
  amount: number;
  currency?: string;
  authorizationCode?: string;
  customerCode?: string;
  email?: string;
  planCode?: string;
  subscriptionCode?: string;
}) => ({
  reference: o.reference,
  amount: o.amount,
  currency: o.currency ?? 'NGN',
  status: 'success',
  channel: 'card',
  paid_at: new Date().toISOString(),
  authorization: {
    authorization_code: o.authorizationCode ?? 'AUTH_test',
    last4: '4081',
    brand: 'visa',
    reusable: true,
    bin: '418745',
    exp_month: '01',
    exp_year: '2030',
    account_name: 'TEST CARDHOLDER',
  },
  // Distinct per charge unless a test pins it. Sharing one customer code across
  // fixtures makes the customer-code fallback match an unrelated subscription —
  // real Paystack customers are distinct, so a shared default is unrealistic.
  customer: {
    customer_code: o.customerCode ?? `CUS_${Math.random().toString(36).slice(2, 12)}`,
    email: o.email ?? 'x@example.test',
  },
  ...(o.planCode ? { plan: { plan_code: o.planCode } } : {}),
  ...(o.subscriptionCode ? { subscription: { subscription_code: o.subscriptionCode } } : {}),
});

export const cleanupAll = async (planCodes: string[]) => {
  await prisma.payment.deleteMany({ where: { user: { email: { contains: TEST_TAG } } } });
  await prisma.subscription.deleteMany({ where: { user: { email: { contains: TEST_TAG } } } });
  await prisma.user.deleteMany({ where: { email: { contains: TEST_TAG } } });

  // Benefits can be shared across plans, so every link to a test benefit must go
  // before the benefit itself — including links owned by another test plan.
  const benefits = await prisma.benefit.findMany({
    where: { OR: planCodes.map((c) => ({ code: { startsWith: `${c}-group-` } })) },
    select: { id: true },
  });
  const benefitIds = benefits.map((b) => b.id);

  for (const code of planCodes) {
    const plan = await prisma.plan.findUnique({ where: { code } });
    if (!plan) continue;
    await prisma.payment.deleteMany({ where: { planId: code } });
    await prisma.subscription.deleteMany({ where: { planId: code } });
    await prisma.planBenefit.deleteMany({ where: { planId: plan.id } });
  }
  if (benefitIds.length) {
    await prisma.planBenefit.deleteMany({ where: { benefitId: { in: benefitIds } } });
    await prisma.benefit.deleteMany({ where: { id: { in: benefitIds } } });
  }
  for (const code of planCodes) {
    const plan = await prisma.plan.findUnique({ where: { code } });
    if (!plan) continue;
    await prisma.planPrice.deleteMany({ where: { planId: plan.id } });
    await prisma.plan.delete({ where: { id: plan.id } });
  }
  invalidatePlanCache();
};
