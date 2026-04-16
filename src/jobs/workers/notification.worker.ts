import { Worker, Job } from 'bullmq';
import { sendTextMessage, sendTemplateMessage } from '../../services/whatsapp';
import { redisConnection } from '../../config/redis';
import { logger } from '../../utils/logger';

interface NotificationJobData {
  type: 'text' | 'template';
  phoneNumber: string;
  message?: string;
  templateName?: string;
  templateParams?: any[];
}

export const notificationWorker = new Worker(
  'notifications',
  async (job: Job<NotificationJobData>) => {
    const { type, phoneNumber, message, templateName, templateParams } = job.data;

    logger.info('Processing notification job', {
      jobId: job.id,
      type,
      phoneNumber,
    });

    let messageId: string | null = null;

    if (type === 'text' && message) {
      messageId = await sendTextMessage(phoneNumber, message);
    } else if (type === 'template' && templateName) {
      messageId = await sendTemplateMessage(phoneNumber, templateName, 'en', templateParams);
    }

    return { sent: !!messageId, messageId };
  },
  {
    connection: redisConnection,
    concurrency: 5,
  }
);

notificationWorker.on('completed', (job) => {
  logger.debug('Notification job completed', { jobId: job.id });
});

notificationWorker.on('failed', (job, error) => {
  logger.error('Notification job failed', {
    jobId: job?.id,
    error: error.message,
  });
});

export const closeNotificationWorker = async (): Promise<void> => {
  await notificationWorker.close();
  logger.info('Notification worker closed');
};