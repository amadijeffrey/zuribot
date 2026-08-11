// Paystack HTTP must never leave the test process.
const mockClient = { get: jest.fn(), post: jest.fn() };
jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => mockClient) },
  create: jest.fn(() => mockClient),
}));

import { prisma } from '../src/config/database';
import { processWebhookEvent } from '../src/services/payment';
import { invalidatePlanCache } from '../src/services/plan';
import { makeUser, makeTestPlan, chargeSuccess, cleanupAll } from '../helpers';

const PLAN = 'jestplan';
const CAPPED = 'jestcapped';

// Paystack responses the code depends on.
const paystackDefaults = () => {
  mockClient.post.mockImplementation(async (url: string) => {
    if (url === '/subscription') {
      // Must be unique per call: paystackSubscriptionCode is a unique column, and
      // reusing one code would fail the insert for reasons unrelated to the test.
      const code = `SUB_${Math.random().toString(36).slice(2, 12)}`;
      return { data: { data: { subscription_code: code, email_token: 'TOK_test' } } };
    }
    if (url === '/subscription/disable') return { data: { status: true } };
    if (url === '/refund') return { data: { status: true } };
    if (url === '/transaction/initialize') {
      return { data: { data: { authorization_url: 'https://pay.test/x', access_code: 'AC' } } };
    }
    return { data: { data: {} } };
  });
  mockClient.get.mockResolvedValue({ data: { data: {} } });
};

beforeAll(async () => {
  await cleanupAll([PLAN, CAPPED]);
  await makeTestPlan({ code: PLAN, prices: [
    { interval: 'MONTHLY', amount: 500_000, durationDays: 30 },
    { interval: 'ANNUAL', amount: 5_000_000, durationDays: 365 },
  ]});
  await makeTestPlan({ code: CAPPED, maxSubscribers: 1, prices: [
    { interval: 'MONTHLY', amount: 1_000_000, durationDays: 30 },
  ]});
});

afterAll(async () => {
  await cleanupAll([PLAN, CAPPED]);
  await prisma.$disconnect();
});

beforeEach(() => { jest.clearAllMocks(); paystackDefaults(); invalidatePlanCache(); });

const pendingPayment = async (userId: string, planCode: string, interval: 'MONTHLY'|'ANNUAL', ref: string) => {
  const plan = await prisma.plan.findUnique({ where: { code: planCode } });
  const price = await prisma.planPrice.findFirst({ where: { planId: plan!.id, interval } });
  return prisma.payment.create({
    data: { userId, reference: ref, amount: price!.amount, planId: planCode,
            planPriceId: price!.id, status: 'PENDING', channel: 'WEB' },
  });
};

