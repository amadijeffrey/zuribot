import { redisConnection } from './config/redis';
import { messageWorker, closeMessageWorker } from './jobs/workers/message.worker';
import { notificationWorker, closeNotificationWorker } from './jobs/workers/notification.worker';
import { logger } from './utils/logger';

const startWorkers = async () => {
  try {
    // Test Redis connection
    await redisConnection.ping();
    logger.info('Redis connected for workers');

    logger.info('Workers started', {
      message: messageWorker.isRunning(),
      notification: notificationWorker.isRunning(),
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`${signal} received, shutting down workers`);

      try {
        await closeMessageWorker();
        await closeNotificationWorker();
        await redisConnection.quit();
        logger.info('All workers closed');
        process.exit(0);
      } catch (error) {
        logger.error('Error during worker shutdown', { error });
        process.exit(1);
      }
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    logger.error('Failed to start workers', { error });
    process.exit(1);
  }
};

startWorkers();