import { Router } from 'express';
import { runExpirySweep } from '../services/subscription';
import { runReconciliation } from '../services/payment';
import { cronAuthMiddleware } from '../middleware/cron-auth';
import { asyncHandler } from '../middleware/error';
import { logger } from '../utils/logger';

const router = Router();

router.use(cronAuthMiddleware);

// GET /internal/cron/sweep — the scheduled maintenance pass.
//
//   1. Reconciliation    activates payments whose webhook never arrived
//   2. Subscription sync pulls Paystack subscription state (skip with ?full=false)
//   3. Expiry sweep      ACTIVE->GRACE at expiry, GRACE->EXPIRED after grace
//
// Every step is idempotent and batched, so a missed run costs nothing and a
// backlog drains over successive runs. Re-run until the counts come back zero.
//
// Scheduling (vercel.json is strict JSON, so the snippet lives here):
//
//   "crons": [{ "path": "/internal/cron/sweep", "schedule": "0 3 * * *" }]
//
// Daily is the minimum useful cadence and is what Vercel's Hobby tier supports.
// It means access can linger up to 24h past expiry, and a payment whose webhook
// was dropped waits up to a day — acceptable because the success page's
// verify-on-demand already rescues the common case at checkout time; this only
// catches customers who never returned to that page.
//
// Any external scheduler works too (GitHub Actions, cron-job.org, Upstash QStash)
// — send `Authorization: Bearer $CRON_SECRET`. Set CRON_SECRET or this route
// refuses every request.
//
// NOTE: keep the expiry sweep disabled until recurring renewals are confirmed
// working, or it will expire customers Paystack has successfully charged.
router.get('/sweep', asyncHandler(async (req, res) => {
  // The full Paystack subscription sync runs by default, which is right for a
  // daily schedule. On an hourly schedule it is wasteful — pass ?full=false on
  // the frequent runs and let one run a day do it.
  const includeSubscriptions = req.query.full !== 'false';

  try {
    const reconciliation = await runReconciliation({ includeSubscriptions });
    const sweep = await runExpirySweep();

    res.json({ success: true, reconciliation, sweep });
  } catch (error: any) {
    logger.error('Scheduled sweep failed', { error: error.message });
    res.status(500).json({ error: 'Sweep failed' });
  }
}));

export default router;
