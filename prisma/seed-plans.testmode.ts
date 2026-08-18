// Seeds the plan catalogue with PAYSTACK TEST-MODE plan codes.
//
//   npx ts-node prisma/seed-plans.testmode.ts
//
// Companion to seed-plans.ts, which carries the live-mode codes. Paystack's test
// mode is a separate data space: the live codes in that file do not exist there,
// so recurring billing against them never produces a subscription or invoice
// event. Point DATABASE_URL at a test database before running this.
//
// Idempotent (upsert by code), and it reuses seed-plans.ts's benefit set and
// upsert logic so the two seeds cannot drift apart structurally.
//
// AMOUNTS MUST MATCH PAYSTACK EXACTLY. A recurring charge arrives with the
// amount configured on the Paystack plan, and applyRecurringRenewalToSubscription
// refuses to extend when `charge.amount < price.amount` — it alerts admins and
// drops the renewal. A local amount even slightly above the Paystack one turns
// every renewal into a silent no-op, which is exactly the bug this suite exists
// to catch, so it must not be introduced by the fixture itself.
import { BillingInterval } from '@prisma/client';
import { PlanSeed, runSeed } from './seed-plans';

// Placeholder codes for tiers with no test-mode plan yet. Seeded inactive, so
// they render in the catalogue but cannot be purchased.
const TODO = (slug: string) => `PLN_TESTTODO_${slug}`;

const TEST_PLANS: PlanSeed[] = [
  {
    // "ZCN test" on the Paystack dashboard — NGN 3,000.00, hourly.
    //
    // The renewal workhorse: an hourly cycle means Paystack emits a real
    // invoice.create / invoice.update / charge.success roughly an hour after
    // subscribing, instead of a month. This is the only way to observe a
    // genuine Paystack-driven renewal moving expiry_date.
    code: 'testhealth',
    name: 'ZCN test (hourly)',
    description: 'Hourly-billed test plan — exercises renewal and expiry quickly',
    keywords: [],
    maxSubscribers: null,
    isActive: true,
    sortOrder: 10,
    benefits: ['group-health'],
    prices: [
      {
        interval: BillingInterval.HOURLY,
        amount: 300_000, // NGN 3,000.00
        durationDays: 1 / 24,
        paystackPlanCode: 'PLN_xt19zozmdq0w0ja',
        isActive: true,
      },
    ],
  },
  {
    // "test" on the Paystack dashboard — NGN 2,000.00, hourly.
    //
    // A SECOND hourly plan, which the live seed has no equivalent of. Plan
    // changes (POST /users/subscriptions/:id/change) can only be exercised
    // between two purchasable plans, and doing that between two monthly plans
    // means waiting a month to see the follow-on renewal bill correctly.
    // Cheaper than testhealth, so it also covers the downgrade direction.
    code: 'testwealth',
    name: 'test (hourly)',
    description: 'Second hourly test plan — exercises plan changes and downgrades',
    keywords: [],
    maxSubscribers: null,
    isActive: true,
    sortOrder: 11,
    benefits: ['group-wealth'],
    prices: [
      {
        interval: BillingInterval.HOURLY,
        amount: 200_000, // NGN 2,000.00
        durationDays: 1 / 24,
        paystackPlanCode: 'PLN_ld1nxnyx6xbxl3v',
        isActive: true,
      },
    ],
  },
  {
    // "ZCN Wealth" — NGN 5,000.00, monthly.
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
        amount: 500_000, // NGN 5,000.00
        durationDays: 30,
        paystackPlanCode: 'PLN_p0icc9c5am05zf3',
        isActive: true,
      },
    ],
  },
  {
    // "ZCN Health" — NGN 5,000.00, monthly.
    //
    // Note this is priced the same as Wealth in test mode, whereas live has
    // Health cheaper. Anything asserting on relative price between the two will
    // not behave the same here.
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
        amount: 500_000, // NGN 5,000.00
        durationDays: 30,
        paystackPlanCode: 'PLN_72kec23v444xz48',
        isActive: true,
      },
    ],
  },
  {
    // No test-mode plan yet — inactive, same as live. Kept so the catalogue
    // shape matches production and any subscription referencing the code still
    // resolves to a plan at renewal.
    code: 'premium',
    name: 'Premium Plan',
    description: 'Access to all five premium groups',
    keywords: ['JOIN PREMIUM', 'PREMIUM'],
    maxSubscribers: null,
    isActive: false,
    sortOrder: 3,
    benefits: ['group-premium-1', 'group-premium-2', 'group-premium-3', 'group-premium-4', 'group-premium-5'],
    prices: [
      { interval: BillingInterval.MONTHLY, amount: 500_000, durationDays: 30, paystackPlanCode: TODO('PREMIUM_MONTHLY'), isActive: false },
      { interval: BillingInterval.SEMIANNUAL, amount: 3_000_000, durationDays: 180, paystackPlanCode: TODO('PREMIUM_SEMIANNUAL'), isActive: false },
      { interval: BillingInterval.ANNUAL, amount: 5_000_000, durationDays: 365, paystackPlanCode: TODO('PREMIUM_ANNUAL'), isActive: false },
    ],
  },
  {
    // Capped at 100 like live, so the oversell/refund path can be exercised by
    // lowering maxSubscribers rather than by seeding a different shape.
    code: 'apex',
    name: 'Apex Plan',
    description: 'Everything in Premium, plus the Health and Wealth groups and VIP event access',
    keywords: ['JOIN APEX', 'APEX'],
    maxSubscribers: 100,
    isActive: false,
    sortOrder: 4,
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

void runSeed(TEST_PLANS);
