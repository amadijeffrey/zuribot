// Charges a subscription's stored card authorization directly — the same call
// Paystack's scheduler makes on a renewal, without waiting for the cycle.
//
//   npx ts-node scripts/charge-authorization.ts SUB_6n89hdjjf2rsqr3
//
// Use it to answer one question: can this card be charged unattended? Paystack
// test cards that require PIN/OTP cannot — there is nobody to enter the OTP on
// a recurring charge, and the fraud system declines the reuse. `reusable: true`
// on the authorization does NOT mean it survives that; it only means the card
// was stored.
//
// Test mode only by intent — it moves real money against a live key.
import { PrismaClient } from '@prisma/client';
import axios from 'axios';
import { priceForSubscription } from '../src/services/plan';
import { env } from '../src/config/env';

const prisma = new PrismaClient();

async function main() {
  const code = process.argv[2];
  if (!code) throw new Error('Usage: npx ts-node scripts/charge-authorization.ts <SUB_code>');

  if (!env.PAYSTACK_SECRET_KEY.startsWith('sk_test_')) {
    throw new Error('Refusing to run with a live key — this charges the card for real.');
  }

  const sub = await prisma.subscription.findUnique({
    where: { paystackSubscriptionCode: code },
    include: { user: true },
  });
  if (!sub) throw new Error(`No subscription with code ${code}`);
  if (!sub.paystackAuthorizationCode) throw new Error('Subscription has no stored authorization code');
  if (!sub.user.email) throw new Error('User has no email — Paystack requires one');

  const price = await priceForSubscription(sub.planId, sub.planPriceId);
  if (!price) throw new Error(`No price for plan ${sub.planId}`);

  console.log(`Charging ${sub.paystackAuthorizationCode} for ${price.amount} kobo (${sub.planId})…\n`);

  try {
    const { data } = await axios.post(
      'https://api.paystack.co/transaction/charge_authorization',
      {
        authorization_code: sub.paystackAuthorizationCode,
        email: sub.user.email,
        amount: price.amount,
      },
      { headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` } },
    );
    const d = data.data;
    console.log('status          :', d.status);
    console.log('gateway_response:', d.gateway_response);
    console.log('reference       :', d.reference);
    console.log(
      '\n' +
        (d.status === 'success'
          ? 'This card CAN be charged unattended — the weekly renewal will go through.'
          : 'This card cannot be charged unattended. Pick a different test card.'),
    );
  } catch (e: any) {
    console.error('Paystack rejected the request:', e.response?.data ?? e.message);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error(e.message ?? e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
