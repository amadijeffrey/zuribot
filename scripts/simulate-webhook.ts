// Posts a correctly-signed Paystack webhook at the local server.
//
//   npx ts-node scripts/simulate-webhook.ts renewal SUB_6n89hdjjf2rsqr3
//
// Paystack signs with HMAC-SHA512 of the raw body under the secret key, so with
// the test secret we can produce an event the handler cannot distinguish from a
// real one. That makes the SUCCESS branch of the renewal path testable without
// waiting a billing cycle — and without depending on whether a given test card
// survives an unattended charge, which is a Paystack-side concern that does not
// arise with real cards in production.
//
// The payload is built from a real subscription in the database, so plan code,
// amount and codes all match what the handler will look up.
import crypto from 'crypto';
import axios from 'axios';
import { PrismaClient } from '@prisma/client';
import { priceForSubscription } from '../src/services/plan';
import { env } from '../src/config/env';

const prisma = new PrismaClient();
const TARGET = process.env.TARGET_URL || 'http://localhost:3000/paystack/webhook';

async function build(kind: string, subCode: string) {
  const sub = await prisma.subscription.findUnique({
    where: { paystackSubscriptionCode: subCode },
    include: { user: true },
  });
  if (!sub) throw new Error(`No subscription with code ${subCode}`);

  const price = await priceForSubscription(sub.planId, sub.planPriceId);
  if (!price) throw new Error(`No price for plan ${sub.planId}`);

  const now = new Date().toISOString();
  // Unique per run: the handler dedupes on a fingerprint of the payload, so a
  // repeated reference would be correctly ignored as a replay.
  const reference = `SIMULATED_${crypto.randomBytes(8).toString('hex')}`;

  const common = {
    subscription: { subscription_code: subCode },
    customer: { customer_code: sub.paystackCustomerCode, email: sub.user.email },
    authorization: { authorization_code: sub.paystackAuthorizationCode, reusable: true },
    plan: { plan_code: price.paystackPlanCode },
    amount: price.amount,
    currency: 'NGN',
  };

  if (kind === 'renewal') {
    return {
      event: 'invoice.update',
      data: {
        ...common,
        invoice_code: `INV_SIM_${crypto.randomBytes(4).toString('hex')}`,
        paid: true,
        status: 'success',
        paid_at: now,
        reference,
        transaction: { reference, status: 'success', amount: price.amount, currency: 'NGN' },
      },
    };
  }

  if (kind === 'charge') {
    return {
      event: 'charge.success',
      data: { ...common, reference, status: 'success', paid_at: now, channel: 'card' },
    };
  }

  throw new Error(`Unknown kind "${kind}". Use: renewal | charge`);
}

async function main() {
  const [kind, subCode] = process.argv.slice(2);
  if (!kind || !subCode) {
    throw new Error('Usage: npx ts-node scripts/simulate-webhook.ts <renewal|charge> <SUB_code>');
  }

  const payload = await build(kind, subCode);
  const body = JSON.stringify(payload);
  const signature = crypto.createHmac('sha512', env.PAYSTACK_SECRET_KEY).update(body).digest('hex');

  console.log(`POST ${TARGET}\nevent: ${payload.event}\n`);

  const res = await axios.post(TARGET, body, {
    headers: { 'Content-Type': 'application/json', 'x-paystack-signature': signature },
    validateStatus: () => true,
  });

  console.log('response:', res.status, res.data);
  console.log('\nCheck the subscription: expiry_date should have moved forward by the plan duration.');
}

main()
  .catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
