import { Prisma } from '@prisma/client';
import { prisma } from '../config/database';
import { sendPremiumUpgradeNudgeEmail } from './email';
import { logger } from '../utils/logger';

// How far back "recently registered" reaches. Chosen to match the monthly
// cadence this runs on: a user is only ever inside "created in the last 30
// days" for about one run, so unlike worksheet-reminder.ts this needs no
// separate "already sent" stamp — the rolling window itself prevents a repeat
// send under normal operation (the job running roughly monthly, not more
// often).
const WINDOW_DAYS = 30;

// Bounded so one run cannot exceed the platform's function timeout. Each send
// is an HTTP call to Resend, so the ceiling here is roughly (budget / send
// time) — same numbers as runWorksheetReminders.
const MAX_PER_RUN = 200;
const TIME_BUDGET_MS = 40_000;

export interface PremiumUpgradeNudgeResult {
  eligible: number;
  sent: number;
  failed: number;
  remaining: number;
}

// Monthly nudge to engaged members who registered recently and have never
// subscribed to any plan — see sendPremiumUpgradeNudgeEmail for the copy.
//
// "Never subscribed" is zero Subscription rows, not just no active one — a
// lapsed or cancelled former subscriber is a different, more nuanced
// re-engagement case, not this email. Excludes accounts with no email or no
// password set (bot-created, cannot log in to use the "Upgrade via your
// dashboard" CTA) the same way the manual script does.
export const runPremiumUpgradeNudge = async (): Promise<PremiumUpgradeNudgeResult> => {
  const oldest = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const startedAt = Date.now();

  const where = {
    email: { not: null },
    passwordHash: { not: null },
    createdAt: { gte: oldest },
    subscriptions: { none: {} },
  } satisfies Prisma.UserWhereInput;

  const eligible = await prisma.user.count({ where });
  const users = await prisma.user.findMany({
    where,
    select: { id: true },
    orderBy: { createdAt: 'asc' },
    take: MAX_PER_RUN,
  });

  const result: PremiumUpgradeNudgeResult = { eligible, sent: 0, failed: 0, remaining: 0 };

  for (const user of users) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      logger.warn('Premium upgrade nudge stopped on the time budget — re-run to continue', {
        sent: result.sent,
      });
      break;
    }

    try {
      const delivered = await sendPremiumUpgradeNudgeEmail(user.id);
      if (delivered) result.sent++;
      else result.failed++;
    } catch (error: any) {
      result.failed++;
      logger.error('Premium upgrade nudge failed', { userId: user.id, error: error.message });
    }
  }

  result.remaining = Math.max(0, eligible - result.sent);
  logger.info('Premium upgrade nudge complete', { ...result });
  return result;
};