describe('activation', () => {
  it('creates exactly one subscription for a successful charge', async () => {
    const user = await makeUser();
    const ref = `T_${Date.now()}_a`;
    await pendingPayment(user.id, PLAN, 'MONTHLY', ref);

    await processWebhookEvent({ event: 'charge.success', data: chargeSuccess({ reference: ref, amount: 500_000 }) });

    const subs = await prisma.subscription.findMany({ where: { userId: user.id } });
    expect(subs).toHaveLength(1);
    expect(subs[0].status).toBe('ACTIVE');
  });

  it('is idempotent — a redelivered charge does not create a second subscription', async () => {
    const user = await makeUser();
    const ref = `T_${Date.now()}_b`;
    await pendingPayment(user.id, PLAN, 'MONTHLY', ref);
    const evt = { event: 'charge.success', data: chargeSuccess({ reference: ref, amount: 500_000 }) };

    await processWebhookEvent(evt);
    await processWebhookEvent(evt);

    expect(await prisma.subscription.count({ where: { userId: user.id } })).toBe(1);
  });

  it('survives concurrent delivery (webhook + verify) without duplicating', async () => {
    const user = await makeUser();
    const ref = `T_${Date.now()}_c`;
    await pendingPayment(user.id, PLAN, 'MONTHLY', ref);
    const evt = { event: 'charge.success', data: chargeSuccess({ reference: ref, amount: 500_000 }) };

    await Promise.all([processWebhookEvent(evt), processWebhookEvent(evt)]);

    expect(await prisma.subscription.count({ where: { userId: user.id } })).toBe(1);
  });

  it('does NOT grant access when the amount is below the plan price', async () => {
    const user = await makeUser();
    const ref = `T_${Date.now()}_d`;
    await pendingPayment(user.id, PLAN, 'MONTHLY', ref);

    await processWebhookEvent({ event: 'charge.success', data: chargeSuccess({ reference: ref, amount: 100_000 }) });

    expect(await prisma.subscription.count({ where: { userId: user.id } })).toBe(0);
    const p = await prisma.payment.findUnique({ where: { reference: ref } });
    expect(p!.status).toBe('SUCCESS'); // money arrived; access withheld
  });

  it('does NOT grant access when the charge settled in another currency', async () => {
    const user = await makeUser();
    const ref = `T_${Date.now()}_e`;
    await pendingPayment(user.id, PLAN, 'MONTHLY', ref);

    await processWebhookEvent({ event: 'charge.success',
      data: chargeSuccess({ reference: ref, amount: 500_000, currency: 'KES' }) });

    expect(await prisma.subscription.count({ where: { userId: user.id } })).toBe(0);
  });

  it('grants the duration of the interval actually purchased', async () => {
    const user = await makeUser();
    const ref = `T_${Date.now()}_f`;
    await pendingPayment(user.id, PLAN, 'ANNUAL', ref);

    await processWebhookEvent({ event: 'charge.success', data: chargeSuccess({ reference: ref, amount: 5_000_000 }) });

    const sub = await prisma.subscription.findFirst({ where: { userId: user.id } });
    const days = Math.round((+sub!.expiryDate - Date.now()) / 86_400_000);
    expect(days).toBeGreaterThanOrEqual(364);
    expect(days).toBeLessThanOrEqual(366);
  });
});

describe('recurring renewal', () => {
  it('extends a subscription when the charge carries no subscription_code', async () => {
    const user = await makeUser();
    const ref = `T_${Date.now()}_g`;
    await pendingPayment(user.id, PLAN, 'MONTHLY', ref);
    await processWebhookEvent({ event: 'charge.success',
      data: chargeSuccess({ reference: ref, amount: 500_000, authorizationCode: 'AUTH_renew1', customerCode: 'CUS_renew1' }) });

    const before = await prisma.subscription.findFirst({ where: { userId: user.id } });
    const plan = await prisma.plan.findUnique({ where: { code: PLAN } });
    const price = await prisma.planPrice.findFirst({ where: { planId: plan!.id, interval: 'MONTHLY' } });

    // Paystack's recurring charge: new reference, no local payment, no sub code.
    await processWebhookEvent({ event: 'charge.success', data: chargeSuccess({
      reference: `PSK_${Date.now()}`, amount: 500_000,
      authorizationCode: 'AUTH_renew1', customerCode: 'CUS_renew1', planCode: price!.paystackPlanCode,
    })});

    const after = await prisma.subscription.findFirst({ where: { userId: user.id } });
    expect(+after!.expiryDate).toBeGreaterThan(+before!.expiryDate);
  });

  it('does not extend twice for the same transaction reference', async () => {
    const user = await makeUser();
    const ref = `T_${Date.now()}_h`;
    await pendingPayment(user.id, PLAN, 'MONTHLY', ref);
    await processWebhookEvent({ event: 'charge.success',
      data: chargeSuccess({ reference: ref, amount: 500_000, authorizationCode: 'AUTH_renew2', customerCode: 'CUS_renew2' }) });

    const plan = await prisma.plan.findUnique({ where: { code: PLAN } });
    const price = await prisma.planPrice.findFirst({ where: { planId: plan!.id, interval: 'MONTHLY' } });
    const recurring = chargeSuccess({ reference: `PSK_dup_${Date.now()}`, amount: 500_000,
      authorizationCode: 'AUTH_renew2', customerCode: 'CUS_renew2', planCode: price!.paystackPlanCode });

    await processWebhookEvent({ event: 'charge.success', data: recurring });
    const once = await prisma.subscription.findFirst({ where: { userId: user.id } });
    await processWebhookEvent({ event: 'charge.success', data: recurring });
    const twice = await prisma.subscription.findFirst({ where: { userId: user.id } });

    expect(+twice!.expiryDate).toBe(+once!.expiryDate);
  });

  it('refuses to revive a CANCELLED subscription and disables it upstream', async () => {
    const user = await makeUser();
    const ref = `T_${Date.now()}_i`;
    await pendingPayment(user.id, PLAN, 'MONTHLY', ref);
    await processWebhookEvent({ event: 'charge.success',
      data: chargeSuccess({ reference: ref, amount: 500_000, authorizationCode: 'AUTH_cancel1', customerCode: 'CUS_cancel1' }) });

    await prisma.subscription.updateMany({ where: { userId: user.id },
      data: { status: 'CANCELLED', paystackEmailToken: 'TOK' } });

    const plan = await prisma.plan.findUnique({ where: { code: PLAN } });
    const price = await prisma.planPrice.findFirst({ where: { planId: plan!.id, interval: 'MONTHLY' } });
    await processWebhookEvent({ event: 'charge.success', data: chargeSuccess({
      reference: `PSK_c_${Date.now()}`, amount: 500_000,
      authorizationCode: 'AUTH_cancel1', customerCode: 'CUS_cancel1', planCode: price!.paystackPlanCode })});

    const sub = await prisma.subscription.findFirst({ where: { userId: user.id } });
    expect(sub!.status).toBe('CANCELLED');
    expect(mockClient.post).toHaveBeenCalledWith('/subscription/disable', expect.anything());
  });
});

