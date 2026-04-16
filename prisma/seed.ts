import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('Seeding database...');

  // Create groups for each plan
  const groups = [
    {
      planId: 'wealth',
      name: 'Wealth Plan Group',
      inviteLink: 'https://chat.whatsapp.com/wealth-group-invite-link',
      isActive: true,
    },
    {
      planId: 'boost',
      name: 'Boost Plan Group',
      inviteLink: 'https://chat.whatsapp.com/boost-group-invite-link',
      isActive: true,
    },
    {
      planId: 'premium',
      name: 'Premium Plan Group',
      inviteLink: 'https://chat.whatsapp.com/premium-group-invite-link',
      isActive: true,
    },
  ];

  for (const group of groups) {
    await prisma.group.upsert({
      where: { planId: group.planId },
      update: group,
      create: group,
    });
    console.log(`Created/updated group: ${group.name}`);
  }

  console.log('Seeding completed!');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });