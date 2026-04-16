import { getExpiredSubscriptions, moveToGracePeriod } from '../../services/subscription';
import { logger } from '../../utils/logger';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const runGracePeriodJob = async (): Promise<void> => {
  try {
    const expiredSubscriptions = await getExpiredSubscriptions();
    logger.info(`Found ${expiredSubscriptions.length} subscriptions to move to grace period`);

    for (const subscription of expiredSubscriptions) {
      try {
        await moveToGracePeriod(subscription.id);
        await delay(500);
      } catch (error) {
        logger.error('Failed to move subscription to grace period', {
          subscriptionId: subscription.id,
          error,
        });
      }
    }
  } catch (error) {
    logger.error('Grace period job error', { error });
  }
};