// One-off: dump Paystack webhook payloads so we can see exactly what fields
// arrive on a recurring charge.success.
//
//   Inspect a single charge by reference:
//     npx ts-node scripts/inspect-webhook.ts cc69ecabcf0f4c9dc544893ef5320b30af9a08bf19314c2d
//
//   Or list all paystack events in a time window (ISO timestamps):
//     npx ts-node scripts/inspect-webhook.ts 2026-06-07T22:55:00Z 2026-06-07T23:10:00Z
import { prisma } from '../src/config/database';

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 1) {
    const reference = args[0];
    const logs = await prisma.webhookLog.findMany({
      where: { source: 'paystack' },
      orderBy: { createdAt: 'asc' },
    });
    const matches = logs.filter(
      (l) => JSON.stringify(l.payload ?? {}).includes(reference),
    );
    console.log(`Found ${matches.length} paystack log(s) mentioning ${reference}:\n`);
    for (const m of matches) {
      console.log('====================================================');
      console.log('eventType :', m.eventType);
      console.log('createdAt :', m.createdAt.toISOString());
      console.log('processed :', m.processed, '| error:', m.error);
      console.log('payload   :');
      console.dir(m.payload, { depth: null });
    }
    return;
  }

  if (args.length === 2) {
    const [gte, lte] = args;
    const logs = await prisma.webhookLog.findMany({
      where: {
        source: 'paystack',
        createdAt: { gte: new Date(gte), lte: new Date(lte) },
      },
      orderBy: { createdAt: 'asc' },
    });
    console.log(`Found ${logs.length} paystack event(s) between ${gte} and ${lte}:\n`);
    for (const l of logs) {
      const data: any = (l.payload as any)?.data ?? {};
      console.log(
        [
          l.createdAt.toISOString(),
          l.eventType.padEnd(26),
          'sub=' + (data.subscription?.subscription_code ?? '-'),
          'ref=' + (data.reference ?? data.transaction?.reference ?? '-'),
          'auth=' + (data.authorization?.authorization_code ?? '-'),
          'plan=' + (data.plan?.plan_code ?? '-'),
        ].join('  '),
      );
    }
    return;
  }

  console.log('Usage: ts-node scripts/inspect-webhook.ts <reference> | <fromISO> <toISO>');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
