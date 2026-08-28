import { Router } from 'express';
import { prisma } from '../config/database';
import { asyncHandler } from '../middleware/error';
import { getJobLastSuccess, isSweepStale, SWEEP_JOB } from '../services/job-state';
import { logger } from '../utils/logger';
// import webhookRoutes from './webhook.routes'; // WhatsApp bot — see below
import paystackRoutes from './paystack.routes';
import adminRoutes from './admin.routes';
import userRoutes from './users.routes';
import cronRoutes from './cron.routes';

const router = Router();

// Liveness: process is up. Cheap; no I/O.
router.get('/health', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Readiness: process can serve traffic — db reachable.
// 200 if healthy, 503 if down. Use this for deployment smoke tests and
// uptime checks.
router.get('/ready', asyncHandler(async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;

    // Reported, but deliberately NOT reflected in the HTTP status: a stale sweep
    // does not mean this process cannot serve traffic, and 503ing here would pull
    // a healthy instance out of a load balancer for a scheduling problem.
    //
    // This is the only detector that works while the sweep is completely dead —
    // the in-job check can't fire if the job never runs. Point a monitor at this
    // field to be told about it.
    const sweepLastSuccessAt = await getJobLastSuccess(SWEEP_JOB);

    res.status(200).json({
      status: 'ok',
      timestamp: new Date().toISOString(),
      checks: {
        db: 'ok',
        sweep: isSweepStale(sweepLastSuccessAt) ? 'stale' : 'ok',
      },
      sweepLastSuccessAt: sweepLastSuccessAt?.toISOString() ?? null,
    });
  } catch (error) {
    logger.warn('health: db check failed', { error });
    res.status(503).json({
      status: 'degraded',
      timestamp: new Date().toISOString(),
      checks: { db: 'fail' },
    });
  }
}));

// WhatsApp inbound bot — DISABLED.
//
// This was the last live WhatsApp path. Outbound sends are all behind
// ENABLE_WHATSAPP_NOTIFICATIONS (default false) and therefore already inert, but
// this route was not gated at all: any event Meta delivered ran processMessage()
// and replied over WhatsApp, which is what produced the failed-send errors during
// the invoice.payment_failed run.
//
// Commented rather than deleted so the bot can be revived by uncommenting these
// two lines — services/whatsapp.ts, services/message.ts and handlers/webhook.handler.ts
// are all still present and wired to each other.
//
// While this is off, Meta's webhook verification (GET /webhook) also stops
// answering, so the subscription will show as failing in the Meta console.
// router.use('/', webhookRoutes);
router.use('/', paystackRoutes);
router.use('/api/admin', adminRoutes);
router.use('/api/users', userRoutes);
router.use('/internal/cron', cronRoutes);

export default router;
