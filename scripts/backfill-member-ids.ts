// Assigns a member ID to every user that predates the field.
//
//   npx ts-node scripts/backfill-member-ids.ts
//
// Idempotent — only touches rows where memberId is null.
import { prisma } from '../src/config/database';
import { withMemberId } from '../src/utils/member-id';

async function main() {
  const pending = await prisma.user.findMany({
    where: { memberId: null },
    select: { id: true, name: true, phoneNumber: true },
  });

  for (const u of pending) {
    const updated = await withMemberId((memberId) =>
      prisma.user.update({ where: { id: u.id }, data: { memberId } }),
    );
    console.log(`  ${updated.memberId}  ${u.name ?? u.phoneNumber}`);
  }

  console.log(`\nBackfilled ${pending.length} member(s).`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
