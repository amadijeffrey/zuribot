import { prisma } from '../config/database';
import { sendWorksheetReminderEmail } from './email';
import { logger } from '../utils/logger';

// Plans that include the 90-Day Execution Track & Goal-Bursting Worksheet.
// Plan codes, matching Subscription.planId.
export const WORKSHEET_PLAN_IDS = ['premium', 'apex'];

// A month is 28–31 days, so "not sent in the last 25 days" is the safe way to
// mean "not already sent this cycle" without depending on calendar arithmetic or
// on the job running exactly on schedule.
const RESEND_AFTER_DAYS = 25;

// Bounded so one run cannot exceed the platform's function timeout. Each send is
// an HTTP call to Resend, so the ceiling here is roughly (budget / send time).
const MAX_PER_RUN = 200;
const TIME_BUDGET_MS = 40_000;

export interface WorksheetReminderResult {
  eligible: number;
  sent: number;
  failed: number;
  remaining: number;
}

// Monthly check-in to members on the worksheet-bearing tiers.
//
// Safe to re-run: every send stamps worksheetReminderSentAt, and members stamped
// within RESEND_AFTER_DAYS are filtered out by the query itself. A run that stops
// early on the time budget therefore resumes where it left off rather than
// starting over, and `remaining` says whether another run is needed.
export const runWorksheetReminders = async (): Promise<WorksheetReminderResult> => {
  const cutoff = new Date(Date.now() - RESEND_AFTER_DAYS * 24 * 60 * 60 * 1000);
  const startedAt = Date.now();

  const where = {
    status: 'ACTIVE' as const,
    planId: { in: WORKSHEET_PLAN_IDS },
    OR: [{ worksheetReminderSentAt: null }, { worksheetReminderSentAt: { lt: cutoff } }],
  };

  const eligible = await prisma.subscription.count({ where });
  const subs = await prisma.subscription.findMany({
    where,
    select: { id: true, userId: true, planId: true },
    orderBy: { createdAt: 'asc' },
    take: MAX_PER_RUN,
  });

  const result: WorksheetReminderResult = { eligible, sent: 0, failed: 0, remaining: 0 };

  for (const sub of subs) {
    if (Date.now() - startedAt > TIME_BUDGET_MS) {
      logger.warn('Worksheet reminders stopped on the time budget — re-run to continue', {
        sent: result.sent,
      });
      break;
    }

    try {
      const delivered = await sendWorksheetReminderEmail(sub.userId, sub.planId);

      if (!delivered) {
        // No email address, or Resend rejected it. Left unstamped so the next
        // run retries rather than silently skipping them forever.
        result.failed++;
        continue;
      }

      // Stamped only after a confirmed send, for the same reason.
      await prisma.subscription.update({
        where: { id: sub.id },
        data: { worksheetReminderSentAt: new Date() },
      });
      result.sent++;
    } catch (error: any) {
      result.failed++;
      logger.error('Worksheet reminder failed', { subscriptionId: sub.id, error: error.message });
    }
  }

  result.remaining = Math.max(0, eligible - result.sent);
  logger.info('Worksheet reminders complete', { ...result });
  return result;
};
