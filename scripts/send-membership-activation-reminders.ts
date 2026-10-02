// Emails members who registered but never completed the membership-activation
// step (PATCH /users/edit, which requires `occupation` — see updateProfile in
// user.handler.ts). A null `occupation` is the signal: that field is required
// on the activation form, so it can only be null if the form was never submitted.
//
//   npx ts-node scripts/send-membership-activation-reminders.ts            # DRY RUN (default)
//   npx ts-node scripts/send-membership-activation-reminders.ts --send     # actually send
//
// Options (all optional):
//   --send                 send for real. Without it nothing is emailed.
//   --limit N              stop after N people (default: no limit)
//   --batch-size N         users read from the DB per page (default 30)
//   --min-age-hours N      ignore accounts newer than this (default 24). Someone who
//                          registered an hour ago is probably still mid-signup, not
//                          someone who abandoned the activation step.
//   --max-age-days N       ignore accounts older than this (default: no limit — an
//                          incomplete profile doesn't go stale the way a checkout does)
//   --delay-ms N           pause between emails (default 250, i.e. ~4/s)
//   --test-to EMAIL        send ONE real reminder to this address and exit. Reads no
//                          users, emails nobody else — use it to check the email
//                          renders and arrives. Works with a localhost FRONTEND_URL,
//                          since the link is only for you. Cannot combine with --send.
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
//   deliberately not added yet — same tradeoff as the pending-payment reminder.)
//
// BATCHING
//   Users are read in keyset pages (createdAt, id) rather than all at once, so
//   memory stays flat however many rows there are. Keyset rather than offset
//   because a long run can outlive the page it started on (a user completing
//   activation mid-run), and an offset over a shifting result set skips people.
//   Sending is one at a time, throttled well under Resend's 10 requests/second,
//   and the run stops if sends keep failing (an exhausted daily quota would
//   otherwise burn through everyone).
//
// WHO IS NOT EMAILED
//   - Anyone with no email address.
//   - Anyone with no password set. That is a bot-created (WhatsApp) account that
//     never registered — occupation is null for them too, but "Activate Now"
//     leads to a login page they have no credentials for, so the email would be
//     useless at best and confusing at worst. They need to register first, which
//     is a different message than this one.
import { Prisma } from '@prisma/client';
import { prisma } from '../src/config/database';
import { env } from '../src/config/env';
import {
  sendMembershipActivationReminderEmail,
  sendMembershipActivationReminderToAddress,
} from '../src/services/email';

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
const MIN_AGE_HOURS = num('min-age-hours', 24);
const MAX_AGE_DAYS = num('max-age-days', Infinity);
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

let stopping = false;
process.on('SIGINT', () => {
  // Checked between people, so an interrupt never lands mid-send.
  console.log('\nInterrupt received — finishing the current person, then stopping.');
  stopping = true;
});

// --- run -------------------------------------------------------------------

const failedSends: string[] = [];

