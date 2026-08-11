// Re-writes already-stored Paystack payloads through the redactor, dropping card
// BIN/expiry/cardholder name, issuing bank, payer IP and the checkout trail.
//
//   npx ts-node scripts/redact-stored-payloads.ts
//
// Idempotent: rows already marked `_redacted` are skipped.
import { prisma } from '../src/config/database';
import { redactPaystackData } from '../src/utils/redact';

async function main() {
  const rows = await prisma.payment.findMany({
    where: { paystackData: { not: undefined } },
    select: { id: true, reference: true, paystackData: true },
  });

  let redacted = 0;
  let before = 0;
  let after = 0;

  for (const row of rows) {
    const data = row.paystackData as any;
    if (!data || data._redacted) continue;

    const clean = redactPaystackData(data);
    if (!clean) continue;

    before += JSON.stringify(data).length;
    after += JSON.stringify(clean).length;

    await prisma.payment.update({ where: { id: row.id }, data: { paystackData: clean } });
    redacted++;
  }

  console.log(`redacted ${redacted}/${rows.length} stored payloads`);
  if (redacted) {
    console.log(`bytes: ${before} -> ${after} (${Math.round((1 - after / before) * 100)}% smaller)`);
  }
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
