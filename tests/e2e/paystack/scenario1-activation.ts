/**
 * Scenario 1 — new member subscribes and is activated by a real Paystack charge.
 *
 *   npx ts-node tests/e2e/paystack/scenario1-activation.ts
 *
 * Drives the real backend and real Paystack test mode. Steps 1–4 are pure API.
 * Step 5 (card entry) happens on Paystack's hosted page, because the reference
 * subscribe minted cannot be charged server-side — see subscribe() in client.ts.
 * The script prints the checkout URL and then blocks, polling the database until
 * the webhook lands, so the browser step can happen while it waits.
 *
 * Everything it creates is tagged and removed by cleanup.ts.
 */
import { prisma } from '../../../src/config/database';
import {
  register, login, listPlans, subscribe, me, waitFor, webhookEvents,
} from './client';

const PLAN = process.env.E2E_PLAN || 'testhealth';
// How long to hold the checkout page open before giving up on the card step.
const PAY_TIMEOUT_MS = Number(process.env.E2E_PAY_TIMEOUT || 300_000);

const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const info = (m: string) => console.log(`  \x1b[2m${m}\x1b[0m`);
const step = (m: string) => console.log(`\n\x1b[1m${m}\x1b[0m`);

async function main() {
  const startedAt = new Date();

  step('1. Register a member');
  const member = await register();
  ok(`registered ${member.email}`);
  const created = await prisma.user.findUniqueOrThrow({ where: { id: member.userId } });
  if (!created.memberId) throw new Error('member_id was not assigned at registration');
  ok(`member_id assigned: ${created.memberId}`);

  step('2. Log in with those credentials');
  const token = await login(member.email);
  ok('login returned a session token');

  step('3. Fetch the plan catalogue');
  const plans = await listPlans(token);
  info(`plans: ${plans.map((p: any) => p.code).join(', ')}`);
  const plan = plans.find((p: any) => p.code === PLAN);
  if (!plan) throw new Error(`plan ${PLAN} is not purchasable — seed it first`);
  const price = plan.prices[0];
  ok(`${PLAN}: ${price.interval} NGN ${(price.amount / 100).toLocaleString()}`);

  step('4. Start checkout');
  const { reference, authorizationUrl } = await subscribe(token, PLAN, price.interval);
  ok(`reference ${reference}`);

  const pending = await prisma.payment.findUniqueOrThrow({ where: { reference } });
  if (pending.status !== 'PENDING') throw new Error(`expected PENDING payment, got ${pending.status}`);
  ok('payment row created as PENDING');

  step('5. Pay on Paystack (hosted page)');
  console.log(`\n     ${authorizationUrl}\n`);
  info('test card 4084 0840 8408 4081 · cvv 408 · exp 12/30 · pin 0000 · otp 123456');
  info(`waiting up to ${PAY_TIMEOUT_MS / 1000}s for the charge.success webhook…`);

  const activated = await waitFor(
    'subscription to be activated by webhook',
    async () => {
      const sub = await prisma.subscription.findFirst({ where: { userId: member.userId } });
      return sub && sub.status === 'ACTIVE' ? sub : null;
    },
    { timeoutMs: PAY_TIMEOUT_MS, intervalMs: 3_000 },
  );

  step('6. Assert the resulting state');

  const paid = await prisma.payment.findUniqueOrThrow({ where: { reference } });
  if (paid.status !== 'SUCCESS') throw new Error(`payment is ${paid.status}, expected SUCCESS`);
  ok('payment marked SUCCESS');

  if (activated.planId !== PLAN) throw new Error(`subscription is for ${activated.planId}`);
  ok(`subscription ACTIVE on ${activated.planId}`);

  // The whole point of the hourly plan: one period is one hour, so activation
  // should land ~1h out rather than a month.
  const hours = (+activated.expiryDate - Date.now()) / 3_600_000;
  const expectedHours = price.durationDays * 24;
  if (Math.abs(hours - expectedHours) > 0.2) {
    throw new Error(`expiry is ${hours.toFixed(3)}h out, expected ~${expectedHours}h`);
  }
  ok(`expiry_date ≈ +${hours.toFixed(3)}h (one ${price.interval} period)`);

  if (!activated.graceEndDate) throw new Error('grace_end_date was not set');
  const graceDays = (+activated.graceEndDate - +activated.expiryDate) / 86_400_000;
  ok(`grace_end_date is +${graceDays.toFixed(0)}d past expiry`);

  // Required for scenario 2: without a subscription code Paystack never bills a
  // second cycle, so no renewal event could ever arrive.
  if (!activated.paystackSubscriptionCode) {
    throw new Error('no paystack_subscription_code stored — recurring billing will never happen');
  }
  ok(`paystack_subscription_code ${activated.paystackSubscriptionCode}`);
  if (!activated.paystackEmailToken) throw new Error('no paystack_email_token stored');
  ok('paystack_email_token stored (needed to disable/cancel upstream)');

  const view = await me(token);
  if (view.subscriptions.length !== 1) throw new Error(`/me shows ${view.subscriptions.length} subscriptions`);
  ok('/api/users/me reflects exactly one subscription');

  step('7. Events captured');
  const events = await webhookEvents(startedAt);
  for (const e of events) {
    console.log(`  ${e.eventType.padEnd(22)} processed=${String(e.processed).padEnd(5)} ${e.error ?? ''}`);
  }

  console.log(`\n\x1b[1mScenario 1 passed.\x1b[0m`);
  console.log(`  member         ${member.email}`);
  console.log(`  subscription   ${activated.id}`);
  console.log(`  paystack code  ${activated.paystackSubscriptionCode}`);
  console.log(`  expires        ${activated.expiryDate.toISOString()}`);
  console.log(`\nFor scenario 2, watch this subscription renew:`);
  console.log(`  E2E_SUBSCRIPTION=${activated.id} npx ts-node tests/e2e/paystack/scenario2-renewal.ts\n`);
}

main()
  .catch((e) => {
    console.error(`\n\x1b[31m✗ ${e.message}\x1b[0m\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
