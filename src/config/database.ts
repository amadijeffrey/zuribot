import { PrismaClient } from '@prisma/client';

// One PrismaClient per process, held on globalThis.
//
// Each client opens its own connection pool (sized by `connection_limit` in
// DATABASE_URL), so constructing a second one silently doubles the connections
// this process holds against Supabase. Two situations construct more than once
// without the global:
//
//   • `npm run dev` — ts-node-dev re-evaluates the module graph on every save.
//     A long editing session would leak a pool per reload until the database
//     started refusing connections.
//   • Serverless — a warm instance re-imports rather than cold-starting.
//
// The long-lived VM process loads this module once and is unaffected either way.
// Assigned unconditionally rather than only outside production, because the
// serverless case above runs with NODE_ENV=production.
const globalForPrisma = globalThis as unknown as { prisma?: PrismaClient };

export const prisma =
  globalForPrisma.prisma ??
  new PrismaClient({
    log: process.env.NODE_ENV === 'development' ? ['error', 'warn'] : ['error'],
  });

globalForPrisma.prisma = prisma;
