// Deletes every User created by the zuricircle e2e suite — anything with an
// email at the pw-e2e-test.example.com domain (see zuricircle/e2e/fixtures.ts)
// — along with their payments and subscriptions. Safe to run any time: real
// members never have an email on this domain, so nothing else can match.
//
// Raw SQL rather than Prisma's typed findMany/deleteMany: the typed
// `where: { email: { endsWith } }` form was observed, during this suite's own
// development, to sometimes silently return 0 rows against this project's
// Supabase/PgBouncer connection even when matching rows definitely existed
// (confirmed via an identical filter run as raw SQL moments later, in a
// separate process) — a real reliability gap, not a one-off. $queryRaw did
// not reproduce it in the same testing.
//
//   npx ts-node scripts/e2e-cleanup.ts
import { prisma } from '../src/config/database';

const TEST_EMAIL_DOMAIN = 'pw-e2e-test.example.com';

async function main() {
  const users = await prisma.$queryRaw<{ id: string }[]>`
    SELECT id FROM users WHERE email LIKE ${'%@' + TEST_EMAIL_DOMAIN}
  `;

  if (users.length === 0) {
    console.log('No e2e test users to clean up.');
    await prisma.$disconnect();
    return;
  }

  const ids = users.map((u) => u.id);
  await prisma.$executeRaw`DELETE FROM payments WHERE user_id = ANY(${ids})`;
  await prisma.$executeRaw`DELETE FROM subscriptions WHERE user_id = ANY(${ids})`;
  await prisma.$executeRaw`DELETE FROM users WHERE id = ANY(${ids})`;

  console.log(`Deleted ${ids.length} e2e test user(s).`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
