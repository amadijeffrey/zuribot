// Test-only shortcut for the e2e suite: flips a Payment straight to FAILED or
// SUCCESS without a real Paystack charge, so /payment/success's branching can
// be tested without ever touching a live checkout page.
//
//   npx ts-node scripts/e2e-set-payment-status.ts <reference> <FAILED|SUCCESS>
import { prisma } from '../src/config/database';

async function main() {
  const [reference, status] = process.argv.slice(2);
  if (!reference || (status !== 'FAILED' && status !== 'SUCCESS')) {
    console.error('Usage: npx ts-node scripts/e2e-set-payment-status.ts <reference> <FAILED|SUCCESS>');
    process.exit(1);
  }

  const payment = await prisma.payment.findUnique({ where: { reference } });
  if (!payment) {
    console.error(`Payment not found: ${reference}`);
    process.exit(1);
  }

  if (status === 'FAILED') {
    await prisma.payment.update({ where: { reference }, data: { status: 'FAILED' } });
  } else {
    await prisma.payment.update({
      where: { reference },
      data: { status: 'SUCCESS', paidAt: new Date() },
    });

    if (!payment.subscriptionId) {
      const existing = await prisma.subscription.findFirst({
        where: { userId: payment.userId, planId: payment.planId },
      });
      if (!existing) {
        await prisma.subscription.create({
          data: {
            userId: payment.userId,
            planId: payment.planId,
            planPriceId: payment.planPriceId,
            status: 'ACTIVE',
            channel: payment.channel,
            startDate: new Date(),
            expiryDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
        });
      }
    }
  }

  console.log(`Payment ${reference} set to ${status}`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
