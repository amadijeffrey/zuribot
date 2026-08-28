import { prisma } from '../config/database';
import { alertAdmins } from './email';
import { logger } from '../utils/logger';

export const SWEEP_JOB = 'cron-sweep';
export const WORKSHEET_JOB = 'worksheet-reminders';

// The sweep is scheduled daily. Two missed days is a real outage rather than a
// late run — Vercel's Hobby cron in particular fires anywhere within the hour,
// so a tight threshold would cry wolf.
const STALE_AFTER_HOURS = 48;

export const isSweepStale = (lastSuccessAt: Date | null): boolean =>
  !lastSuccessAt || Date.now() - lastSuccessAt.getTime() > STALE_AFTER_HOURS * 60 * 60 * 1000;

export const getJobLastSuccess = async (name: string): Promise<Date | null> => {
  const row = await prisma.jobRun.findUnique({ where: { name } });
  return row?.lastSuccessAt ?? null;
};

// Records the run and, if the previous success was too long ago, alerts. This
// catches a job that stopped and then resumed. It CANNOT catch one that is still
// stopped — nothing is running to notice — which is why /ready also reports
// staleness for an external monitor to assert on.
export const recordJobSuccess = async (
  name: string,
  result: Record<string, unknown>,
): Promise<void> => {
  const previous = await getJobLastSuccess(name);

  await prisma.jobRun.upsert({
    where: { name },
    update: { lastSuccessAt: new Date(), lastResult: result as any },
    create: { name, lastSuccessAt: new Date(), lastResult: result as any },
  });

  // No previous row is first-ever run, not a gap.
  // Only the daily sweep has a 48h expectation. A monthly job is legitimately
  // ~30 days between runs, so alerting on that gap would be noise.
  if (name === SWEEP_JOB && previous && isSweepStale(previous)) {
    const hours = Math.round((Date.now() - previous.getTime()) / 3_600_000);
    await alertAdmins(`Scheduled job "${name}" had not run for ${hours}h`, {
      job: name,
      previousSuccessAt: previous.toISOString(),
      gapHours: hours,
      impact:
        'Subscriptions past expiry stayed ACTIVE for that period — the sweep is the only path that revokes access.',
    });
  }

  logger.info('Scheduled job succeeded', { job: name });
};
