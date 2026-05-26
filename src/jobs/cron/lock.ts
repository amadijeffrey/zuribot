import { redisConnection } from '../../config/redis';
import { logger } from '../../utils/logger';

// Distributed lock so cron jobs run on at most one server instance per tick.
// Without this, scaling the web/worker process to >1 replica fires every cron
// on every replica, producing duplicate side effects (double notifications,
// double Paystack /subscription/disable calls, etc.).
//
// SET key value NX EX ttl is atomic on the Redis side. The token check on
// release prevents a stuck job past its TTL from accidentally releasing a
// lock acquired by the next tick.
export const withCronLock = async (
  jobName: string,
  ttlSeconds: number,
  task: () => Promise<void>,
): Promise<void> => {
  const key = `cron:lock:${jobName}`;
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;

  const acquired = await redisConnection.set(key, token, 'EX', ttlSeconds, 'NX');
  if (!acquired) {
    logger.debug('Cron lock already held — skipping this tick', { jobName });
    return;
  }

  try {
    await task();
  } finally {
    const current = await redisConnection.get(key);
    if (current === token) {
      await redisConnection.del(key);
    }
  }
};
