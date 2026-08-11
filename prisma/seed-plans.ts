// Seeds the Plan / PlanPrice / Benefit tables.
//
//   npx ts-node prisma/seed-plans.ts
//
// Idempotent (upsert by code) — safe to re-run after editing values here.
//
// This file is the declarative source for plans: edit it and re-run to apply.
// Values are literal rather than read from env — plans live in the database now,
// and an env indirection would mean a re-run silently reverted anything an
// operator changed there. premium and apex are seeded INACTIVE
// because their Paystack plan codes don't exist yet; fill in the real codes and
// flip isActive to make them purchasable.
import { PrismaClient, BillingInterval, BenefitType } from '@prisma/client';

const prisma = new PrismaClient();

// Placeholder Paystack codes — replace with real ones before activating.
const TODO = (slug: string) => `PLN_TODO_${slug}`;

const BENEFITS = [
  {
    code: 'group-wealth',
    type: BenefitType.WHATSAPP_GROUP,
    name: 'Wealth Group',
    inviteLink: 'https://chat.whatsapp.com/IpXuZdgcQnT2R3qhQavmYz?s=sh&p=a&ilr=1',
  },
  {
    code: 'group-health',
    type: BenefitType.WHATSAPP_GROUP,
    name: 'Health Group',
    inviteLink: 'https://chat.whatsapp.com/JcCTGFHk5qD0SBBg5vPu2D?s=sh&p=a&ilr=1',
  },
  // Premium's five groups — links are placeholders.
  ...[1, 2, 3, 4, 5].map((n) => ({
    code: `group-premium-${n}`,
    type: BenefitType.WHATSAPP_GROUP,
    name: `Premium Group ${n}`,
    inviteLink: null,
  })),
  {
    // Granted to every member on registration — deliberately NOT attached to any
    // plan, so it is never revoked by the expiry/removal flow.
    code: 'group-free',
    type: BenefitType.WHATSAPP_GROUP,
    name: 'ZuriCircle Community',
    inviteLink: 'https://chat.whatsapp.com/Jf3dKQnBYQNAcnaDqtOgPe?mode=wwt',
  },
  {
    code: 'event-apex-vip',
    type: BenefitType.EVENT_ACCESS,
    name: 'Apex VIP Event Access',
    inviteLink: null,
  },
];

const PLANS = [
  {
    // Short-cycle plan for exercising the renewal/expiry cycle in minutes rather
    // than a month. Billed HOURLY on Paystack, so a subscriber is charged every
    // hour until the subscription is disabled. Shares the real Health group.
    code: 'testhealth',
    name: 'Test Health Plan (hourly)',
    description: 'Hourly-billed test plan — exercises renewal and expiry quickly',
    keywords: [],
    maxSubscribers: null,
    isActive: true,
    sortOrder: 10,
    benefits: ['group-health'],
    prices: [
      {
        interval: BillingInterval.HOURLY,
        amount: 50_000,
        durationDays: 1 / 24,
        paystackPlanCode: 'PLN_azvce33l103g6db',
        isActive: true,
      },
    ],
  },
  {
    code: 'wealth',
    name: 'Wealth Plan',
    description: 'Access to Wealth building tips and exclusive group',
    keywords: ['JOIN WEALTH', 'WEALTH'],
    maxSubscribers: null,
    isActive: true,
    sortOrder: 1,
    benefits: ['group-wealth'],
    prices: [
      {
        interval: BillingInterval.MONTHLY,
        amount: 50_000,
        durationDays: 30,
        paystackPlanCode: 'PLN_aj0rq5xto2cod3i',
        isActive: true,
      },
    ],
  },
  {
    code: 'health',
    name: 'Health Plan',
    description: 'Access to Health tips and exclusive group',
    keywords: ['JOIN HEALTH', 'HEALTH'],
    maxSubscribers: null,
    isActive: true,
    sortOrder: 2,
    benefits: ['group-health'],
    prices: [
      {
        interval: BillingInterval.MONTHLY,
        amount: 30_000,
        durationDays: 30,
        paystackPlanCode: 'PLN_rvnrbsb7p11efzo',
        isActive: true,
      },
    ],
  },
  {
    code: 'premium',
    name: 'Premium Plan',
    description: 'Access to all five premium groups',
    keywords: ['JOIN PREMIUM', 'PREMIUM'],
    maxSubscribers: null,
    isActive: false, // no Paystack codes yet
    sortOrder: 3,
    benefits: ['group-premium-1', 'group-premium-2', 'group-premium-3', 'group-premium-4', 'group-premium-5'],
    prices: [
      { interval: BillingInterval.MONTHLY, amount: 500_000, durationDays: 30, paystackPlanCode: TODO('PREMIUM_MONTHLY'), isActive: false },
      { interval: BillingInterval.SEMIANNUAL, amount: 3_000_000, durationDays: 180, paystackPlanCode: TODO('PREMIUM_SEMIANNUAL'), isActive: false },
      { interval: BillingInterval.ANNUAL, amount: 5_000_000, durationDays: 365, paystackPlanCode: TODO('PREMIUM_ANNUAL'), isActive: false },
    ],
  },
  {
    code: 'apex',
    name: 'Apex Plan',
    description: 'Everything in Premium, plus the Health and Wealth groups and VIP event access',
    keywords: ['JOIN APEX', 'APEX'],
    maxSubscribers: 100,
    isActive: false, // no Paystack codes yet
    sortOrder: 4,
    // Apex is a superset: every Premium group, both standalone groups, and the
    // event. These reference the SAME benefit rows the other plans use, so a
    // link only ever needs changing in one place.
    benefits: [
      'group-premium-1', 'group-premium-2', 'group-premium-3', 'group-premium-4', 'group-premium-5',
      'group-health', 'group-wealth', 'event-apex-vip',
    ],
    prices: [
      { interval: BillingInterval.MONTHLY, amount: 1_200_000, durationDays: 30, paystackPlanCode: TODO('APEX_MONTHLY'), isActive: false },
      { interval: BillingInterval.SEMIANNUAL, amount: 6_000_000, durationDays: 180, paystackPlanCode: TODO('APEX_SEMIANNUAL'), isActive: false },
      { interval: BillingInterval.ANNUAL, amount: 10_000_000, durationDays: 365, paystackPlanCode: TODO('APEX_ANNUAL'), isActive: false },
    ],
  },
];