describe('capacity', () => {
  it('refunds instead of overselling a capped plan', async () => {
    const first = await makeUser();
    const ref1 = `T_${Date.now()}_j`;
    await pendingPayment(first.id, CAPPED, 'MONTHLY', ref1);
    await processWebhookEvent({ event: 'charge.success', data: chargeSuccess({ reference: ref1, amount: 1_000_000 }) });
    expect(await prisma.subscription.count({ where: { planId: CAPPED, status: 'ACTIVE' } })).toBe(1);

    // Seat is gone; this one paid anyway.
    const second = await makeUser();
    const ref2 = `T_${Date.now()}_k`;
    await pendingPayment(second.id, CAPPED, 'MONTHLY', ref2);
    await processWebhookEvent({ event: 'charge.success', data: chargeSuccess({ reference: ref2, amount: 1_000_000 }) });

    expect(await prisma.subscription.count({ where: { userId: second.id } })).toBe(0);
    expect(mockClient.post).toHaveBeenCalledWith('/refund', expect.objectContaining({ transaction: ref2 }));
    const p = await prisma.payment.findUnique({ where: { reference: ref2 } });
    expect(p!.status).toBe('REFUNDED');
  });
});

describe('grace-period renewal', () => {
  it('reactivates the EXISTING subscription rather than creating a second one', async () => {
    const user = await makeUser();
    const ref = `T_${Date.now()}_grace`;
    await pendingPayment(user.id, PLAN, 'MONTHLY', ref);
    await processWebhookEvent({ event: 'charge.success', data: chargeSuccess({ reference: ref, amount: 500_000 }) });

    const sub = await prisma.subscription.findFirstOrThrow({ where: { userId: user.id } });
    // Lapsed: expired yesterday, now inside the grace window.
    await prisma.subscription.update({
      where: { id: sub.id },
      data: { status: 'GRACE', expiryDate: new Date(Date.now() - 86_400_000) },
    });

    // The renewal payment is pre-linked to the subscription, as /renew creates it.
    const plan = await prisma.plan.findUnique({ where: { code: PLAN } });
    const price = await prisma.planPrice.findFirst({ where: { planId: plan!.id, interval: 'MONTHLY' } });
    const renewRef = `RNW_${Date.now()}`;
    await prisma.payment.create({ data: {
      userId: user.id, subscriptionId: sub.id, reference: renewRef, amount: price!.amount,
      planId: PLAN, planPriceId: price!.id, status: 'PENDING', channel: 'WEB' } });

    await processWebhookEvent({ event: 'charge.success', data: chargeSuccess({ reference: renewRef, amount: 500_000 }) });

    const all = await prisma.subscription.findMany({ where: { userId: user.id } });
    expect(all).toHaveLength(1);                       // same row, not a new one
    expect(all[0].id).toBe(sub.id);
    expect(all[0].status).toBe('ACTIVE');              // GRACE -> ACTIVE
    const days = Math.round((+all[0].expiryDate - Date.now()) / 86_400_000);
    expect(days).toBeGreaterThanOrEqual(29);           // a full fresh period
  });
});
