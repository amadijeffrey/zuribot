/**
 * Webhook replay suite — every Paystack event type, against the real endpoint.
 *
 *   npx ts-node tests/e2e/paystack/replay.ts            # all cases
 *   npx ts-node tests/e2e/paystack/replay.ts renewal    # only matching names
 *
 * Requires the backend running (npm run dev). No tunnel needed — these POST
 * straight to localhost, because the events originate here rather than at
 * Paystack.
 *
 * WHAT THIS IS AND IS NOT
 * -----------------------
 * Payloads are signed with the real PAYSTACK_SECRET_KEY and posted to the real
 * /paystack/webhook route, so the full path runs: HMAC verification, the replay
 * guard, express body parsing, the handlers, and the database writes. Nothing is
 * mocked or stubbed.
 *
 * What it cannot prove is that Paystack SENDS these shapes — see fixtures.ts,
 * where each builder records whether its shape was captured from a real delivery,
 * derived from one, or taken from documentation. Scenario 1 and 2 are what tie
 * the fixtures to reality; this suite is the fast regression net over them.
 *
 * State is built directly in the database rather than through checkout, because
 * these cases are about webhook handling, not about how the subscription came to
 * exist. Everything created is tagged and removed at the end.
 */
import crypto from 'crypto';
import { prisma } from '../../../src/config/database';
import { env } from '../../../src/config/env';
import { SubscriptionStatus } from '@prisma/client';
import { API, TAG, uniqueEmail, uniquePhone } from './client';
import * as fx from './fixtures';

const ENDPOINT = `${API}/paystack/webhook`;
const filter = process.argv[2];

// --- tiny harness -----------------------------------------------------------

let passed = 0;
let failed = 0;
let knownDefects = 0;
const failures: string[] = [];
const fixedDefects: string[] = [];

/**
 * `knownDefect` marks a test that asserts CORRECT behaviour the code does not
 * currently implement. It stays red without failing the run, so a real defect is
 * neither silently deleted nor left burying genuine regressions in noise. If it
 * starts passing, the run says so loudly — the marker is then stale and the test
 * should become an ordinary one.
 */
async function test(name: string, fn: () => Promise<void>, opts: { knownDefect?: string } = {}) {
  if (filter && !name.toLowerCase().includes(filter.toLowerCase())) return;
  try {
    await fn();
    if (opts.knownDefect) {
      console.log(`  \x1b[33m★\x1b[0m ${name}`);
      console.log(`      \x1b[33mknown defect appears FIXED — remove the knownDefect marker\x1b[0m`);
      fixedDefects.push(name);
    } else {
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
    }
    passed++;
  } catch (e: any) {
    if (opts.knownDefect) {
      console.log(`  \x1b[33m!\x1b[0m ${name} \x1b[2m(known defect)\x1b[0m`);
      console.log(`      \x1b[2m${opts.knownDefect}\x1b[0m`);
      console.log(`      \x1b[2m${e.message}\x1b[0m`);
      knownDefects++;
      return;
    }
    console.log(`  \x1b[31m✗\x1b[0m ${name}`);
    console.log(`      \x1b[31m${e.message}\x1b[0m`);
    failed++;
    failures.push(name);
  }
}

const group = (name: string) => console.log(`\n\x1b[1m${name}\x1b[0m`);

function assert(condition: any, message: string) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual: any, expected: any, what: string) {
  if (actual !== expected) throw new Error(`${what}: expected ${expected}, got ${actual}`);
}

/** Milliseconds apart, tolerant of processing time. */
function assertCloseTo(actual: number, expected: number, toleranceMs: number, what: string) {
  const diff = Math.abs(actual - expected);
  if (diff > toleranceMs) {
    throw new Error(`${what}: off by ${(diff / 1000).toFixed(1)}s (tolerance ${toleranceMs / 1000}s)`);
  }
}

// --- delivery ---------------------------------------------------------------

/**
 * Signs and POSTs an event exactly as Paystack would.
 *
 * The signature is an HMAC-SHA512 of the RAW BODY, so the same string that is
 * hashed must be the string that is sent — re-serialising would change key order
 * and invalidate it.
 */
