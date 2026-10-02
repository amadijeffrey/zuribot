// Emails people who started a checkout and never finished paying.
//
//   npx ts-node scripts/send-pending-payment-reminders.ts            # DRY RUN (default)
//   npx ts-node scripts/send-pending-payment-reminders.ts --send     # actually send
//
// Options (all optional):
//   --send                 send for real. Without it nothing is emailed.
//   --limit N              stop after N people (default: no limit)
//   --batch-size N         payments read from the DB per page (default 30)
//   --min-age-hours N      ignore checkouts newer than this (default 2). Younger than
//                          this, the person may still be on the Paystack page.
//   --max-age-days N       ignore checkouts older than this (default 14). This is the
//                          only age bound this one-off run needs; a recurring cron
//                          would also want a cooldown between reminders.
//   --delay-ms N           pause between emails (default 250, i.e. ~4/s)
//   --test-to EMAIL        send ONE real reminder to this address and exit. Reads no
//                          payments, asks Paystack nothing, emails nobody else — use it
//                          to check the email renders and arrives. Works with a
//                          localhost FRONTEND_URL, since the link is only for you.
//                          Cannot be combined with --send.
//   --test-name NAME       first name to greet in a --test-to email (default: none,
//                          which gives "Hi there,")
//
// Run it with a real frontend URL — the button in the email points at it:
//   FRONTEND_URL=https://www.zuricirclenetwork.com npx ts-node scripts/... --send
//
// THERE IS NO MEMORY BETWEEN RUNS
//   Nothing records who has been emailed. Running --send twice over the same
//   window emails the same people twice. The only controls are the dry run, the
//   age window, and --limit, so: dry-run first, and do not repeat a --send over
//   an overlapping window. (Remembering sends needs a column or table, which is
//   deliberately not added yet.)
//
// BATCHING
//   Payments are read in keyset pages (createdAt, id) rather than all at once, so
//   memory stays flat however many rows there are. Keyset rather than offset
//   because rows can change status during a long run (a checkout completing), and
//   an offset over a shifting result set skips people. Sending is one at a time,
//   throttled well under Resend's 10 requests/second, and the run stops if sends
//   keep failing (an exhausted daily quota would otherwise burn through everyone).
//
// WHICH CHECKOUTS COUNT — DECIDED PER PLAN, NOT PER PAYMENT ROW
//   One person can have several PENDING payments for the same plan: a checkout is
//   only reused for 30 minutes, after that a new row is created and the old one
//   stays PENDING even if the person pays on the new one. So each person's open
//   checkouts are grouped by plan, and a plan is dropped when:
//     - they already hold it (ACTIVE or GRACE). Expired/cancelled do not count —
//       a lapsed member coming back is exactly who this is for.
//     - Paystack says any checkout for it succeeded (listed for reconcile).
//     - Paystack says anything other than abandoned/failed, or can't be reached.
//   A person is emailed once if at least one plan is left. Holding Health does not
//   silence an unfinished Premium checkout.
//
// ALSO NOT EMAILED
//   - Renewals and plan changes (RNW_/CHG_ payments). Those are existing members.
//   - People with no email address.
import axios from 'axios';
import { Prisma } from '@prisma/client';
import { prisma } from '../src/config/database';
import { env } from '../src/config/env';
import { sendPendingPaymentReminderEmail, sendPendingPaymentReminderToAddress } from '../src/services/email';
import { classifyCheckoutGroup, PaystackLookup } from '../src/utils/reminder-eligibility';

// --- options ---------------------------------------------------------------

const argv = process.argv.slice(2);
const flag = (name: string): boolean => argv.includes(`--${name}`);
const num = (name: string, fallback: number): number => {
  const i = argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const v = Number(argv[i + 1]);
  if (!Number.isFinite(v) || v < 0) throw new Error(`--${name} needs a non-negative number`);
  return v;
};

// Raw value after a flag, or undefined when the flag is absent. Not validated
// here — callers decide what a missing or malformed value means.
const str = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};

