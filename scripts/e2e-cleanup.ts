// Deletes every User created by the zuricircle e2e suite — anything with an
// email at the pw-e2e.test domain (see zuricircle/e2e/fixtures.ts) — along
// with their payments and subscriptions. Safe to run any time: real members
// never have an email on this domain, so nothing else can match.
//
//   npx ts-node scripts/e2e-cleanup.ts
import { prisma } from '../src/config/database';

const TEST_EMAIL_DOMAIN = 'pw-e2e.test';

async function main() {
  const users = await prisma.user.findMany({
    where: { email: { endsWith: `@${TEST_EMAIL_DOMAIN}` } },
    select: { id: true, email: true },
  });

  if (users.length === 0) {
    console.log('No e2e test users to clean up.');
    await prisma.$disconnect();
    return;
  }

  const userIds = users.map((u) => u.id);
  await prisma.payment.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.subscription.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.user.deleteMany({ where: { id: { in: userIds } } });

  console.log(`Deleted ${users.length} e2e test user(s).`);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