// One real reminder to one address, then exit. Deliberately a separate path from
// the run below: it never reads a user, and never emails anyone from the
// database, so it is safe to run against any environment.
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

  const ok = await sendMembershipActivationReminderToAddress(to, name);
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
  console.log(`link     : ${env.FRONTEND_URL ? `${env.FRONTEND_URL.replace(/\/$/, '')}/login` : '(FRONTEND_URL not set)'}`);
  console.log(
    `window   : accounts ${MIN_AGE_HOURS}h to ${MAX_AGE_DAYS === Infinity ? 'unlimited' : `${MAX_AGE_DAYS}d`} old` +
      `   batch=${BATCH_SIZE}  delay=${DELAY_MS}ms  limit=${LIMIT === Infinity ? 'none' : LIMIT}`,
  );
  console.log('='.repeat(60));

  if (SEND) {
    // Refused up front rather than discovered per email: every message carries
    // this link, and one pointing at localhost is useless to the recipient.
    if (!env.FRONTEND_URL) throw new Error('FRONTEND_URL is not set — the email button would have no destination.');
    const host = new URL(env.FRONTEND_URL).hostname;
    if (['localhost', '127.0.0.1', '::1'].includes(host) || host.endsWith('.local')) {
      throw new Error(
        `FRONTEND_URL points at ${host}. Recipients cannot open that. Re-run with the real URL:\n` +
          `  FRONTEND_URL=https://<your-frontend> npx ts-node scripts/send-membership-activation-reminders.ts --send`,
      );
    }
    if (!env.RESEND_API_KEY) throw new Error('RESEND_API_KEY is not set.');
    if (!env.EMAIL_FROM) throw new Error('EMAIL_FROM is not set — Resend\'s test sender only delivers to the account owner.');

    console.log('Sending in 5 seconds — Ctrl-C to abort.');
    await sleep(5000);
  }

  const newest = new Date(Date.now() - MIN_AGE_HOURS * 3_600_000);
  const oldest = MAX_AGE_DAYS === Infinity ? undefined : new Date(Date.now() - MAX_AGE_DAYS * 86_400_000);

  const inWindow = {
    occupation: null,
    email: { not: null },
    passwordHash: { not: null },
    createdAt: { lte: newest, ...(oldest ? { gte: oldest } : {}) },
  } satisfies Prisma.UserWhereInput;

  // Keyset condition: strictly after the last row seen, by (createdAt, id).
  const pageWhere = (after?: { createdAt: Date; id: string }): Prisma.UserWhereInput => ({
    ...inWindow,
    ...(after
      ? { OR: [{ createdAt: { gt: after.createdAt } }, { createdAt: after.createdAt, id: { gt: after.id } }] }
      : {}),
  });

  let rowsScanned = 0;
  let batches = 0;
  let actioned = 0; // sent, or would-send in a dry run
  let consecutiveFailures = 0;
  let aborted = false;
  let hitLimit = false;
  let after: { createdAt: Date; id: string } | undefined;

  outer: for (;;) {
    const page = await prisma.user.findMany({
      where: pageWhere(after),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: BATCH_SIZE,
      select: { id: true, email: true, name: true, createdAt: true },
    });
    if (page.length === 0) break;

    batches++;
    rowsScanned += page.length;
    const last = page[page.length - 1];
    after = { createdAt: last.createdAt, id: last.id };
    console.log(`\n-- batch ${batches}: ${page.length} users --`);

    for (const user of page) {
      if (stopping) break outer;
      if (actioned >= LIMIT) { hitLimit = true; break outer; }

      const who = maskEmail(user.email ?? '');

      if (!SEND) {
        actioned++;
        console.log(`  ${who.padEnd(28)} WOULD SEND`);
        continue;
      }

      const ok = await sendMembershipActivationReminderEmail(user.id);
      if (ok) {
        actioned++;
        consecutiveFailures = 0;
        console.log(`  ${who.padEnd(28)} SENT`);
      } else {
        failedSends.push(`${who}  (user ${user.id})`);
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

  // Reported separately rather than filtered silently into the main query: a
  // bot-created account with no password is a real person who should hear from
  // you eventually, just not with THIS email. Surfacing the count makes that a
  // visible decision rather than a silent exclusion.
  const excludedNoPassword = await prisma.user.count({
    where: { occupation: null, email: { not: null }, passwordHash: null, createdAt: inWindow.createdAt },
  });
  const excludedNoEmail = await prisma.user.count({
    where: { occupation: null, email: null, createdAt: inWindow.createdAt },
  });

  console.log('\n' + '='.repeat(60));
  console.log(`users scanned    : ${rowsScanned} in ${batches} batch${batches === 1 ? '' : 'es'}`);
  console.log(`${SEND ? 'emailed' : 'would email'}${' '.repeat(SEND ? 10 : 6)}: ${actioned}`);
  if (excludedNoPassword || excludedNoEmail) {
    console.log('not included in the query at all (same age window):');
    if (excludedNoPassword) console.log(`  ${String(excludedNoPassword).padStart(4)}  no password set (bot-created, cannot log in yet)`);
    if (excludedNoEmail) console.log(`  ${String(excludedNoEmail).padStart(4)}  no email address`);
  }
  if (failedSends.length) {
    // Nothing is recorded, so re-running --send would also re-email everyone who
    // succeeded. These are listed so the failures can be dealt with by hand.
    console.log(`\nFAILED to send (${failedSends.length}) — NOT retried automatically:`);
    for (const f of failedSends) console.log(`  ${f}`);
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
