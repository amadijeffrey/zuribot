// Does any work continue after processWebhookEvent() resolves?
// On serverless the function can be frozen the moment the handler returns, so
// anything still in flight would simply never happen.
const calls: string[] = [];
const mockClient = {
  get: jest.fn(async () => ({ data: { data: {} } })),
  post: jest.fn(async (url: string) => {
    calls.push(url);
    if (url === '/subscription') {
      return { data: { data: { subscription_code: `SUB_${Math.random().toString(36).slice(2,10)}`, email_token: 'T' } } };
    }
    return { data: { data: {} } };
  }),
};
jest.mock('axios', () => ({
  __esModule: true,
  default: { create: jest.fn(() => mockClient) },
  create: jest.fn(() => mockClient),
}));

import { prisma } from '../src/config/database';
import { processWebhookEvent } from '../src/services/payment';
import { invalidatePlanCache } from '../src/services/plan';
import { makeUser, makeTestPlan, chargeSuccess, cleanupAll } from '../helpers';

const PLAN = 'jestleak';

beforeAll(async () => {
  await cleanupAll([PLAN]);
  await makeTestPlan({ code: PLAN, prices: [{ interval: 'MONTHLY', amount: 1000, durationDays: 30 }] });
});
afterAll(async () => { await cleanupAll([PLAN]); await prisma.$disconnect(); });

it('completes all side effects before the handler resolves', async () => {
  invalidatePlanCache();
  const user = await makeUser();
  const plan = await prisma.plan.findUnique({ where: { code: PLAN } });
  const price = await prisma.planPrice.findFirst({ where: { planId: plan!.id } });
  const ref = `LEAK_${Date.now()}`;
  await prisma.payment.create({ data: {
    userId: user.id, reference: ref, amount: 1000, planId: PLAN,
    planPriceId: price!.id, status: 'PENDING', channel: 'WEB' } });

  calls.length = 0;
  await processWebhookEvent({ event: 'charge.success', data: chargeSuccess({ reference: ref, amount: 1000 }) });

  const atResolve = [...calls];
  // Give any detached promise a generous window to land.
  await new Promise((r) => setTimeout(r, 3000));
  const afterWait = [...calls];

  expect(afterWait).toEqual(atResolve);            // nothing arrived late
  expect(atResolve).toContain('/emails');          // the email DID happen in-band
});
