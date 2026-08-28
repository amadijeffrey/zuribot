import { Router } from 'express';
import { runExpirySweep } from '../services/subscription';
import { runWorksheetReminders } from '../services/worksheet-reminder';
// import { runReconciliation } from '../services/payment'; // off the schedule for now
import { cronAuthMiddleware } from '../middleware/cron-auth';
import { recordJobSuccess, SWEEP_JOB, WORKSHEET_JOB } from '../services/job-state';
import { asyncHandler } from '../middleware/error';
import { logger } from '../utils/logger';

const router = Router();

router.use(cronAuthMiddleware);

// GET /internal/cron/sweep — the scheduled maintenance pass.
//
// Currently does ONE thing: subscriptions still in GRACE whose graceEndDate has
// passed are moved to EXPIRED.
//
// Everything else this used to do still exists and is still reachable by hand
// via the admin endpoints — it is just not on the schedule:
//
//   • Reconciliation      rescues payments whose webhook never arrived, and
//                         repairs a renewal whose events were all lost by
//                         syncing expiryDate to Paystack's next_payment_date
//   • Webhook replay      re-runs events this service received but failed to
//                         process (it acks 200 either way, so Paystack will
//                         never resend them)
//   • ACTIVE→GRACE        for subscriptions that simply run out
//
// Two consequences of that, worth being deliberate about:
//
//   1. A subscription that lapses WITHOUT a failed charge — a member who
//      cancelled, or one Paystack stopped billing — is never moved into GRACE by
//      anything, so it stays ACTIVE past its expiry date and never reaches the
//      GRACE→EXPIRED step below. Only subscriptions that entered GRACE via
//      invoice.payment_failed will ever expire on the schedule.
//   2. A successful payment or renewal whose webhook was received but failed to
//      process is not recovered until someone triggers reconciliation manually.
//
// Idempotent and batched (100 per run), so a missed run costs nothing: the next
// one re-queries whichever subscriptions still match and picks them up. Vercel
// does not retry a failed cron, so the next scheduled run IS the retry — the
// cost of a failure is a day's delay, not lost work.
//
// Scheduled daily at 03:00 UTC in vercel.json. Any external scheduler works too
// (GitHub Actions, cron-job.org, Upstash QStash) — send
// `Authorization: Bearer $CRON_SECRET`. Without CRON_SECRET this route refuses
// every request.
router.get('/sweep', asyncHandler(async (_req, res) => {
  try {
    // GRACE→EXPIRED only. Entry into GRACE comes from the
    // invoice.payment_failed webhook, not from here.
    const sweep = await runExpirySweep({ includeGraceTransition: false });

    // Recorded only on a fully successful pass, so a run that threw halfway does
    // not reset the staleness clock. Alerts if the previous success was long
    // enough ago to mean the schedule had stopped — see job-state.ts for why
    // that check cannot be the only detector.
    await recordJobSuccess(SWEEP_JOB, { ...sweep });

    res.json({ success: true, sweep });
  } catch (error: any) {
    logger.error('Scheduled sweep failed', { error: error.message });
    res.status(500).json({ error: 'Sweep failed' });
  }
}));

// GET /internal/cron/worksheet-reminders — monthly check-in.
//
// Emails members on the worksheet-bearing tiers (premium, apex) asking whether
// they have filled in the 90-Day Execution Track & Goal-Bursting Worksheet and
// whether they are hitting the goals they set for each interval.
//
// Scheduled for the 1st of the month. Idempotent per subscription — see
// worksheet-reminder.ts — so a manual trigger or a re-run after a partial pass
// will not email anyone twice.
router.get('/worksheet-reminders', asyncHandler(async (_req, res) => {
  try {
    const result = await runWorksheetReminders();
    await recordJobSuccess(WORKSHEET_JOB, { ...result });
    res.json({ success: true, ...result });
  } catch (error: any) {
    logger.error('Worksheet reminder job failed', { error: error.message });
    res.status(500).json({ error: 'Worksheet reminders failed' });
  }
}));

export default router;