async function deliver(event: any, opts: { signed?: boolean } = {}): Promise<number> {
  const raw = JSON.stringify(event);
  const signature =
    opts.signed === false
      ? 'deadbeef'
      : crypto.createHmac('sha512', env.PAYSTACK_SECRET_KEY).update(raw).digest('hex');

  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature },
    body: raw,
  });
  // The handler processes before responding, so by the time this resolves the
  // database writes have happened — no polling needed.
  await res.text();
  return res.status;
}

// --- fixtures in the database ----------------------------------------------

let seq = 0;
const uniq = () => `${Date.now()}${(seq++).toString().padStart(3, '0')}`;

// Supabase's transaction pooler drops idle connections under the rapid churn
// this suite creates, which surfaces as "Server has closed the connection"
// partway through a run. That is infrastructure flakiness, not a result, so
// transient connection errors are retried rather than reported as failures.
// Anything else propagates untouched — a genuine assertion or constraint error
// must never be retried into passing.
const TRANSIENT = /Server has closed the connection|Can't reach database server|Connection reset|ECONNRESET|kind: Closed/i;

async function db<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn();
    } catch (e: any) {
      lastError = e;
      if (!TRANSIENT.test(e?.message ?? '')) throw e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
  throw lastError;
}

async function makeMember() {
  return db(() =>
    prisma.user.create({
      data: {
        email: uniqueEmail(),
        phoneNumber: uniquePhone(),
        name: 'Replay Member',
        memberId: `ZCN-R${Math.random().toString(36).slice(2, 7).toUpperCase()}`,
      },
    }),
  );
}

type SubOpts = {
  planCode?: string;
  status?: SubscriptionStatus;
  /** Expiry relative to now. Negative = already lapsed. */
  expiresInMs?: number;
  subscriptionCode?: string;
  authorizationCode?: string;
  emailToken?: string | null;
  cancelAtPeriodEnd?: boolean;
};

/** A member holding a subscription, with the plan price resolved. */
async function makeSubscription(opts: SubOpts = {}) {
  const planCode = opts.planCode ?? 'testhealth';
  const plan = await db(() => prisma.plan.findUniqueOrThrow({ where: { code: planCode } }));
  const price = await db(() =>
    prisma.planPrice.findFirstOrThrow({ where: { planId: plan.id, isActive: true } }),
  );
  const user = await makeMember();

  const expiry = new Date(Date.now() + (opts.expiresInMs ?? 3_600_000));
  const subscription = await db(() => prisma.subscription.create({
    data: {
      userId: user.id,
      planId: planCode,
      planPriceId: price.id,
      status: opts.status ?? 'ACTIVE',
      channel: 'WEB',
      startDate: new Date(),
      expiryDate: expiry,
      graceEndDate: new Date(+expiry + 3 * 86_400_000),
      cancelAtPeriodEnd: opts.cancelAtPeriodEnd ?? false,
      paystackSubscriptionCode: opts.subscriptionCode ?? `SUB_replay${uniq()}`,
      paystackEmailToken: opts.emailToken === null ? null : opts.emailToken ?? `TOK_${uniq()}`,
      paystackAuthorizationCode: opts.authorizationCode ?? `AUTH_replay${uniq()}`,
      paystackCustomerCode: `CUS_replay${uniq()}`,
    },
  }));

  return { user, subscription, price, periodMs: price.durationDays * 86_400_000 };
}

const reload = (id: string) => db(() => prisma.subscription.findUniqueOrThrow({ where: { id } }));

const loadPayment = (reference: string) =>
  db(() => prisma.payment.findUniqueOrThrow({ where: { reference } }));

/** A payment row in a given state, as checkout or a renewal would have left it. */
async function makePayment(o: {
  userId: string;
  reference: string;
  amount: number;
  priceId: string;
  status: 'PENDING' | 'SUCCESS';
  subscriptionId?: string;
}) {
  return db(() =>
    prisma.payment.create({
      data: {
        userId: o.userId,
        reference: o.reference,
        amount: o.amount,
        planId: 'testhealth',
        planPriceId: o.priceId,
        status: o.status,
        channel: 'WEB',
        ...(o.subscriptionId ? { subscriptionId: o.subscriptionId } : {}),
      },
    }),
  );
}

