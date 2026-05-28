import { Router } from 'express';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import webhookRoutes from './webhook.routes';
import paystackRoutes from './paystack.routes';
import adminRoutes from './admin.routes';

const router = Router();

// Liveness: process is up. Cheap; no I/O.
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Readiness: process can serve traffic — db reachable.
// 200 if healthy, 503 if down. Use this for deployment smoke tests and
// uptime checks.
router.get('/ready', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      checks: { db: 'ok' },
    });
  } catch (error) {
    logger.warn('health: db check failed', { error });
    res.status(503).json({
      status: 'degraded',
      timestamp: new Date().toISOString(),
      checks: { db: 'fail' },
    });
  }
});

router.use('/', webhookRoutes);
router.use('/', paystackRoutes);
router.use('/admin', adminRoutes);

export default router;
