import { Router } from 'express';
import { prisma } from '../config/database';
import { redisConnection } from '../config/redis';
import { logger } from '../utils/logger';
import webhookRoutes from './webhook.routes';
import paystackRoutes from './paystack.routes';
import adminRoutes from './admin.routes';

const router = Router();

// Liveness: process is up. Cheap; no I/O.
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Readiness: process can serve traffic — db + redis reachable.
// 200 if both healthy, 503 if any dep is down. Use this for deployment
// smoke tests and uptime checks.
router.get('/ready', async (_req, res) => {
  const checks: Record<string, 'ok' | 'fail'> = { db: 'fail', redis: 'fail' };

  await Promise.all([
    prisma
      .$queryRaw`SELECT 1`
      .then(() => { checks.db = 'ok'; })
      .catch((error) => logger.warn('health: db check failed', { error })),
    redisConnection
      .ping()
      .then(() => { checks.redis = 'ok'; })
      .catch((error) => logger.warn('health: redis check failed', { error })),
  ]);

  const ok = Object.values(checks).every((v) => v === 'ok');
  res.status(ok ? 200 : 503).json({
    status: ok ? 'ok' : 'degraded',
    timestamp: new Date().toISOString(),
    checks,
  });
});

router.use('/', webhookRoutes);
router.use('/', paystackRoutes);
router.use('/admin', adminRoutes);

export default router;
