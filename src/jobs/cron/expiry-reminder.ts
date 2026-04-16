import {
  getSubscriptionsExpiringWithin,
  sendExpiryReminder,
} from '../../services/subscription';
import { logger } from '../../utils/logger';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const runExpiryReminderJob = async (): Promise<void> => {
  const reminderDays = [7, 3, 1];

  for (const days of reminderDays) {
    try {
      const subscriptions = await getSubscriptionsExpiringWithin(days);
      logger.info(`Found ${subscriptions.length} subscriptions expiring in ${days} days`);

      for (const subscription of subscriptions) {
        try {
          await sendExpiryReminder(
            subscription.user.phoneNumber,
            subscription.planId,
            days
          );
          await delay(500); // Rate limiting
        } catch (error) {
          logger.error('Failed to send expiry reminder', {
            subscriptionId: subscription.id,
            error,
          });
        }
      }
    } catch (error) {
      logger.error(`Failed to process ${days}-day reminders`, { error });
    }
  }
};