// --- cases ------------------------------------------------------------------

async function run() {
  console.log(`\nReplaying against ${ENDPOINT}`);

  // =========================================================================
  group('Renewal via invoice.update — the production path');
  // =========================================================================

  await test('invoice.update success extends expiry by exactly one period', async () => {
    const { subscription, price, periodMs } = await makeSubscription();
    const before = subscription.expiryDate;

    const status = await deliver(
      fx.invoiceUpdateSuccess({
        subscriptionCode: subscription.paystackSubscriptionCode!,
        amount: price.amount,
        transactionReference: `RPL_${uniq()}`,
      }),
    );
    assertEqual(status, 200, 'response status');

    const after = await reload(subscription.id);
    assertCloseTo(+after.expiryDate, +before + periodMs, 60_000, 'new expiry');
    assertEqual(after.status, 'ACTIVE', 'status');
  });

  await test('invoice.update on a lapsed subscription extends from now, not stale expiry', async () => {
    const { subscription, price, periodMs } = await makeSubscription({
      status: 'GRACE',
      expiresInMs: -2 * 3_600_000, // lapsed two hours ago
    });

    await deliver(
      fx.invoiceUpdateSuccess({
        subscriptionCode: subscription.paystackSubscriptionCode!,
        amount: price.amount,
        transactionReference: `RPL_${uniq()}`,
      }),
    );

    const after = await reload(subscription.id);
    // From now, not from the two-hour-old expiry — otherwise the member pays for
    // a period that has already elapsed.
    assertCloseTo(+after.expiryDate, Date.now() + periodMs, 60_000, 'new expiry');
    assertEqual(after.status, 'ACTIVE', 'status recovered from GRACE');
  });

  await test('invoice.update then charge.success for one renewal extends only once', async () => {
    const { subscription, price, periodMs } = await makeSubscription();
    const before = subscription.expiryDate;
    const sharedReference = `RPL_dup_${uniq()}`;

    await deliver(
      fx.invoiceUpdateSuccess({
        subscriptionCode: subscription.paystackSubscriptionCode!,
        amount: price.amount,
        transactionReference: sharedReference,
      }),
    );
    const once = await reload(subscription.id);

    // The same renewal's charge.success, carrying the same transaction
    // reference. Dedupe is on that reference.
    await deliver(
      fx.chargeSuccess({
        reference: sharedReference,
        amount: price.amount,
        subscriptionCode: subscription.paystackSubscriptionCode!,
      }),
    );
    const twice = await reload(subscription.id);

    assertCloseTo(+once.expiryDate, +before + periodMs, 60_000, 'first extension');
    assertEqual(+twice.expiryDate, +once.expiryDate, 'expiry after the duplicate');
  });

  await test('invoice.update that did not succeed does not extend', async () => {
    const { subscription, price } = await makeSubscription();
    const before = subscription.expiryDate;

    await deliver(
      fx.invoiceUpdateFailed({
        subscriptionCode: subscription.paystackSubscriptionCode!,
        amount: price.amount,
        transactionReference: `RPL_${uniq()}`,
      }),
    );

    const after = await reload(subscription.id);
    assertEqual(+after.expiryDate, +before, 'expiry unchanged');
  });

  await test('renewal below the plan price does not extend', async () => {
    const { subscription, price } = await makeSubscription();
    const before = subscription.expiryDate;

    await deliver(
      fx.invoiceUpdateSuccess({
        subscriptionCode: subscription.paystackSubscriptionCode!,
        amount: Math.floor(price.amount / 2),
        transactionReference: `RPL_${uniq()}`,
      }),
    );

    const after = await reload(subscription.id);
    assertEqual(+after.expiryDate, +before, 'expiry unchanged after underpayment');
  });

  await test(
    'renewal in another currency does not extend',
    async () => {
      const { subscription, price } = await makeSubscription();
      const before = subscription.expiryDate;

      await deliver(
        fx.invoiceUpdateSuccess({
          subscriptionCode: subscription.paystackSubscriptionCode!,
          amount: price.amount,
          transactionReference: `RPL_${uniq()}`,
          currency: 'KES',
        }),
      );

      const after = await reload(subscription.id);
      assertEqual(+after.expiryDate, +before, 'expiry unchanged for foreign currency');
    },
    {
      knownDefect:
        'currencyMatches(data) reads data.currency, but invoice events carry it at ' +
        'data.transaction.currency — so the guard is inert on the invoice.update renewal path.',
    },
  );

  await test('renewal for a CANCELLED subscription does not revive it', async () => {
    const { subscription, price } = await makeSubscription({ status: 'CANCELLED' });
    const before = subscription.expiryDate;

    await deliver(
      fx.invoiceUpdateSuccess({
        subscriptionCode: subscription.paystackSubscriptionCode!,
        amount: price.amount,
        transactionReference: `RPL_${uniq()}`,
      }),
    );

    const after = await reload(subscription.id);
    assertEqual(after.status, 'CANCELLED', 'status');
    assertEqual(+after.expiryDate, +before, 'expiry unchanged');
  });

  await test('invoice.update for an unknown subscription_code is handled without error', async () => {
    const status = await deliver(
      fx.invoiceUpdateSuccess({
        subscriptionCode: 'SUB_does_not_exist_anywhere',
        amount: 300_000,
        transactionReference: `RPL_${uniq()}`,
      }),
    );
    assertEqual(status, 200, 'response status');
  });

  // =========================================================================
  group('Subscription lifecycle');
  // =========================================================================

  await test('subscription.create backfills the email token', async () => {
    const { subscription, user } = await makeSubscription({ emailToken: null });

    await deliver(
      fx.subscriptionCreate({
        subscriptionCode: subscription.paystackSubscriptionCode!,
        emailToken: 'TOK_backfilled',
        planCode: 'PLN_xt19zozmdq0w0ja',
        email: user.email!,
        customerCode: subscription.paystackCustomerCode!,
      }),
    );

    const after = await reload(subscription.id);
    assertEqual(after.paystackEmailToken, 'TOK_backfilled', 'email token');
  });

  await test('subscription.not_renew flags cancel-at-period-end without ending access', async () => {
    const { subscription } = await makeSubscription();

    await deliver(fx.subscriptionNotRenew({ subscriptionCode: subscription.paystackSubscriptionCode! }));

    const after = await reload(subscription.id);
    assertEqual(after.cancelAtPeriodEnd, true, 'cancelAtPeriodEnd');
    assertEqual(after.status, 'ACTIVE', 'status — the paid period must still run');
    assertEqual(+after.expiryDate, +subscription.expiryDate, 'expiry unchanged');
  });

  await test('subscription.disable cancels an active subscription', async () => {
    const { subscription } = await makeSubscription();

    await deliver(fx.subscriptionDisable({ subscriptionCode: subscription.paystackSubscriptionCode! }));

    const after = await reload(subscription.id);
    assertEqual(after.status, 'CANCELLED', 'status');
  });

  await test('subscription.disable does not overwrite an already EXPIRED subscription', async () => {
    const { subscription } = await makeSubscription({ status: 'EXPIRED' });

    await deliver(fx.subscriptionDisable({ subscriptionCode: subscription.paystackSubscriptionCode! }));

    const after = await reload(subscription.id);
    assertEqual(after.status, 'EXPIRED', 'status stays terminal');
  });

  await test('invoice.payment_failed moves an active subscription to GRACE', async () => {
    const { subscription, price } = await makeSubscription();

    await deliver(
      fx.invoicePaymentFailed({
        subscriptionCode: subscription.paystackSubscriptionCode!,
        amount: price.amount,
        transactionReference: `RPL_${uniq()}`,
      }),
    );

    const after = await reload(subscription.id);
    // Decline reason is unresolvable for a fabricated subscription code, and the
    // handler treats unknown reasons as transient rather than terminal.
    assertEqual(after.status, 'GRACE', 'status');
  });

  await test('invoice.create is accepted without changing subscription state', async () => {
    const { subscription, price } = await makeSubscription();

    const status = await deliver(
      fx.invoiceCreate({
        subscriptionCode: subscription.paystackSubscriptionCode!,
        amount: price.amount,
        transactionReference: `RPL_${uniq()}`,
      }),
    );

    const after = await reload(subscription.id);
    assertEqual(status, 200, 'response status');
    assertEqual(after.status, 'ACTIVE', 'status');
    assertEqual(+after.expiryDate, +subscription.expiryDate, 'expiry unchanged by a reminder');
  });

  // =========================================================================
  group('Charges, refunds and disputes');
  // =========================================================================

  await test('charge.failed marks the pending payment FAILED', async () => {
    const { user, price } = await makeSubscription();
    const reference = `RPL_fail_${uniq()}`;
    await makePayment({
      userId: user.id, reference, amount: price.amount, priceId: price.id, status: 'PENDING',
    });

    await deliver(fx.chargeFailed({ reference, amount: price.amount }));

    const payment = await loadPayment(reference);
    assertEqual(payment.status, 'FAILED', 'payment status');
  });

  await test('refund.processed refunds the payment and revokes access', async () => {
    const { user, subscription, price } = await makeSubscription();
    const reference = `RPL_refund_${uniq()}`;
    await makePayment({
      userId: user.id, reference, amount: price.amount, priceId: price.id,
      status: 'SUCCESS', subscriptionId: subscription.id,
    });

    await deliver(fx.refundProcessed({ transactionReference: reference, amount: price.amount }));

    const payment = await loadPayment(reference);
    const after = await reload(subscription.id);
    assertEqual(payment.status, 'REFUNDED', 'payment status');
    assertEqual(after.status, 'CANCELLED', 'subscription status');
  });

  await test('an opened dispute alerts but leaves access intact', async () => {
    const { user, subscription, price } = await makeSubscription();
    const reference = `RPL_disp_${uniq()}`;
    await makePayment({
      userId: user.id, reference, amount: price.amount, priceId: price.id,
      status: 'SUCCESS', subscriptionId: subscription.id,
    });

    await deliver(fx.disputeCreate({ transactionReference: reference, amount: price.amount }));

    const after = await reload(subscription.id);
    // A dispute can still be won — revoking now would punish a legitimate member.
    assertEqual(after.status, 'ACTIVE', 'status while the dispute is open');
  });

  await test('a dispute resolved against the merchant revokes access', async () => {
    const { user, subscription, price } = await makeSubscription();
    const reference = `RPL_lost_${uniq()}`;
    await makePayment({
      userId: user.id, reference, amount: price.amount, priceId: price.id,
      status: 'SUCCESS', subscriptionId: subscription.id,
    });

    await deliver(
      fx.disputeResolve({ transactionReference: reference, amount: price.amount, resolution: 'merchant-accepted' }),
    );

    const payment = await loadPayment(reference);
    const after = await reload(subscription.id);
    assertEqual(payment.status, 'REFUNDED', 'payment status');
    assertEqual(after.status, 'CANCELLED', 'subscription status');
  });

  await test('a dispute resolved in the merchant\'s favour leaves access intact', async () => {
    const { user, subscription, price } = await makeSubscription();
    const reference = `RPL_won_${uniq()}`;
    await makePayment({
      userId: user.id, reference, amount: price.amount, priceId: price.id,
      status: 'SUCCESS', subscriptionId: subscription.id,
    });

    await deliver(
      fx.disputeResolve({ transactionReference: reference, amount: price.amount, resolution: 'declined' }),
    );

    const payment = await loadPayment(reference);
    const after = await reload(subscription.id);
    assertEqual(payment.status, 'SUCCESS', 'payment status');
    assertEqual(after.status, 'ACTIVE', 'subscription status');
  });

  // =========================================================================
  group('Transport: signatures, replays, ordering');
  // =========================================================================

  await test('an unsigned event is rejected with 401', async () => {
    const { subscription, price } = await makeSubscription();
    const before = subscription.expiryDate;

    const status = await deliver(
      fx.invoiceUpdateSuccess({
        subscriptionCode: subscription.paystackSubscriptionCode!,
        amount: price.amount,
        transactionReference: `RPL_${uniq()}`,
      }),
      { signed: false },
    );

    const after = await reload(subscription.id);
    assertEqual(status, 401, 'response status');
    assertEqual(+after.expiryDate, +before, 'expiry unchanged by a forged event');
  });

  await test('a rejected event is still recorded for audit', async () => {
    const event = fx.invoiceUpdateSuccess({
      subscriptionCode: `SUB_audit_${uniq()}`,
      amount: 300_000,
      transactionReference: `RPL_audit_${uniq()}`,
    });
    await deliver(event, { signed: false });

    const logged = await db(() =>
      prisma.webhookLog.findFirst({
        where: { eventType: 'invoice.update', error: 'signature_invalid' },
        orderBy: { createdAt: 'desc' },
      }),
    );
    assert(logged, 'no webhook_log row written for the rejected event');
  });

  await test('a redelivered identical event is ignored by the replay guard', async () => {
    const { subscription, price, periodMs } = await makeSubscription();
    const before = subscription.expiryDate;
    const event = fx.invoiceUpdateSuccess({
      subscriptionCode: subscription.paystackSubscriptionCode!,
      amount: price.amount,
      transactionReference: `RPL_replay_${uniq()}`,
    });

    await deliver(event);
    const once = await reload(subscription.id);
    await deliver(event); // byte-identical redelivery
    const twice = await reload(subscription.id);

    assertCloseTo(+once.expiryDate, +before + periodMs, 60_000, 'first extension');
    assertEqual(+twice.expiryDate, +once.expiryDate, 'expiry after redelivery');
  });

  await test('concurrent duplicate delivery extends only once', async () => {
    const { subscription, price, periodMs } = await makeSubscription();
    const before = subscription.expiryDate;
    const event = fx.invoiceUpdateSuccess({
      subscriptionCode: subscription.paystackSubscriptionCode!,
      amount: price.amount,
      transactionReference: `RPL_race_${uniq()}`,
    });

    // Both in flight before either has been recorded — the unique index on
    // event_key is what settles this.
    await Promise.all([deliver(event), deliver(event)]);

    const after = await reload(subscription.id);
    assertCloseTo(+after.expiryDate, +before + periodMs, 60_000, 'expiry after a concurrent race');
  });

  await test('a renewal arriving for a subscription that no longer exists is survivable', async () => {
    const { subscription, price } = await makeSubscription();
    const code = subscription.paystackSubscriptionCode!;
    await db(() => prisma.subscription.delete({ where: { id: subscription.id } }));

    const status = await deliver(
      fx.invoiceUpdateSuccess({
        subscriptionCode: code,
        amount: price.amount,
        transactionReference: `RPL_${uniq()}`,
      }),
    );
    assertEqual(status, 200, 'response status');
  });
}

