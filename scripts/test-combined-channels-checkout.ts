// EXPERIMENTAL — does not touch payment.ts or anything live. Tests whether
// letting Paystack's own hosted page offer card AND bank together (rather than
// us choosing one upfront) still produces a reusable authorization for either
// choice — the open question from the "let Paystack handle it" discussion.
//
//   npx ts-node scripts/test-combined-channels-checkout.ts <memberId> <planId> [interval]
//
// Deliberately a standalone script, not a new function in payment.ts: if this
// approach pans out, the real change is widening the channels array on the
// THREE existing card functions (initializePayment, initializeRenewalPayment,
// initializePlanChange) and deleting the three separate DirectDebit* ones
// currently stashed — not adding a fourth parallel path.
//
// Reference prefixed EXP_ — not DD_, not SUB_ — so it cannot be picked up by
// anything that recognises either of those (the in-flight dedup scoping, the
// pending-payment reminder's exclusion). This row is not meant to be handled
// by any existing logic; it exists only to observe what Paystack does.
//
// WHAT TO WATCH FOR
//   1. Does the checkout page show a picker between card and bank, or does it
//      behave unexpectedly with both channels present?
//   2. Complete it via BANK this time (we've tested bank-alone three times
//      already; what we have not tested is bank chosen FROM a combined list).
//      Does charge.success / the resulting Subscription look identical to the
//      bank-alone tests (channel: "bank", createPaystackSubscription
//      succeeding)?
//   3. If you want a second run choosing CARD instead, run the script again
//      with a different fresh user — does the card path look exactly like an
//      ordinary initializePayment checkout, with no side effects from the
//      recurring metadata being present?
import { prisma } from '../src/config/database';
import { env } from '../src/config/env';
import { resolvePlan, checkCapacity, PlanPriceInfo } from '../src/services/plan';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

async function main() {
  const [memberId, planId, interval] = process.argv.slice(2);
  if (!memberId || !planId) {
    throw new Error('Usage: npx ts-node scripts/test-combined-channels-checkout.ts <memberId> <planId> [interval]');
  }
  if (!env.PAYSTACK_SECRET_KEY.startsWith('sk_test_')) {
    throw new Error('Refusing to run with a live key — this creates a real Paystack transaction.');
  }

  const user = await prisma.user.findUnique({ where: { memberId } });
  if (!user) throw new Error(`No user with memberId "${memberId}" in this database.`);
  if (!user.email) throw new Error(`User ${memberId} has no email — Paystack requires one.`);

  const plan = await resolvePlan(planId);
  if (!plan) throw new Error(`Unknown plan: ${planId}`);
  const price: PlanPriceInfo | undefined = interval
    ? plan.prices.find((pr) => pr.interval === interval)
    : plan.defaultPrice;
  if (!price) throw new Error(`No ${interval ?? 'default'} price for plan ${planId}`);

  const capacity = await checkCapacity(planId);
  if (!capacity.hasCapacity) throw new Error(`${planId} is full.`);

  const reference = `EXP_${planId.toUpperCase()}_${uuidv4().slice(0, 8)}`;

  console.log('='.repeat(60));
  console.log('EXPERIMENT — combined channels, no DB row created beforehand');
  console.log(`member   : ${memberId}  (${user.email})`);
  console.log(`plan     : ${planId}  amount=${price.amount}  interval=${price.interval}`);
  console.log(`reference: ${reference}`);
  console.log('='.repeat(60));

  const paystackClient = axios.create({
    baseURL: 'https://api.paystack.co',
    timeout: 15000,
    headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`, 'Content-Type': 'application/json' },
  });

  const response = await paystackClient.post('/transaction/initialize', {
    email: user.email,
    amount: price.amount,
    reference,
    channels: ['card', 'bank'],
    metadata: { userId: user.id, planId, custom_filters: { recurring: true }, experiment: true },
  });

  console.log('\nRaw Paystack response:');
  console.log(JSON.stringify(response.data, null, 2));
  console.log('\nOpen this URL and watch what the checkout page actually shows:\n');
  console.log(' ', response.data.data.authorization_url);
  console.log(
    `\nAfter completing it, check what Paystack says with:\n` +
      `  curl -s -H "Authorization: Bearer $PAYSTACK_SECRET_KEY" https://api.paystack.co/transaction/verify/${reference} | python3 -m json.tool\n` +
      `and check webhook_logs for charge.success on this reference (the channel field in\n` +
      `that payload is the actual answer: "card" or "bank").\n` +
      `\nNote: this reference was never written to the payments table, so nothing in the\n` +
      `app will activate a subscription from it — this call is observation-only.`,
  );
}

main()
  .catch((e) => {
    console.error('\nAborted:', e.response?.data ?? e.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
