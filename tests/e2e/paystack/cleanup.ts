/**
 * Removes everything the Paystack E2E created.
 *
 *   npx ts-node tests/e2e/paystack/cleanup.ts
 *   E2E_PURGE_LOGS=1 npx ts-node tests/e2e/paystack/cleanup.ts   # also drop webhook_logs
 *
 * ORDER MATTERS. Paystack subscriptions are disabled BEFORE the local rows are
 * deleted. A subscription left enabled keeps billing on its cron forever, and
 * once the local rows are gone every one of those charges arrives unattributable
 * — which fires an admin alert per charge, indefinitely. Deleting first also
 * destroys the email_token that disabling requires, so it cannot be undone
 * afterwards.
 *
 * webhook_logs are KEPT by default: those captured payloads are the fixtures the
 * replay suite is built from, and they contain no member rows once the users are
 * gone. Pass E2E_PURGE_LOGS=1 to drop them too.
 */
import { prisma } from '../../../src/config/database';
import { env } from '../../../src/config/env';
import { TAG } from './client';

const ok = (m: string) => console.log(`  \x1b[32m✓\x1b[0m ${m}`);
const warn = (m: string) => console.log(`  \x1b[33m!\x1b[0m ${m}`);
const step = (m: string) => console.log(`\n\x1b[1m${m}\x1b[0m`);

async function disableOnPaystack(code: string, token: string): Promise<boolean> {
  try {
    const res = await fetch('https://api.paystack.co/subscription/disable', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ code, token }),
    });
    const body: any = await res.json();
    return body.status === true;
  } catch {
    return false;
  }
}

async function main() {
  const users = await prisma.user.findMany({
    where: { email: { contains: TAG } },
    select: { id: true, email: true },
  });

  if (users.length === 0) {
    console.log('\nNothing to clean up.\n');
    return;
  }

  const ids = users.map((u) => u.id);
  console.log(`\nFound ${users.length} E2E member(s).`);

  step('1. Disable subscriptions on Paystack');
  const subs = await prisma.subscription.findMany({ where: { userId: { in: ids } } });
  if (subs.length === 0) console.log('  (none)');
  for (const s of subs) {
    if (s.paystackSubscriptionCode && s.paystackEmailToken) {
      const done = await disableOnPaystack(s.paystackSubscriptionCode, s.paystackEmailToken);
      done
        ? ok(`disabled ${s.paystackSubscriptionCode}`)
        : warn(`could not disable ${s.paystackSubscriptionCode} — may keep billing; disable it in the dashboard`);
    } else {
      warn(`subscription ${s.id} has no code/token — nothing to disable upstream`);
    }
  }

  step('2. Delete local rows');
  const payments = await prisma.payment.deleteMany({ where: { userId: { in: ids } } });
  ok(`payments      ${payments.count}`);
  const subscriptions = await prisma.subscription.deleteMany({ where: { userId: { in: ids } } });
  ok(`subscriptions ${subscriptions.count}`);
  const deleted = await prisma.user.deleteMany({ where: { id: { in: ids } } });
  ok(`users         ${deleted.count}`);

  if (process.env.E2E_PURGE_LOGS === '1') {
    const logs = await prisma.webhookLog.deleteMany({});
    ok(`webhook_logs  ${logs.count} (purged)`);
  } else {
    const kept = await prisma.webhookLog.count();
    console.log(`  \x1b[2mwebhook_logs  ${kept} kept as replay fixtures (E2E_PURGE_LOGS=1 to drop)\x1b[0m`);
  }

  step('3. Verify');
  const remaining = await prisma.user.count({ where: { email: { contains: TAG } } });
  if (remaining !== 0) throw new Error(`${remaining} E2E user(s) still present`);
  ok('no E2E members remain');

  console.log('');
}

main()
  .catch((e) => {
    console.error(`\n\x1b[31m✗ ${e.message}\x1b[0m\n`);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
