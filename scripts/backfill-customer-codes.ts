// Backfills Subscription.paystackCustomerCode from the Paystack payloads already
// stored on each subscription's payments.
//
//   npx ts-node scripts/backfill-customer-codes.ts
//
// The column is newer than these rows, so until it is populated the recurring
// charge fallback can only match on the authorization code — which rotates when
// a customer replaces their card. Idempotent.
import { prisma } from '../src/config/database';

async function main() {
  const subs = await prisma.subscription.findMany({
    where: { paystackCustomerCode: null },
    include: { payments: { orderBy: { createdAt: 'desc' } } },
  });

  let filled = 0;
  for (const sub of subs) {
    const code = sub.payments
      .map((p) => (p.paystackData as any)?.customer?.customer_code)
      .find(Boolean);

    if (!code) {
      console.log(`  ${sub.id.slice(0, 8)} ${sub.planId.padEnd(7)} — no customer_code in stored payloads`);
      continue;
    }

    await prisma.subscription.update({
      where: { id: sub.id },
      data: { paystackCustomerCode: code },
    });
    filled++;
    console.log(`  ${sub.id.slice(0, 8)} ${sub.planId.padEnd(7)} -> ${code}`);
  }

  console.log(`\nBackfilled ${filled}/${subs.length} subscription(s).`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
