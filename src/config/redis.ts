// import IORedis from 'ioredis';
// import { env } from './env';
// import { logger } from '../utils/logger';

// export const redisConnection = new IORedis(env.REDIS_URL, {
//   maxRetriesPerRequest: null,
//   enableReadyCheck: false,
//   retryStrategy: (times: number) => {
//     if (times > 10) {
//       logger.error('Redis connection failed after 10 retries');
//       return null;
//     }
//     return Math.min(times * 100, 3000);
//   },
// });

// redisConnection.on('connect', () => {
//   logger.info('Redis connected');
// });

// redisConnection.on('error', (error) => {
//   logger.error('Redis error', { error: error.message });
// });