// --- entry point ------------------------------------------------------------

async function main() {
  // Fail fast with a clear message rather than a wall of ECONNREFUSED.
  try {
    const res = await fetch(`${API}/health`);
    if (!res.ok) throw new Error(String(res.status));
  } catch {
    throw new Error(`backend not reachable at ${API} — start it with: npm run dev`);
  }

  const plans = await prisma.plan.count({ where: { code: 'testhealth' } });
  if (plans === 0) throw new Error('plan `testhealth` is missing — run prisma/seed-plans.testmode.ts');

  await run();

  console.log(
    `\n\x1b[1m${passed} passed, ${failed} failed` +
      (knownDefects ? `, ${knownDefects} known defect(s)` : '') +
      `\x1b[0m`,
  );
  if (failures.length) {
    console.log('\nFailed:');
    failures.forEach((f) => console.log(`  - ${f}`));
  }
  if (fixedDefects.length) {
    console.log('\nKnown defects that now pass (remove their markers):');
    fixedDefects.forEach((f) => console.log(`  - ${f}`));
  }

  // Always clean up, pass or fail — a half-cleaned test DB makes the next run's
  // failures impossible to interpret.
  const users = await db(() =>
    prisma.user.findMany({ where: { email: { contains: TAG } }, select: { id: true } }),
  );
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await db(() => prisma.payment.deleteMany({ where: { userId: { in: ids } } }));
    await db(() => prisma.subscription.deleteMany({ where: { userId: { in: ids } } }));
    await db(() => prisma.user.deleteMany({ where: { id: { in: ids } } }));
    console.log(`\ncleaned up ${ids.length} replay member(s)`);
  }

  if (failed > 0) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(`\n\x1b[31m✗ ${e.message}\x1b[0m\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
