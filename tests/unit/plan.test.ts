// Prisma fully mocked — this proves the pricing/entitlement logic, not the DB.
const db = {
  plan: { findMany: jest.fn(), findUnique: jest.fn() },
  benefit: { findUnique: jest.fn() },
  subscription: { count: jest.fn() },
  payment: { findMany: jest.fn() },
};
jest.mock('../../src/config/database', () => ({ prisma: db }));

import {
  getPurchasablePlans, resolvePlan, priceForSubscription,
  findByPaystackPlanCode, checkCapacity, invalidatePlanCache,
} from '../../src/services/plan';

const price = (interval: string, amount: number, days: number, active = true) => ({
  id: `price-${interval}`, interval, amount, durationDays: days,
  paystackPlanCode: `PLN_${interval}`, isActive: active,
});

const planRow = (over: any = {}) => ({
  id: 'p1', code: 'premium', name: 'Premium', description: null, keywords: [],
  maxSubscribers: null, isActive: true, sortOrder: 1,
  prices: [price('MONTHLY', 500000, 30), price('ANNUAL', 5000000, 365)],
  benefits: [{ benefit: { code: 'g1', type: 'WHATSAPP_GROUP', name: 'Group 1', inviteLink: 'https://x', isActive: true } }],
  ...over,
});

beforeEach(() => { jest.clearAllMocks(); invalidatePlanCache(); });

describe('plan resolution', () => {
  it('exposes only plans that are active AND have an active price', async () => {
    db.plan.findMany.mockResolvedValue([
      planRow(),
      planRow({ id: 'p2', code: 'retired', isActive: false }),
      planRow({ id: 'p3', code: 'nopricing', prices: [price('MONTHLY', 1, 30, false)] }),
    ]);
    const codes = (await getPurchasablePlans()).map((p) => p.code);
    expect(codes).toEqual(['premium']);
  });

  it('still resolves a retired plan so existing subscribers can renew', async () => {
    db.plan.findMany.mockResolvedValue([planRow({ code: 'retired', isActive: false })]);
    expect(await resolvePlan('retired')).toBeDefined();
  });

  it('only surfaces group links that actually have a URL', async () => {
    db.plan.findMany.mockResolvedValue([planRow({ benefits: [
      { benefit: { code: 'a', type: 'WHATSAPP_GROUP', name: 'A', inviteLink: 'https://a', isActive: true } },
      { benefit: { code: 'b', type: 'WHATSAPP_GROUP', name: 'B', inviteLink: null, isActive: true } },
      { benefit: { code: 'c', type: 'EVENT_ACCESS', name: 'VIP', inviteLink: null, isActive: true } },
    ]})]);
    const plan = await resolvePlan('premium');
    expect(plan!.groupLinks).toHaveLength(1);
    expect(plan!.benefits).toHaveLength(3);
  });
});

describe('pricing', () => {
  beforeEach(() => db.plan.findMany.mockResolvedValue([planRow()]));

  it('charges the interval actually purchased', async () => {
    const p = await priceForSubscription('premium', 'price-ANNUAL');
    expect(p!.durationDays).toBe(365);
    expect(p!.amount).toBe(5000000);
  });

  it('falls back to the default price for rows predating tiered pricing', async () => {
    const p = await priceForSubscription('premium', null);
    expect(p!.interval).toBe('MONTHLY');
  });

  it('maps a paystack plan code back to its plan and interval', async () => {
    const m = await findByPaystackPlanCode('PLN_ANNUAL');
    expect(m!.plan.code).toBe('premium');
    expect(m!.price.interval).toBe('ANNUAL');
  });
});

describe('capacity', () => {
  it('treats an uncapped plan as always available without querying', async () => {
    db.plan.findMany.mockResolvedValue([planRow({ maxSubscribers: null })]);
    const cap = await checkCapacity('premium');
    expect(cap.hasCapacity).toBe(true);
    expect(db.subscription.count).not.toHaveBeenCalled();
  });

  it('counts a member with several pending checkouts as one seat', async () => {
    db.plan.findMany.mockResolvedValue([planRow({ maxSubscribers: 100 })]);
    db.subscription.count.mockResolvedValue(10);
    // distinct: ['userId'] — five rows collapse to two members.
    db.payment.findMany.mockResolvedValue([{ userId: 'u1' }, { userId: 'u2' }]);

    const cap = await checkCapacity('premium');
    expect(cap.used).toBe(12);
    expect(cap.remaining).toBe(88);
    expect(db.payment.findMany).toHaveBeenCalledWith(expect.objectContaining({ distinct: ['userId'] }));
  });

  it('reports no capacity once the limit is reached', async () => {
    db.plan.findMany.mockResolvedValue([planRow({ maxSubscribers: 2 })]);
    db.subscription.count.mockResolvedValue(2);
    db.payment.findMany.mockResolvedValue([]);
    const cap = await checkCapacity('premium');
    expect(cap.hasCapacity).toBe(false);
    expect(cap.remaining).toBe(0);
  });
});
