import cron from 'node-cron';
import { runExpiryReminderJob } from './expiry-reminder';
import { runGracePeriodJob } from './grace-period';
import { runSubscriptionExpiryJob } from './subscription-expiry';
import { logger } from '../../utils/logger';

export const initializeScheduler = (): void => {
  logger.info('Initializing cron scheduler');

  // Run expiry reminders every day at 9:00 AM
  cron.schedule('0 9 * * *', async () => {
    logger.info('Running expiry reminder job');
    try {
      await runExpiryReminderJob();
    } catch (error) {
      logger.error('Expiry reminder job failed', { error });
    }
  });

  // Run grace period transitions every day at 12:00 AM
  cron.schedule('0 0 * * *', async () => {
    logger.info('Running grace period job');
    try {
      await runGracePeriodJob();
    } catch (error) {
      logger.error('Grace period job failed', { error });
    }
  });

  // Run subscription expiry check every day at 12:05 AM
  cron.schedule('5 0 * * *', async () => {
    logger.info('Running subscription expiry job');
    try {
      await runSubscriptionExpiryJob();
    } catch (error) {
      logger.error('Subscription expiry job failed', { error });
    }
  });

  // Health check - runs every hour
  cron.schedule('0 * * * *', () => {
    logger.debug('Scheduler health check - OK');
  });

  logger.info('Cron scheduler initialized');
};