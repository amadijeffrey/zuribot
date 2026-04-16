import { Queue, QueueEvents } from 'bullmq';
import { redisConnection } from '../config/redis';
import { logger } from '../utils/logger';

// Message processing queue
export const messageQueue = new Queue('messages', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: {
      type: 'exponential',
      delay: 1000,
    },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

// Notification queue
export const notificationQueue = new Queue('notifications', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: {
      type: 'exponential',
      delay: 2000,
    },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

// Queue events for monitoring
const messageQueueEvents = new QueueEvents('messages', {
  connection: redisConnection,
});

messageQueueEvents.on('completed', ({ jobId }) => {
  logger.debug('Job completed', { queue: 'messages', jobId });
});

messageQueueEvents.on('failed', ({ jobId, failedReason }) => {
  logger.error('Job failed', { queue: 'messages', jobId, reason: failedReason });
});

// Graceful shutdown
export const closeQueues = async (): Promise<void> => {
  await messageQueue.close();
  await notificationQueue.close();
  logger.info('All queues closed');
};