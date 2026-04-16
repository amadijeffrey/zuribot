import { getGracePeriodExpired, expireSubscription } from '../../services/subscription';
import { logger } from '../../utils/logger';

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const runSubscriptionExpiryJob = async (): Promise<void> => {
  try {
    const expiredGraceSubscriptions = await getGracePeriodExpired();
    logger.info(`Found ${expiredGraceSubscriptions.length} subscriptions to mark as expired`);

    for (const subscription of expiredGraceSubscriptions) {
      try {
        await expireSubscription(subscription.id);
        await delay(500);
      } catch (error) {
        logger.error('Failed to expire subscription', {
          subscriptionId: subscription.id,
          error,
        });
      }
    }
  } catch (error) {
    logger.error('Subscription expiry job error', { error });
  }
};