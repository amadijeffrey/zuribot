/**
 * Scenario 2 — a real Paystack recurring charge extends expiry_date.
 *
 *   E2E_SUBSCRIPTION=<id> npx ts-node tests/e2e/paystack/scenario2-renewal.ts
 *
 * The question this suite exists to answer: when a recurring charge lands, does
 * expiry actually move — by one period, exactly once?
 *
 * WHY THIS DRIVES THE CHARGE INSTEAD OF WAITING FOR PAYSTACK'S CRON
 * ----------------------------------------------------------------
 * The first version of this script waited ~1h for the hourly plan's own billing
 * cycle. Paystack ran it on schedule and it FAILED:
 *
 *   invoice.payment_failed — transaction.status "failed", paid 0, description null
 *   authorization: { reusable: true, last4 "4081", bank "TEST BANK" }
 *
 * The authorization was reusable and chargeable — the very same authorization
 * charged fine through /transaction/charge_authorization seconds later. Paystack's
 * test-mode subscription cron simply does not settle recurring charges. That is a
 * sandbox limitation, not a defect in the renewal code, and no amount of waiting
 * gets past it.
 *
 * So this charges the subscription's stored authorization directly. The charge is
 * real, it is Paystack-originated, and it arrives as a genuine charge.success
 * webhook with no subscription_code — which is the shape this account actually
 * receives for recurring charges (see the comment above handleRecurringCharge).
 * It resolves through tryRecurringRenewalFromCharge, matching on the stored
 * authorization code. Deterministic, ~30s, and it exercises the real path.
 *
 * STILL NOT COVERED HERE: the invoice.update path. That only fires when Paystack's
 * own cron settles, which test mode won't do — it belongs to the replay suite,
 * using the invoice payloads captured in webhook_logs.
 */
import { prisma } from '../../../src/config/database';
import { env } from '../../../src/config/env';
import { waitFor } from './client';

const SUBSCRIPTION_ID = process.env.E2E_SUBSCRIPTION;
const WEBHOOK_TIMEOUT_MS = Number(process.env.E2E_WEBHOOK_TIMEOUT || 120_000);
// After the first extension, watch for a second one (double-extension guard).
const SETTLE_MS = Number(process.env.E2E_SETTLE || 45_000);

const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const info = (m: string) => console.log(`  \x1b[2m${m}\x1b[0m`);
const step = (m: string) => console.log(`\n\x1b[1m${m}\x1b[0m`);

/** Charges a stored authorization — Paystack's own recurring-billing primitive. */
async function chargeAuthorization(email: string, amount: number, authorizationCode: string) {
  const res = await fetch('https://api.paystack.co/transaction/charge_authorization', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, amount: String(amount), authorization_code: authorizationCode }),
  });
  const body: any = await res.json();
  if (!body.status || body.data?.status !== 'success') {
    throw new Error(`charge_authorization failed: ${body.message} ${JSON.stringify(body.data ?? {})}`);
  }
  return { reference: body.data.reference as string, amount: body.data.amount as number };
}

