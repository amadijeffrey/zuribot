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

export const BENEFITS = [
  {
    code: 'group-wealth',
    type: BenefitType.WHATSAPP_GROUP,
    name: 'Wealth Group',
    inviteLink: 'https://chat.whatsapp.com/D8AMmpcI1usH5Glu6Oq1zm',
  },
  {
    code: 'group-health',
    type: BenefitType.WHATSAPP_GROUP,
    name: 'Health Group',
    inviteLink: 'https://chat.whatsapp.com/CSSdJsiVmCLIZjW87ySMBX',
  },
  // Premium's five groups. Apex references these same rows rather than
  // duplicating them, so a link only ever needs changing here.
  //
  // `name` is what appears on the join button in the activation email.
  ...[
    { name: 'ZCN SME Circle', inviteLink: 'https://chat.whatsapp.com/CXbl2qHuYdfEQ7HsTdv31D' },
    { name: 'ZCN Accelerator Circle', inviteLink: 'https://chat.whatsapp.com/B4wzmLd1FRx6CJggBcSeyp' },
    { name: 'ZCN Tech Circle', inviteLink: 'https://chat.whatsapp.com/LYtlMBtBo97B5HTkw0nnBW' },
    { name: 'ZCN New Mum Circle', inviteLink: 'https://chat.whatsapp.com/C72ugmO5mhiLmhCUq2L9Kq' },
    { name: "ZCN Founder's Circle", inviteLink: 'https://chat.whatsapp.com/I9o9a8PxqWUKd1qajRZ329' },
  ].map((g, i) => ({
    code: `group-premium-${i + 1}`,
    type: BenefitType.WHATSAPP_GROUP,
    ...g,
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
  {
    // Hosted in Supabase Storage (public bucket) rather than committed to the
    // repo: serverless bundles do not reliably include files read at runtime,
    // and this way the worksheet can be revised without a deploy.
    code: 'doc-90day-worksheet',
    type: BenefitType.DOCUMENT,
    name: '90-Day Execution Track & Goal-Bursting Worksheet',
    inviteLink:
      'https://cuykzhdgcfqhnmkmisox.supabase.co/storage/v1/object/public/documents/90-day-goalbursting-worksheet.docx',
  },
];

export type PlanSeed = {
  code: string;
  name: string;
  description: string;
  keywords: string[];
  maxSubscribers: number | null;
  isActive: boolean;
  sortOrder: number;
  benefits: string[];
  prices: {
    interval: BillingInterval;
    amount: number;
    durationDays: number;
    paystackPlanCode: string;
    isActive: boolean;
  }[];
};

const PLANS: PlanSeed[] = [
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
        amount: 25_000, // NGN 250.00 — "ZCN Wealth" on Paystack
        durationDays: 30,
        paystackPlanCode: 'PLN_fgu4k1uhkjgvrum',
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
        amount: 25_000, // NGN 250.00 — "ZCN Health" on Paystack
        durationDays: 30,
        paystackPlanCode: 'PLN_acn3k0dgfyg7uw2',
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
    isActive: true,
    sortOrder: 3,
    benefits: ['group-premium-1', 'group-premium-2', 'group-premium-3', 'group-premium-4', 'group-premium-5', 'doc-90day-worksheet'],
    prices: [
      // Amounts mirror Paystack EXACTLY. applyRecurringRenewalToSubscription
      // refuses to extend when the charge lands below the local price, so a
      // local amount even slightly high turns every renewal into a silent
      // no-op that alerts instead of granting time.
      { interval: BillingInterval.MONTHLY, amount: 50_000, durationDays: 30, paystackPlanCode: 'PLN_jw9nvc99wtbdg5c', isActive: true },
      { interval: BillingInterval.SEMIANNUAL, amount: 30_000, durationDays: 180, paystackPlanCode: 'PLN_v8ruhzvwbn02nym', isActive: true },
      // NOTE: annual is priced the same as monthly on Paystack (NGN 500). Copied
      // verbatim rather than "corrected" — the local value must match the plan
      // that actually gets charged. Fix it on Paystack first if it is wrong.
      { interval: BillingInterval.ANNUAL, amount: 50_000, durationDays: 365, paystackPlanCode: 'PLN_o2cg591162tdh18', isActive: true },
    ],
  },
  {
    code: 'apex',
    name: 'Apex Plan',
    description: 'Everything in Premium, plus the Health and Wealth groups and VIP event access',
    keywords: ['JOIN APEX', 'APEX'],
    maxSubscribers: 100,
    isActive: true,
    sortOrder: 4,
    // Apex is a superset: every Premium group, both standalone groups, and the
    // event. These reference the SAME benefit rows the other plans use, so a
    // link only ever needs changing in one place.
    benefits: [
      'group-premium-1', 'group-premium-2', 'group-premium-3', 'group-premium-4', 'group-premium-5',
      'group-health', 'group-wealth', 'event-apex-vip',
    ],
    prices: [
      { interval: BillingInterval.MONTHLY, amount: 12_000, durationDays: 30, paystackPlanCode: 'PLN_087swkc416kcfth', isActive: true },
      { interval: BillingInterval.SEMIANNUAL, amount: 60_000, durationDays: 180, paystackPlanCode: 'PLN_qj75sl13c2spc1f', isActive: true },
      { interval: BillingInterval.ANNUAL, amount: 100_000, durationDays: 365, paystackPlanCode: 'PLN_qstzg5wo2ojzgs3', isActive: true },
    ],
  },
];

// Applies a plan set to whatever database DATABASE_URL points at. Exported so
// the Paystack test-mode seed (seed-plans.testmode.ts) reuses this exact logic
// rather than keeping a second copy that can drift.
export async function applySeed(plans: PlanSeed[]) {
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

  for (const p of plans) {
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

/** Entry point shared by this file and the test-mode seed. */
export async function runSeed(plans: PlanSeed[]) {
  try {
    await applySeed(plans);
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

// Guarded so importing this module (for BENEFITS / applySeed) does not seed the
// live plan set as a side effect.
if (require.main === module) {
  void runSeed(PLANS);
}
