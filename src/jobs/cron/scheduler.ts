import cron from 'node-cron';
import { runGracePeriodJob } from './grace-period';
import { runSubscriptionExpiryJob } from './subscription-expiry';
import { withCronLock } from './lock';
import { logger } from '../../utils/logger';

// TTL chosen well above the longest expected job runtime so we don't
// accidentally release a still-running job; short enough that a crashed
// instance's lock recovers within a single cron cycle.
const CRON_LOCK_TTL_SECONDS = 600;

// Pin all schedules to a fixed timezone so the cron expressions mean the
// same wall-clock time regardless of where the container is deployed.
// Without this, node-cron uses the host TZ — a UTC prod container would
// fire "midnight" jobs at 1am local Lagos time.
const CRON_TZ = { timezone: 'Africa/Lagos' };

export const initializeScheduler = (): void => {
  logger.info('Initializing cron scheduler', { timezone: CRON_TZ.timezone });

  // Pre-renewal reminders are now driven by Paystack's invoice.create webhook
  // (~3 days before the next billing date), handled in payment.ts. No cron
  // needed for that.

  // Run grace period transitions every day at 12:00 AM
  cron.schedule('0 0 * * *', async () => {
    await withCronLock('grace-period', CRON_LOCK_TTL_SECONDS, async () => {
      logger.info('Running grace period job');
      try {
        await runGracePeriodJob();
      } catch (error) {
        logger.error('Grace period job failed', { error });
      }
    });
  }, CRON_TZ);

  // Run subscription expiry check every day at 12:05 AM
  cron.schedule('5 0 * * *', async () => {
    await withCronLock('subscription-expiry', CRON_LOCK_TTL_SECONDS, async () => {
      logger.info('Running subscription expiry job');
      try {
        await runSubscriptionExpiryJob();
      } catch (error) {
        logger.error('Subscription expiry job failed', { error });
      }
    });
  }, CRON_TZ);

  // Health check - runs every hour (unguarded; cheap and harmless if it
  // fires on every replica).
  cron.schedule('0 * * * *', () => {
    logger.debug('Scheduler health check - OK');
  }, CRON_TZ);

  logger.info('Cron scheduler initialized');
};