async function main() {
  const benefitIds = new Map<string, string>();

  for (const b of BENEFITS) {
    const row = await prisma.benefit.upsert({
      where: { code: b.code },
      update: { type: b.type, name: b.name, inviteLink: b.inviteLink },
      create: { code: b.code, type: b.type, name: b.name, inviteLink: b.inviteLink },
    });
    benefitIds.set(b.code, row.id);
  }
  console.log(`benefits: ${BENEFITS.length} upserted`);

  for (const p of PLANS) {
    const plan = await prisma.plan.upsert({
      where: { code: p.code },
      update: {
        name: p.name,
        description: p.description,
        keywords: p.keywords,
        maxSubscribers: p.maxSubscribers,
        isActive: p.isActive,
        sortOrder: p.sortOrder,
      },
      create: {
        code: p.code,
        name: p.name,
        description: p.description,
        keywords: p.keywords,
        maxSubscribers: p.maxSubscribers,
        isActive: p.isActive,
        sortOrder: p.sortOrder,
      },
    });

    for (const price of p.prices) {
      await prisma.planPrice.upsert({
        where: { planId_interval: { planId: plan.id, interval: price.interval } },
        update: {
          amount: price.amount,
          durationDays: price.durationDays,
          paystackPlanCode: price.paystackPlanCode,
          isActive: price.isActive,
        },
        create: { planId: plan.id, ...price },
      });
    }

    // Replace the benefit set so removing one here removes it in the DB.
    await prisma.planBenefit.deleteMany({ where: { planId: plan.id } });
    await prisma.planBenefit.createMany({
      data: p.benefits.map((code) => ({ planId: plan.id, benefitId: benefitIds.get(code)! })),
      skipDuplicates: true,
    });

    console.log(
      `plan ${p.code.padEnd(8)} active=${String(p.isActive).padEnd(5)} ` +
        `prices=${p.prices.length} benefits=${p.benefits.length} cap=${p.maxSubscribers ?? '-'}`,
    );
  }

  const orphans = await prisma.$queryRawUnsafe<{ plan_id: string }[]>(
    `SELECT DISTINCT s.plan_id FROM subscriptions s
     LEFT JOIN plans p ON p.code = s.plan_id WHERE p.id IS NULL`,
  );
  if (orphans.length) {
    console.warn(
      `\n⚠️  subscriptions reference plan codes with no Plan row: ${orphans
        .map((o) => o.plan_id)
        .join(', ')} — add them (isActive=false) so renewals resolve.`,
    );
  } else {
    console.log('\nAll existing subscriptions resolve to a seeded plan.');
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