async function main() {
  if (!SUBSCRIPTION_ID) throw new Error('set E2E_SUBSCRIPTION to the subscription id from scenario 1');
  const startedAt = new Date();

  step('1. Baseline');
  const before = await prisma.subscription.findUniqueOrThrow({
    where: { id: SUBSCRIPTION_ID },
    include: { user: true },
  });
  if (!before.paystackAuthorizationCode) {
    throw new Error('no stored authorization — cannot simulate a recurring charge');
  }
  const price = await prisma.planPrice.findFirstOrThrow({ where: { id: before.planPriceId ?? undefined } });
  const periodMs = price.durationDays * 86_400_000;

  info(`subscription ${before.id}`);
  info(`status       ${before.status}`);
  info(`expiry       ${before.expiryDate.toISOString()}`);
  info(`authorization ${before.paystackAuthorizationCode}`);
  info(`one period   ${(periodMs / 60_000).toFixed(1)} min`);

  // Captured before the charge: the extension base is the LATER of current
  // expiry and now, so a lapsed subscription renews a full period from today
  // rather than losing the gap.
  const expectedBase = Math.max(+before.expiryDate, Date.now());
  const lapsed = +before.expiryDate < Date.now();
  info(lapsed ? 'subscription has lapsed — expect extension from now' : 'still live — expect extension from expiry');

  step('2. Drive a real recurring charge');
  const charge = await chargeAuthorization(
    before.user.email!,
    price.amount,
    before.paystackAuthorizationCode,
  );
  ok(`Paystack charged ${charge.amount} — reference ${charge.reference}`);

  step('3. Wait for the webhook to apply it');
  const after = await waitFor(
    'expiry_date to advance',
    async () => {
      const now = await prisma.subscription.findUniqueOrThrow({ where: { id: SUBSCRIPTION_ID } });
      return +now.expiryDate !== +before.expiryDate ? now : null;
    },
    { timeoutMs: WEBHOOK_TIMEOUT_MS, intervalMs: 3_000 },
  );

  step('4. Assert the renewal');
  info(`expiry ${before.expiryDate.toISOString()} -> ${after.expiryDate.toISOString()}`);

  const expected = expectedBase + periodMs;
  const errMs = Math.abs(+after.expiryDate - expected);
  // Tolerance covers the gap between computing expectedBase and Paystack
  // settling the charge.
  if (errMs > 120_000) {
    throw new Error(
      `expiry is ${new Date(+after.expiryDate).toISOString()}, expected ~${new Date(expected).toISOString()} ` +
        `(off by ${(errMs / 1000).toFixed(0)}s)`,
    );
  }
  ok(`expiry advanced one period from ${lapsed ? 'now' : 'previous expiry'} (±${(errMs / 1000).toFixed(0)}s)`);

  if (after.status !== 'ACTIVE') throw new Error(`status is ${after.status}, expected ACTIVE`);
  ok(before.status === 'GRACE' ? 'status recovered GRACE -> ACTIVE' : 'status still ACTIVE');

  if (!after.graceEndDate || +after.graceEndDate <= +after.expiryDate) {
    throw new Error('grace_end_date did not follow the new expiry');
  }
  ok('grace_end_date moved with expiry');

  const renewal = await prisma.payment.findUnique({ where: { reference: charge.reference } });
  if (!renewal) throw new Error(`no payment row recorded for ${charge.reference}`);
  if (renewal.status !== 'SUCCESS') throw new Error(`renewal payment is ${renewal.status}`);
  if (renewal.subscriptionId !== after.id) throw new Error('renewal payment not linked to the subscription');
  ok('renewal payment recorded SUCCESS and linked to the subscription');

  step('5. Guard against double-extension');
  info(`holding ${(SETTLE_MS / 1000).toFixed(0)}s — a redelivery must not extend again`);
  const settleDeadline = Date.now() + SETTLE_MS;
  while (Date.now() < settleDeadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    const now = await prisma.subscription.findUniqueOrThrow({ where: { id: SUBSCRIPTION_ID } });
    if (+now.expiryDate !== +after.expiryDate) {
      throw new Error(
        `expiry moved again by ${((+now.expiryDate - +after.expiryDate) / 60_000).toFixed(1)} min — ` +
          `one payment extended the subscription twice`,
      );
    }
  }
  ok('expiry stable — no double-extension');

  step('6. Events captured this run');
  const events = await prisma.webhookLog.findMany({
    where: { createdAt: { gte: startedAt } },
    orderBy: { createdAt: 'asc' },
  });
  for (const e of events) {
    console.log(`  ${e.createdAt.toISOString().slice(11, 19)}  ${e.eventType.padEnd(24)} processed=${e.processed}`);
  }

  console.log('\n\x1b[1mScenario 2 passed — a real recurring charge extends expiry_date, once.\x1b[0m\n');
}

main()
  .catch((e) => {
    console.error(`\n\x1b[31m✗ ${e.message}\x1b[0m\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
