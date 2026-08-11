// Creates or updates an admin: alert recipient + dashboard login account.
//
//   ADMIN_PASSWORD='your-long-password' npx ts-node scripts/create-admin.ts <email> [name]
//
// Prefer the env var — a password passed as a CLI argument is recorded in your
// shell history and visible in the process list. Passing it as a third argument
// still works, with a warning.
//
// Re-running for an existing email updates the password (use it as a reset).
import { prisma } from '../src/config/database';
import { hashPassword, MIN_PASSWORD_LENGTH } from '../src/services/admin-auth';

async function main() {
  const [email, ...rest] = process.argv.slice(2);

  let password = process.env.ADMIN_PASSWORD;
  let name: string | undefined;

  if (password) {
    name = rest.join(' ') || undefined;
  } else {
    // Fallback: last arg is the password.
    password = rest.pop();
    name = rest.join(' ') || undefined;
    if (password) {
      console.warn('⚠️  Password passed as an argument — it is now in your shell history.');
      console.warn('   Prefer: ADMIN_PASSWORD=... npx ts-node scripts/create-admin.ts <email> [name]\n');
    }
  }

  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    console.error('Usage: ADMIN_PASSWORD=... npx ts-node scripts/create-admin.ts <email> [name]');
    process.exit(1);
  }

  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    console.error(`A password of at least ${MIN_PASSWORD_LENGTH} characters is required.`);
    console.error('Set it via the ADMIN_PASSWORD environment variable.');
    process.exit(1);
  }

  const passwordHash = await hashPassword(password);

  const admin = await prisma.admin.upsert({
    where: { email: email.toLowerCase() },
    update: {
      ...(name ? { name } : {}),
      passwordHash,
      isActive: true,
    },
    create: {
      email: email.toLowerCase(),
      name,
      passwordHash,
      isActive: true,
    },
  });

  console.log('Admin ready:', {
    id: admin.id,
    email: admin.email,
    name: admin.name,
    canLogIn: true,
  });

  const all = await prisma.admin.findMany({
    where: { isActive: true },
    select: { email: true },
  });
  console.log(`\nAlerts will be emailed to: ${all.map((a) => a.email).join(', ')}`);
  console.log('Log in at: POST /api/admin/auth/login  { email, password }');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
