const mockClient = { get: jest.fn(), post: jest.fn() };
jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => mockClient) },
  create: jest.fn(() => mockClient),
}));

import { prisma } from '../src/config/database';
import { runExpirySweep } from '../src/services/subscription';
import { getPendingRemovals } from '../src/services/removal';
import { checkCapacity, invalidatePlanCache } from '../src/services/plan';
import { makeUser, makeTestPlan, cleanupAll } from '../helpers';

const A = 'jestlifea';   // grants group 1
const B = 'jestlifeb';   // capped

beforeAll(async () => {
  await cleanupAll([A, B]);
  await makeTestPlan({ code: A, prices: [{ interval: 'MONTHLY', amount: 100, durationDays: 30 }] });
  await makeTestPlan({ code: B, maxSubscribers: 2, prices: [{ interval: 'MONTHLY', amount: 100, durationDays: 30 }] });
});
afterAll(async () => { await cleanupAll([A, B]); await prisma.$disconnect(); });
beforeEach(() => { jest.clearAllMocks(); mockClient.post.mockResolvedValue({ data: { data: {} } }); invalidatePlanCache(); });

const makeSub = async (userId: string, planCode: string, over: Record<string, any> = {}) =>
  prisma.subscription.create({
    data: {
      userId, planId: planCode, status: 'ACTIVE', channel: 'WEB',
      startDate: new Date(Date.now() - 40 * 86400000),
      expiryDate: new Date(Date.now() - 86400000),   // expired yesterday
      graceEndDate: new Date(Date.now() + 2 * 86400000),
      ...over,
    },
  });

describe('expiry sweep', () => {
  it('moves an expired ACTIVE subscription to GRACE', async () => {
    const user = await makeUser();
    const sub = await makeSub(user.id, A);

    await runExpirySweep();

    const after = await prisma.subscription.findUnique({ where: { id: sub.id } });
    expect(after!.status).toBe('GRACE');
  });

  it('expires a subscription once its grace window closes', async () => {
    const user = await makeUser();
    const sub = await makeSub(user.id, A, {
      status: 'GRACE', graceEndDate: new Date(Date.now() - 86400000),
    });

    await runExpirySweep();

    const after = await prisma.subscription.findUnique({ where: { id: sub.id } });
    expect(after!.status).toBe('EXPIRED');
  });

  it('is safe to run twice — the second pass changes nothing', async () => {
    const user = await makeUser();
    const sub = await makeSub(user.id, A);

    const first = await runExpirySweep();
    const state = await prisma.subscription.findUnique({ where: { id: sub.id } });
    const second = await runExpirySweep();
    const stateAgain = await prisma.subscription.findUnique({ where: { id: sub.id } });

    expect(first.movedToGrace).toBeGreaterThanOrEqual(1);
    expect(stateAgain!.status).toBe(state!.status);
    expect(second.movedToGrace).toBe(0);
  });

  it('leaves a subscription that has not expired alone', async () => {
    const user = await makeUser();
    const sub = await makeSub(user.id, A, { expiryDate: new Date(Date.now() + 10 * 86400000) });

    await runExpirySweep();

    const after = await prisma.subscription.findUnique({ where: { id: sub.id } });
    expect(after!.status).toBe('ACTIVE');
  });
});

describe('capacity accounting', () => {
  it('counts a member with several abandoned checkouts as one seat', async () => {
    const user = await makeUser();
    for (let i = 0; i < 5; i++) {
      await prisma.payment.create({ data: {
        userId: user.id, reference: `CAPTEST_${Date.now()}_${i}`, amount: 100,
        planId: B, status: 'PENDING', channel: 'WEB' } });
    }

    const cap = await checkCapacity(B);
    expect(cap.used).toBe(1);
  });

  it('reports a plan as full once live subscribers reach the limit', async () => {
    const u1 = await makeUser();
    const u2 = await makeUser();
    await makeSub(u1.id, B, { status: 'ACTIVE', expiryDate: new Date(Date.now() + 86400000) });
    await makeSub(u2.id, B, { status: 'GRACE', expiryDate: new Date(Date.now() + 86400000) });

    const cap = await checkCapacity(B);
    expect(cap.hasCapacity).toBe(false);
    expect(cap.remaining).toBe(0);
  });
});

describe('removal entitlements', () => {
  it('does not revoke a group the member still gets from another live plan', async () => {
    // Both plans grant the SAME benefit — the overlap case that would otherwise
    // cut off a paying subscriber.
    const shared = await prisma.benefit.findFirst({ where: { code: `${A}-group-1` } });
    const planB = await prisma.plan.findUnique({ where: { code: B } });
    await prisma.planBenefit.create({ data: { planId: planB!.id, benefitId: shared!.id } });
    invalidatePlanCache();

    const user = await makeUser();
    await makeSub(user.id, A, { status: 'EXPIRED' });                                    // lapsed
    await makeSub(user.id, B, { status: 'ACTIVE', expiryDate: new Date(Date.now() + 86400000) }); // live

    const pending = await getPendingRemovals();
    const row = pending.find((p) => p.userId === user.id);

    expect(row).toBeDefined();
    expect(row!.removeFrom).toHaveLength(0);
    expect(row!.keepIn).toContain(`${A} Group 1`);
  });

  it('revokes a group when no live plan grants it', async () => {
    const user = await makeUser();
    await makeSub(user.id, A, { status: 'EXPIRED' });

    const pending = await getPendingRemovals();
    const row = pending.find((p) => p.userId === user.id);

    expect(row!.removeFrom).toContain(`${A} Group 1`);
  });
});
