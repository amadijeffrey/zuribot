// import { Worker, Job } from 'bullmq';
// import { processMessage } from '../../services/message';
// import { redisConnection } from '../../config/redis';
// import { logger } from '../../utils/logger';

// export const messageWorker = new Worker(
//   'messages',
//   async (job: Job) => {
//     const { message, contact } = job.data;

//     logger.info('Processing message job', {
//       jobId: job.id,
//       messageId: message.id,
//       from: message.from,
//     });

//     await processMessage({ message, contact });

//     return { processed: true, messageId: message.id };
//   },
//   {
//     connection: redisConnection,
//     // Each job does network-bound work (Paystack/WhatsApp HTTP + a few DB
//     // queries). Throughput is capped by upstream APIs, not local parallelism,
//     // so keep concurrency low to stay well under the Prisma connection pool.
//     // Scale horizontally (more replicas) before raising this.
//     concurrency: 3,
//   }
// );

// messageWorker.on('completed', (job) => {
//   logger.debug('Message job completed', { jobId: job.id });
// });

// messageWorker.on('failed', (job, error) => {
//   logger.error('Message job failed', {
//     jobId: job?.id,
//     error: error.message,
//   });
// });

// export const closeMessageWorker = async (): Promise<void> => {
//   await messageWorker.close();
//   logger.info('Message worker closed');
// };