const SEND = flag('send');
const BATCH_SIZE = Math.max(1, num('batch-size', 30));
const MIN_AGE_HOURS = num('min-age-hours', 2);
const MAX_AGE_DAYS = num('max-age-days', 14);
const DELAY_MS = num('delay-ms', 250);
const LIMIT = num('limit', Infinity);

// Trips the circuit breaker. Five in a row is a systemic problem (quota, bad key,
// Resend down), not five unlucky addresses.
const MAX_CONSECUTIVE_SEND_FAILURES = 5;

// --- helpers ---------------------------------------------------------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const maskEmail = (email: string): string => {
  const [local, domain] = email.split('@');
  return domain ? `${local.slice(0, 3)}***@${domain}` : '***';
};

const verifyOnPaystack = async (reference: string): Promise<PaystackLookup> => {
  try {
    const { data } = await axios.get(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
      { headers: { Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}` }, timeout: 10000 },
    );
    const status = data?.data?.status;
    return status ? { kind: 'status', status: String(status) } : { kind: 'error', detail: 'no status' };
  } catch (e: any) {
    return { kind: 'error', detail: e.response ? `HTTP ${e.response.status}` : (e.code ?? e.message) };
  }
};

let stopping = false;
process.on('SIGINT', () => {
  // Checked between people, so an interrupt never lands mid-send.
  console.log('\nInterrupt received — finishing the current person, then stopping.');
  stopping = true;
});

// --- run -------------------------------------------------------------------

const ignoredCheckouts = new Map<string, number>();
const ignore = (reason: string) => {
  const key = reason.split(' (')[0]; // "paystack unverifiable (HTTP 404)" -> one bucket
  ignoredCheckouts.set(key, (ignoredCheckouts.get(key) ?? 0) + 1);
};
const paidButPending: string[] = [];
const failedSends: string[] = [];

// One real reminder to one address, then exit. Deliberately a separate path from
// the run below: it never reads a payment, never calls Paystack, and never emails
// anyone from the database, so it is safe to run against any environment.
async function runTestSend() {
  const to = str('test-to');
  if (!to || to.startsWith('--')) throw new Error('--test-to needs an email address, e.g. --test-to you@example.com');
  if (SEND) throw new Error('--test-to sends one test email and never contacts anyone from the database. Drop --send.');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new Error(`"${to}" is not a valid email address.`);

  // The same configuration a real send needs, so a test that passes means a real
  // run will not fail on setup. A localhost link is fine here: it is only for you.
  if (!env.FRONTEND_URL) throw new Error('FRONTEND_URL is not set — the email button would have no destination.');
  if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set.');
  if (!env.EMAIL_FROM) throw new Error('EMAIL_FROM is not set — Resend\'s test sender only delivers to the account owner.');

  const rawName = str('test-name');
  const name = rawName && !rawName.startsWith('--') ? rawName : null;

  console.log('='.repeat(60));
  console.log('MODE: TEST SEND — one email, no database records involved');
  console.log(`to       : ${to}`);
  console.log(`from     : ${env.EMAIL_FROM}`);
  console.log(`greeting : ${name ? `Hi ${name.trim().split(/\s+/)[0]},` : 'Hi there,'}`);
  console.log(`link     : ${env.FRONTEND_URL.replace(/\/$/, '')}/login`);
  console.log('='.repeat(60));

  const ok = await sendPendingPaymentReminderToAddress(to, name);
  console.log(ok ? `\nSENT. Check ${to} (and the spam folder).` : '\nFAILED — see the error logged above (Resend rejected it or could not be reached).');
  if (!ok) process.exitCode = 1;
}

async function main() {
  if (argv.includes('--test-to')) return runTestSend();

  const db = new URL(env.DATABASE_URL);
  const dbRef = decodeURIComponent(db.username).split('.')[1] ?? '-';

  console.log('='.repeat(60));
  console.log(SEND ? 'MODE: SEND — emails will go out' : 'MODE: DRY RUN — nothing is sent');
  console.log(`database : ${dbRef} @ ${db.hostname}`);
  console.log(`paystack : ${env.PAYSTACK_SECRET_KEY.startsWith('sk_live_') ? 'LIVE key' : 'test key'}`);
  console.log(`link     : ${env.FRONTEND_URL ? `${env.FRONTEND_URL.replace(/\/$/, '')}/login` : '(FRONTEND_URL not set)'}`);
  console.log(`window   : checkouts ${MIN_AGE_HOURS}h to ${MAX_AGE_DAYS}d old   batch=${BATCH_SIZE}  delay=${DELAY_MS}ms  limit=${LIMIT === Infinity ? 'none' : LIMIT}`);
  console.log('='.repeat(60));

  if (SEND) {
    // Refused up front rather than discovered per email: every message carries
    // this link, and one pointing at localhost is useless to the recipient.
    if (!env.FRONTEND_URL) throw new Error('FRONTEND_URL is not set — the email button would have no destination.');
    const host = new URL(env.FRONTEND_URL).hostname;
    if (['localhost', '127.0.0.1', '::1'].includes(host) || host.endsWith('.local')) {
      throw new Error(
        `FRONTEND_URL points at ${host}. Recipients cannot open that. Re-run with the real URL:\n` +
          `  FRONTEND_URL=https://<your-frontend> npx ts-node scripts/send-pending-payment-reminders.ts --send`,
      );
    }
    if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set.');
    if (!env.EMAIL_FROM) throw new Error('EMAIL_FROM is not set — Resend\'s test sender only delivers to the account owner.');

    console.log('Sending in 5 seconds — Ctrl-C to abort.');
    await sleep(5000);
  }

  const newest = new Date(Date.now() - MIN_AGE_HOURS * 3_600_000);
  const oldest = new Date(Date.now() - MAX_AGE_DAYS * 86_400_000);

  // New checkouts only. Renewal and plan-change payments are pre-linked to a
  // subscription, i.e. they belong to existing members.
  const inWindow = { status: 'PENDING' as const, subscriptionId: null, createdAt: { gte: oldest, lte: newest } };

  // Keyset condition: strictly after the last row seen, by (createdAt, id).
  const pageWhere = (after?: { createdAt: Date; id: string }): Prisma.PaymentWhereInput => ({
    ...inWindow,
    user: { email: { not: null } },
    ...(after
      ? { OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] }
      : {}),
  });

  const handled = new Set<string>();
  let rowsScanned = 0;
  let batches = 0;
  let actioned = 0; // sent, or would-send in a dry run
  let peopleSkipped = 0;
  let consecutiveFailures = 0;
  let aborted = false;
  let hitLimit = false;
  let after: { createdAt: Date; id: string } | undefined;

  outer: for (;;) {
    const page = await prisma.payment.findMany({
      where: pageWhere(after),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: BATCH_SIZE,
      select: { id: true, userId: true, createdAt: true, user: { select: { email: true } } },
    });
    if (page.length === 0) break;

    batches++;
    rowsScanned += page.length;
    const last = page[page.length - 1];
    after = { createdAt: last.createdAt, id: last.id };
    console.log(`\n-- batch ${batches}: ${page.length} payments --`);

    for (const row of page) {
      if (stopping) break outer;
      if (actioned >= LIMIT) { hitLimit = true; break outer; }
      // One email per person however many abandoned checkouts they have, and a
      // person's rows can land in different batches.
      if (handled.has(row.userId)) continue;
      handled.add(row.userId);

      const who = maskEmail(row.user.email ?? '');

      // Every open checkout this person has inside the window — not just the ones
      // in this batch — grouped by plan.
      const open = await prisma.payment.findMany({
        where: { ...inWindow, userId: row.userId },
        select: { reference: true, planId: true },
      });
      const refsByPlan = new Map<string, string[]>();
      for (const p of open) refsByPlan.set(p.planId, [...(refsByPlan.get(p.planId) ?? []), p.reference]);

      // Plans they hold right now. Subscription.planId and Payment.planId are both
      // the plan CODE, so they compare directly.
      const held = new Set(
        (
          await prisma.subscription.findMany({
            where: { userId: row.userId, status: { in: ['ACTIVE', 'GRACE'] } },
            select: { planId: true },
          })
        ).map((s) => s.planId),
      );

      const outstanding: string[] = [];
      const notes: string[] = [];
      for (const [planId, refs] of refsByPlan) {
        // Paystack is only asked when the plan isn't already held: a held plan is
        // ignored whatever it says, and this saves a call per lingering row.
        const lookups: { reference: string; result: PaystackLookup }[] = [];
        if (!held.has(planId)) {
          for (const reference of refs) lookups.push({ reference, result: await verifyOnPaystack(reference) });
        }

        const verdict = classifyCheckoutGroup(held, planId, lookups);
        if (verdict.remind) {
          outstanding.push(planId);
          continue;
        }
        ignore(verdict.reason);
        paidButPending.push(...verdict.paidReferences);
        notes.push(`${planId}: ${verdict.reason}`);
      }

      if (outstanding.length === 0) {
        peopleSkipped++;
        console.log(`  ${who.padEnd(28)} skip — ${notes.join('; ') || 'nothing outstanding'}`);
        continue;
      }

      const detail = `outstanding: ${outstanding.join(', ')}${notes.length ? `   | ignored: ${notes.join('; ')}` : ''}`;

      if (!SEND) {
        actioned++;
        console.log(`  ${who.padEnd(28)} WOULD SEND — ${detail}`);
        continue;
      }

      const ok = await sendPendingPaymentReminderEmail(row.userId);
      if (ok) {
        actioned++;
        consecutiveFailures = 0;
        console.log(`  ${who.padEnd(28)} SENT — ${detail}`);
      } else {
        failedSends.push(`${who}  (user ${row.userId})`);
        consecutiveFailures++;
        console.log(`  ${who.padEnd(28)} FAILED — not sent`);
        if (consecutiveFailures >= MAX_CONSECUTIVE_SEND_FAILURES) {
          aborted = true;
          console.log(`\nStopping: ${MAX_CONSECUTIVE_SEND_FAILURES} sends failed in a row. Check RESEND_API_KEY, the domain, and Resend's daily quota.`);
          break outer;
        }
      }
      await sleep(DELAY_MS);
    }
  }

  console.log('\n' + '='.repeat(60));
  console.log(`payments scanned : ${rowsScanned} in ${batches} batch${batches === 1 ? '' : 'es'}`);
  console.log(`people considered: ${handled.size}`);
  console.log(`${SEND ? 'emailed' : 'would email'}${' '.repeat(SEND ? 10 : 6)}: ${actioned}`);
  console.log(`skipped          : ${peopleSkipped}  (nothing outstanding after the checks)`);
  if (ignoredCheckouts.size) {
    console.log('plans ignored, by reason (one per person and plan):');
    for (const [reason, n] of [...ignoredCheckouts].sort((a, b) => b[1] - a[1])) console.log(`  ${String(n).padStart(4)}  ${reason}`);
  }
  if (failedSends.length) {
    // Nothing is recorded, so re-running --send would also re-email everyone who
    // succeeded. These are listed so the failures can be dealt with by hand.
    console.log(`\nFAILED to send (${failedSends.length}) — NOT retried automatically:`);
    for (const f of failedSends) console.log(`  ${f}`);
  }
  if (paidButPending.length) {
    console.log(`\nPAID on Paystack but still PENDING here (${paidButPending.length}) — run POST /api/admin/reconcile:`);
    for (const ref of paidButPending) console.log(`  ${ref}`);
  }
  if (!SEND) console.log('\nDry run only. Re-run with --send to email these people.');

  // The headline number, stated last so it is the thing you read. "Sent" means
  // Resend accepted the mail, not that it has reached an inbox.
  const people = `${actioned} ${actioned === 1 ? 'person' : 'people'}`;
  const why = aborted
    ? ' — stopped early: too many sends failed in a row'
    : stopping
      ? ' — stopped early: interrupted'
      : hitLimit
        ? ` — reached --limit ${LIMIT}`
        : '';
  console.log(
    SEND
      ? `\nDONE — reminder sent to ${people}${failedSends.length ? `; ${failedSends.length} failed` : ''}${why}.`
      : `\nDRY RUN DONE — would send the reminder to ${people}${why}. Nothing was sent.`,
  );
  console.log('='.repeat(60));

  if (aborted) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error('\nAborted:', e.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
