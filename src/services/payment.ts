import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import type { Subscription, BillingInterval } from '@prisma/client';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { GRACE_PERIOD_DAYS, PLAN_CURRENCY } from '../config/constants';
import {
  resolvePlan,
  findByPaystackPlanCode,
  priceForSubscription,
  getAllPlans,
  checkCapacity,
} from './plan';
import { sendActivationConfirmation, sendRenewalConfirmation, sendExpiryReminder, moveToGracePeriod, expireSubscription } from './subscription';
import { sendActivationEmail, sendRenewalEmail, sendRenewalReminderEmail, alertAdmins } from './email';
import { redactPaystackData } from '../utils/redact';
import { logger } from '../utils/logger';
import { InitializePaymentParams, InitializePaymentResult } from '../types';

const paystackClient = axios.create({
  baseURL: 'https://api.paystack.co',
  timeout: 15000,
  headers: {
    Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
    'Content-Type': 'application/json',
  },
});

// Paystack reports the currency a transaction settled in. A charge in another
// currency must never satisfy a plan priced in NGN, however large the number.
const currencyMatches = (data: any): boolean =>
  !data?.currency || String(data.currency).toUpperCase() === PLAN_CURRENCY;

// Thrown when a capped plan (Apex) has no seats left. Callers should surface
// this as a 409 rather than a generic failure — it is an expected outcome.
// Asking to change to the plan and interval already held.
export class SamePlanError extends Error {
  constructor(public planId: string) {
    super(`Already subscribed to ${planId} on this interval`);
    this.name = 'SamePlanError';
  }
}

export class PlanFullError extends Error {
  constructor(public planId: string, public limit: number) {
    super(`Plan ${planId} is full (limit ${limit})`);
    this.name = 'PlanFullError';
  }
}

export const initializePayment = async (
  params: InitializePaymentParams
): Promise<InitializePaymentResult> => {
  const { userId, planId, email, channel = 'WHATSAPP', interval } = params;
  const plan = await resolvePlan(planId);

  if (!plan) throw new Error(`Unknown plan: ${planId}`);

  // (plan, interval) uniquely identifies a price — PlanPrice has a compound
  // unique on exactly that. Omitting the interval falls back to the plan's
  // default price, which is only unambiguous for single-interval plans.
  const price = interval
    ? plan.prices.find((pr) => pr.interval === interval)
    : plan.defaultPrice;

  if (!price) throw new Error(`No ${interval ?? 'default'} price for plan ${planId}`);
  if (!price.isActive) throw new Error(`Price is not purchasable for plan ${planId}`);

  // Capped plans (Apex) must be checked BEFORE taking money — refusing after a
  // successful charge means refunding a customer we just sold a seat to.
  const capacity = await checkCapacity(planId);
  if (!capacity.hasCapacity) {
    throw new PlanFullError(planId, capacity.limit ?? 0);
  }

  // Resume an in-flight checkout instead of minting another payment. Repeated
  // attempts would otherwise pile up PENDING rows — each one consuming a seat on
  // a capped plan and creating a redundant Paystack transaction.
  const inFlight = await prisma.payment.findFirst({
    where: {
      userId,
      planId,
      planPriceId: price.id,
      status: 'PENDING',
      authorizationUrl: { not: null },
      createdAt: { gte: new Date(Date.now() - 30 * 60 * 1000) },
    },
    orderBy: { createdAt: 'desc' },
  });

  if (inFlight?.authorizationUrl) {
    logger.info('Reusing in-flight checkout', { reference: inFlight.reference, userId, planId });
    return {
      reference: inFlight.reference,
      authorizationUrl: inFlight.authorizationUrl,
      accessCode: '',
    };
  }

  const reference = `SUB_${planId.toUpperCase()}_${uuidv4().slice(0, 8)}`;

  // WEB payments send the user back to the frontend success page, which reads
  // the reference and confirms via GET /users/registration-status.
  const callbackUrl =
    channel === 'WEB' && env.FRONTEND_URL
      ? `${env.FRONTEND_URL.replace(/\/$/, '')}/payment/success?reference=${reference}`
      : undefined;

  try {
    await prisma.payment.create({
      data: {
        userId,
        reference,
        amount: price.amount,
        planId,
        planPriceId: price.id,
        status: 'PENDING',
        channel,
      },
    });

    logger.info('Initializing Paystack transaction', {
      reference,
      planId,
      interval: price.interval,
      paystackPlanCode: price.paystackPlanCode,
    });

    // Note: `plan` is intentionally NOT passed here. Letting Paystack auto-create
    // the subscription means the subscription_code only arrives via the separate
    // subscription.create webhook (racy + best-effort). Instead, we charge once now
    // and explicitly POST /subscription after charge.success to get the code back
    // synchronously.
    const response = await paystackClient.post('/transaction/initialize', {
      email,
      amount: price.amount,
      reference,
      // Card only. Bank transfer/USSD produce a non-reusable authorization, so
      // Paystack cannot auto-charge the next cycle — the customer would appear
      // subscribed but silently never renew. Recurring billing requires a
      // reusable card authorization regardless of the amount.
      channels: ['card'],
      ...(callbackUrl ? { callback_url: callbackUrl } : {}),
      metadata: {
        userId,
        planId,
        custom_fields: [
          {
            display_name: 'Plan',
            variable_name: 'plan',
            value: planId,
          },
        ],
      },
    });

    await prisma.payment.update({
      where: { reference },
      data: { authorizationUrl: response.data.data.authorization_url },
    });

    logger.info('Paystack transaction initialized', {
      reference,
      userId,
      planId,
      paystackPlanCode: price.paystackPlanCode,
      authorizationUrl: response.data.data.authorization_url,
    });

    return {
      reference,
      authorizationUrl: response.data.data.authorization_url,
      accessCode: response.data.data.access_code,
    };
  } catch (error: any) {
    logger.error('Failed to initialize payment', {
      error: error.response?.data || error.message,
      userId,
      planId,
    });
    throw new Error('Failed to initialize payment');
  }
};

export const verifyPayment = async (reference: string): Promise<boolean> => {
  try {
    const response = await paystackClient.get(`/transaction/verify/${reference}`);
    const data = response.data.data;

    if (data.status === 'success') {
      await handleInitialPayment(reference, data);
      return true;
    }

    return false;
  } catch (error: any) {
    logger.error('Payment verification failed', {
      reference,
      error: error.response?.data || error.message,
    });
    return false;
  }
};

export const processWebhookEvent = async (event: any): Promise<void> => {
  logger.info('Processing Paystack webhook', {
    event: event.event,
    reference: event.data?.reference,
  });

  switch (event.event) {
    case 'charge.success':
      await handleChargeSuccess(event.data);
      break;

    case 'charge.failed':
      await handleFailedPayment(event.data.reference);
      break;

    case 'subscription.create':
      await handleSubscriptionCreated(event.data);
      break;

    case 'subscription.disable':
      await handleSubscriptionDisabled(event.data);
      break;

    case 'invoice.payment_failed':
      await handleInvoicePaymentFailed(event.data);
      break;

    case 'invoice.create':
      await handleInvoiceCreated(event.data);
      break;

    case 'invoice.update':
      await handleInvoiceUpdate(event.data);
      break;

    case 'subscription.not_renew':
      await handleSubscriptionNotRenew(event.data);
      break;

    case 'refund.processed':
      await handleRefundProcessed(event.data);
      break;

    case 'charge.dispute.create':
    case 'charge.dispute.remind':
      await handleDisputeOpened(event.data);
      break;

    case 'charge.dispute.resolve':
      await handleDisputeResolved(event.data);
      break;

    default:
      logger.info('Unhandled Paystack event', { event: event.event });
  }
};

// Paystack sends invoice.create ~3 days before the next billing date for a
// recurring subscription. We use it as a single pre-renewal reminder to the
// customer, replacing the prior cron-driven approach.
const handleInvoiceCreated = async (data: any): Promise<void> => {
  const subscriptionCode = data.subscription?.subscription_code;
  if (!subscriptionCode) {
    logger.warn('invoice.create without subscription_code — skipping', {
      invoiceCode: data.invoice_code,
    });
    return;
  }

  const subscription = await prisma.subscription.findUnique({
    where: { paystackSubscriptionCode: subscriptionCode },
    include: { user: true },
  });

  if (!subscription) {
    logger.warn('Subscription not found for invoice.create', { subscriptionCode });
    return;
  }

  // Only remind for ACTIVE subs. GRACE/EXPIRED/CANCELLED have their own
  // user-facing flows (RENEW prompt, re-subscribe), so a "your sub renews
  // soon" message would be misleading.
  if (subscription.status !== 'ACTIVE') {
    logger.info('Skipping invoice.create reminder; subscription not ACTIVE', {
      subscriptionCode,
      status: subscription.status,
    });
    return;
  }

  // Auto-renew is off, so "your subscription renews soon" would be false.
  if (subscription.cancelAtPeriodEnd) {
    logger.info('Skipping invoice.create reminder; subscription is not renewing', {
      subscriptionCode,
    });
    return;
  }

  if (subscription.channel === 'WHATSAPP' && env.ENABLE_WHATSAPP_NOTIFICATIONS) {
    await sendExpiryReminder(subscription.user.phoneNumber, subscription.planId, 3);
  } else {
    await sendRenewalReminderEmail(subscription.userId, subscription.planId, 3);
  }
};

// --- charge.success ---

const handleChargeSuccess = async (data: any): Promise<void> => {
  const payment = await prisma.payment.findUnique({
    where: { reference: data.reference },
  });

  // Pre-linked renewal payment created by renewSubscriptionViaAuthorization.
  // Routing on subscriptionId (not data.subscription) keeps the API-response
  // path and this webhook path idempotent against each other.
  if (payment?.subscriptionId) {
    if (payment.status === 'SUCCESS') {
      logger.info('Renewal payment already processed, skipping', { reference: data.reference });
      return;
    }
    await applyRenewalCharge(payment.subscriptionId, data.reference, data);
    return;
  }

  // Recurring auto-charge from a Paystack-managed subscription
  if (data.subscription?.subscription_code) {
    await handleRecurringCharge(data);
    return;
  }

  if (!payment) {
    // No local Payment row and no subscription_code: a recurring auto-charge in
    // the shape this account receives. Match it to a subscription by the stored
    // card authorization rather than dropping it (which silently debited users
    // without extending their access).
    if (await tryRecurringRenewalFromCharge(data)) return;

    // Unattributable: money was taken and we cannot tell what for. Every normal
    // path has been exhausted, so this needs a human — silently warning here is
    // what let recurring renewals fail unnoticed for 62 charges.
    await alertAdmins('Successful charge could not be matched to any payment or subscription', {
      reference: data.reference,
      amount: data.amount,
      customerEmail: data.customer?.email,
      customerCode: data.customer?.customer_code,
      authorizationCode: data.authorization?.authorization_code,
      planCode: data.plan?.plan_code,
    });
    return;
  }

  if (payment.status === 'SUCCESS') {
    logger.info('Payment already processed, skipping', { reference: data.reference });
    return;
  }

  await handleInitialPayment(data.reference, data);
};

const createPaystackSubscription = async (
  customerCode: string,
  planCode: string,
  authorizationCode: string,
): Promise<{ code: string; emailToken: string } | null> => {
  try {
    const { data: res } = await paystackClient.post('/subscription', {
      customer: customerCode,
      plan: planCode,
      authorization: authorizationCode,
    });

    return {
      code: res.data.subscription_code,
      emailToken: res.data.email_token,
    };
  } catch (error: any) {
    logger.error('Failed to create Paystack subscription', {
      error: error.response?.data || error.message,
      customerCode,
      planCode,
    });
    return null;
  }
};

// Disable the subscription on Paystack's side so they stop auto-retrying the card.
// Used when an invoice failure is terminal (declined, expired, stolen, fraud, etc.).
const disablePaystackSubscription = async (
  subscriptionCode: string,
  emailToken: string,
): Promise<boolean> => {
  try {
    await paystackClient.post('/subscription/disable', {
      code: subscriptionCode,
      token: emailToken,
    });
    logger.info('Paystack subscription disabled', { subscriptionCode });
    return true;
  } catch (error: any) {
    logger.error('Failed to disable Paystack subscription', {
      error: error.response?.data || error.message,
      subscriptionCode,
    });
    return false;
  }
};

// Fetch the full subscription from Paystack. Needed on invoice.payment_failed
// because Paystack does NOT include the decline reason in that webhook payload —
// it lives on the subscription's `most_recent_invoice` object instead.
const fetchPaystackSubscription = async (
  subscriptionCode: string,
): Promise<any | null> => {
  try {
    const { data: res } = await paystackClient.get(`/subscription/${subscriptionCode}`);
    return res.data;
  } catch (error: any) {
    logger.error('Failed to fetch Paystack subscription', {
      error: error.response?.data || error.message,
      subscriptionCode,
    });
    return null;
  }
};

// Channel-aware post-payment delivery. Keeps the WEB flow fully decoupled from
// WhatsApp: WEB subscribers are notified (and receive the invite link) by email,
// WHATSAPP subscribers by the bot as before.
type Channel = 'WHATSAPP' | 'WEB';

// Email is the delivery channel. The WhatsApp equivalents are retained and are
// used only when ENABLE_WHATSAPP_NOTIFICATIONS is turned back on, so the bot flow
// can be revived without rewriting these paths.
const deliverActivation = async (channel: Channel, userId: string, planId: string): Promise<void> => {
  if (channel === 'WHATSAPP' && env.ENABLE_WHATSAPP_NOTIFICATIONS) {
    await sendActivationConfirmation(userId, planId);
    return;
  }
  await sendActivationEmail(userId, planId);
};

const deliverRenewal = async (channel: Channel, userId: string, planId: string): Promise<void> => {
  if (channel === 'WHATSAPP' && env.ENABLE_WHATSAPP_NOTIFICATIONS) {
    await sendRenewalConfirmation(userId, planId);
    return;
  }
  await sendRenewalEmail(userId, planId);
};

// Sentinel used to roll back the activation transaction when another handler
// won the race. Distinguishes "benign, someone else did it" from a real failure,
// which need opposite compensation on the Paystack side.
class ConcurrentActivationError extends Error {
  constructor(reference: string) {
    super(`Payment ${reference} already activated by a concurrent handler`);
    this.name = 'ConcurrentActivationError';
  }
}

// The capped plan filled up between checkout and activation. The customer has
// already paid, so this is not a rejection — it obliges us to refund.
class PlanOversoldError extends Error {
  constructor(public planId: string, public limit: number, public used: number) {
    super(`Plan ${planId} oversold: ${used}/${limit}`);
    this.name = 'PlanOversoldError';
  }
}

// Refunds a transaction in full. Used when we take money we cannot honour.
const refundPayment = async (reference: string, reason: string): Promise<boolean> => {
  try {
    await paystackClient.post('/refund', { transaction: reference, merchant_note: reason });
    logger.info('Refund requested', { reference, reason });
    return true;
  } catch (error: any) {
    logger.error('Failed to request refund', {
      reference,
      error: error.response?.data || error.message,
    });
    return false;
  }
};

const handleInitialPayment = async (reference: string, data: any): Promise<void> => {
  const payment = await prisma.payment.findUnique({
    where: { reference },
    include: { user: true },
  });

  if (!payment) {
    logger.error('Payment not found', { reference });
    return;
  }

  // Cheap fast-path for the common "already done" retry.
  if (payment.status === 'SUCCESS') {
    logger.info('Payment already processed — skipping initial activation', { reference });
    return;
  }

  const plan = await resolvePlan(payment.planId);
  if (!plan) throw new Error(`Plan not found: ${payment.planId}`);

  // Charge against the interval actually purchased; legacy rows fall back to
  // the plan default.
  const price = await priceForSubscription(payment.planId, payment.planPriceId);
  if (!price) throw new Error(`No price for plan ${payment.planId}`);

  // Trust Paystack as the source of truth for what was actually charged.
  // Underpayments must NOT grant access — operator review required. Recorded as
  // SUCCESS (the money did arrive) but deliberately left without a subscription.
  if (!currencyMatches(data)) {
    await alertAdmins('Charge in unexpected currency — subscription NOT activated', {
      reference,
      userId: payment.userId,
      planId: payment.planId,
      expectedCurrency: PLAN_CURRENCY,
      receivedCurrency: data.currency,
      amount: data.amount,
    });
    await prisma.payment.updateMany({
      where: { reference, status: 'PENDING' },
      data: { status: 'SUCCESS', paidAt: new Date(data.paid_at || Date.now()), paystackData: data },
    });
    return;
  }

  if (Number(data.amount) < price.amount) {
    await alertAdmins('Charge below plan price — payment recorded, subscription NOT activated', {
      reference,
      userId: payment.userId,
      planId: payment.planId,
      expected: price.amount,
      received: data.amount,
    });
    await prisma.payment.updateMany({
      where: { reference, status: 'PENDING' },
      data: {
        status: 'SUCCESS',
        paidAt: new Date(data.paid_at || Date.now()),
        paystackData: redactPaystackData(data) ?? undefined,
      },
    });
    return;
  }

  const customerCode = data.customer?.customer_code;
  const authorizationCode = data.authorization?.authorization_code;

  const paystackSub =
    customerCode && authorizationCode && price.paystackPlanCode
      ? await createPaystackSubscription(customerCode, price.paystackPlanCode, authorizationCode)
      : null;

  if (!paystackSub) {
    logger.warn('No Paystack subscription code at activation; subscription.create webhook will backfill if it arrives', {
      reference,
      hasCustomerCode: !!customerCode,
      hasAuthorizationCode: !!authorizationCode,
    });
  }

  try {
    // Everything that must be true together commits together: the payment flips
    // PENDING→SUCCESS *and* the Subscription exists, or neither happens. A crash
    // or failure anywhere leaves the payment PENDING so a retry/verify can
    // reprocess it — the previous two-commit version could strand a paid user
    // with no subscription and no way to self-heal.
    await prisma.$transaction(async (tx) => {
      // Concurrency gate, now inside the transaction. The webhook and the
      // verify-on-demand path can both arrive for the same reference; exactly one
      // flips PENDING→SUCCESS. The loser's whole transaction rolls back.
      const claim = await tx.payment.updateMany({
        where: { reference, status: 'PENDING' },
        data: {
          status: 'SUCCESS',
          paidAt: new Date(data.paid_at || Date.now()),
          paystackData: redactPaystackData(data) ?? undefined,
          ...(data.currency ? { currency: String(data.currency).toUpperCase() } : {}),
        },
      });

      if (claim.count === 0) throw new ConcurrentActivationError(reference);

      // Authoritative capacity check for capped plans. The check at checkout is
      // advisory — two buyers can both read "99 used" before either writes a row.
      // Locking the plan row serialises activation for that plan, so the count
      // below cannot be stale. Uncapped plans skip the lock entirely and are
      // unaffected.
      if (plan.maxSubscribers !== null) {
        await tx.$queryRaw`SELECT id FROM plans WHERE code = ${payment.planId} FOR UPDATE`;
        const live = await tx.subscription.count({
          where: { planId: payment.planId, status: { in: ['ACTIVE', 'GRACE'] } },
        });
        if (live >= plan.maxSubscribers) {
          throw new PlanOversoldError(payment.planId, plan.maxSubscribers, live);
        }
      }

      const startDate = new Date();
      const expiryDate = new Date(Date.now() + price.durationDays * 24 * 60 * 60 * 1000);

      const graceEndDate = new Date(expiryDate);
      graceEndDate.setDate(graceEndDate.getDate() + GRACE_PERIOD_DAYS);

      const subscription = await tx.subscription.create({
        data: {
          userId: payment.userId,
          planId: payment.planId,
          planPriceId: price.id,
          status: 'ACTIVE',
          channel: payment.channel,
          startDate,
          expiryDate,
          graceEndDate,
          paystackSubscriptionCode: paystackSub?.code ?? null,
          paystackEmailToken: paystackSub?.emailToken ?? null,
          paystackAuthorizationCode: authorizationCode ?? null,
          paystackCustomerCode: customerCode ?? null,
        },
      });

      await tx.payment.update({
        where: { reference },
        data: { subscriptionId: subscription.id },
      });

      logger.info('Subscription activated', {
        subscriptionId: subscription.id,
        userId: payment.userId,
        planId: payment.planId,
        expiryDate,
        hasSubscriptionCode: !!paystackSub?.code,
      });
    });
  } catch (err) {
    // Lost the race: the winner owns the activation AND the Paystack subscription
    // (Paystack allows only one per customer+plan, so ours was a no-op duplicate).
    // Disabling it here would kill the winner's recurring billing.
    if (err instanceof ConcurrentActivationError) {
      logger.info('Payment activated by a concurrent handler — skipping', { reference });
      return;
    }

    // Oversold: the customer paid for a seat that no longer exists. The
    // transaction rolled back, so no subscription was granted — we must give the
    // money back rather than keep it. Refund first, then record it.
    if (err instanceof PlanOversoldError) {
      const refunded = await refundPayment(reference, `${err.planId} reached its subscriber limit`);

      if (refunded) {
        await prisma.payment
          .updateMany({ where: { reference }, data: { status: 'REFUNDED' } })
          .catch(() => {});
      }

      // The Paystack subscription would keep billing for access we just revoked.
      if (paystackSub?.code && paystackSub?.emailToken) {
        await disablePaystackSubscription(paystackSub.code, paystackSub.emailToken);
      }

      await alertAdmins(
        refunded
          ? 'Plan oversold — customer refunded automatically'
          : 'URGENT: plan oversold and automatic refund FAILED — refund manually',
        {
          reference,
          planId: err.planId,
          limit: err.limit,
          used: err.used,
          userId: payment.userId,
        },
      );
      return;
    }

    // Real failure. The transaction rolled back, so the payment is still PENDING
    // and reprocessable. Only the Paystack-side subscription needs undoing.
    if (paystackSub?.code && paystackSub?.emailToken) {
      logger.error('Activation transaction failed after Paystack subscription created — disabling on Paystack to avoid orphan billing', {
        reference,
        subscriptionCode: paystackSub.code,
        error: (err as Error).message,
      });
      await disablePaystackSubscription(paystackSub.code, paystackSub.emailToken);
    }
    throw err;
  }

  await deliverActivation(payment.channel, payment.userId, payment.planId);
};

// charge.success for a Paystack-managed subscription. NOTE: in practice Paystack
// usually omits the `subscription` object from recurring charge.success events —
// the renewal is instead driven by invoice.update (see handleInvoiceUpdate). This
// path is kept as a best-effort handler for the cases where the code IS present;
// it shares applyRecurringRenewal so the two paths can't double-extend.
const handleRecurringCharge = async (data: any): Promise<void> => {
  await applyRecurringRenewal(data.subscription.subscription_code, {
    reference: data.reference,
    amount: Number(data.amount),
    paidAt: data.paid_at,
    authorizationCode: data.authorization?.authorization_code,
    customerCode: data.customer?.customer_code,
    raw: data,
  });
};

// Fallback for recurring charges that arrive with neither a local Payment row nor
// a subscription_code — the shape this Paystack account actually sends (and for
// which no invoice.update follows). Such a charge still carries the reusable card
// authorization and the plan_code, which together identify the subscription.
//
// Kept deliberately narrow so it cannot hijack an unrelated charge: it requires an
// authorization match, prefers a plan match, and refuses to guess when a single
// authorization spans multiple candidate subscriptions. Returns true if handled.
const tryRecurringRenewalFromCharge = async (data: any): Promise<boolean> => {
  const authorizationCode = data.authorization?.authorization_code;
  const customerCode = data.customer?.customer_code;
  if (!authorizationCode && !customerCode) return false;

  // Present on recurring charges, empty ({}) on the initial charge — so it both
  // identifies the plan and marks this as a recurring charge.
  const planCode = data.plan?.plan_code;
  const matched = planCode ? await findByPaystackPlanCode(planCode) : undefined;
  const plan = matched?.plan;

  const planFilter = plan ? { planId: plan.code } : {};
  const findBy = (where: object, includeCancelled: boolean) =>
    prisma.subscription.findMany({
      where: {
        ...(includeCancelled ? {} : { status: { not: 'CANCELLED' as const } }),
        ...planFilter,
        ...where,
      },
      orderBy: { createdAt: 'desc' },
    });

  // Authorization first — it is the most specific. Falling back to customer code
  // matters because the authorization rotates whenever the customer replaces
  // their card, while the customer code does not.
  const search = async (includeCancelled: boolean) => {
    if (authorizationCode) {
      const byAuth = await findBy({ paystackAuthorizationCode: authorizationCode }, includeCancelled);
      if (byAuth.length) return { matchedBy: 'authorization', candidates: byAuth };
    }
    if (customerCode) {
      const byCustomer = await findBy({ paystackCustomerCode: customerCode }, includeCancelled);
      if (byCustomer.length) return { matchedBy: 'customer', candidates: byCustomer };
    }
    return { matchedBy: 'none', candidates: [] as Awaited<ReturnType<typeof findBy>> };
  };

  // Live subscriptions first, so an active one is never passed over in favour of
  // an old cancelled row for the same card.
  let { matchedBy, candidates } = await search(false);

  // Nothing live: retry including CANCELLED. Paystack sometimes keeps billing a
  // subscription we cancelled locally — matching it here lets the renewal core
  // disable it upstream instead of the charge falling through unattributed and
  // the customer being debited indefinitely.
  if (candidates.length === 0) {
    ({ matchedBy, candidates } = await search(true));
    if (candidates.length) matchedBy += ' (cancelled)';
  }

  if (candidates.length === 0) return false;

  // Ambiguous: same card/customer, multiple live plans, and no plan_code to
  // disambiguate. Extending the wrong one is worse than not extending.
  if (candidates.length > 1 && !plan) {
    await alertAdmins('Recurring charge matches multiple subscriptions and has no plan_code — not extending', {
      reference: data.reference,
      matchedBy,
      authorizationCode,
      customerCode,
      subscriptionIds: candidates.map((s) => s.id).join(', '),
    });
    return false;
  }

  const subscription = candidates[0];
  logger.info('Matched recurring charge.success to subscription', {
    reference: data.reference,
    subscriptionId: subscription.id,
    matchedBy,
    authorizationCode,
    planCode,
  });

  await applyRecurringRenewalToSubscription(subscription, {
    reference: data.reference,
    amount: Number(data.amount),
    paidAt: data.paid_at,
    authorizationCode,
    customerCode,
    raw: data,
  });
  return true;
};

// invoice.update is Paystack's reliable signal that a recurring billing cycle
// resolved. A successful one (paid + status:success) is what actually renews a
// subscription, because the matching charge.success typically arrives WITHOUT
// a subscription_code and so can't be linked on its own.
const handleInvoiceUpdate = async (data: any): Promise<void> => {
  const succeeded = data.paid === true || data.status === 'success';
  if (!succeeded) {
    // Failures are handled by invoice.payment_failed; nothing to do here.
    logger.info('Ignoring non-successful invoice.update', {
      status: data.status,
      paid: data.paid,
      invoiceCode: data.invoice_code,
    });
    return;
  }

  const subscriptionCode = data.subscription?.subscription_code;
  if (!subscriptionCode) {
    logger.warn('invoice.update success without subscription_code — skipping', {
      invoiceCode: data.invoice_code,
    });
    return;
  }

  const txn = data.transaction ?? {};
  await applyRecurringRenewal(subscriptionCode, {
    reference: txn.reference,
    amount: Number(txn.amount ?? data.amount),
    paidAt: txn.paid_at ?? data.paid_at,
    authorizationCode:
      data.authorization?.authorization_code ?? txn.authorization?.authorization_code,
    customerCode: data.customer?.customer_code ?? txn.customer?.customer_code,
    raw: data,
  });
};

// Shared application of a successful recurring charge. Idempotent on the
// transaction reference so the charge.success and invoice.update events for the
// same renewal cannot extend the subscription twice.
type RecurringCharge = {
  reference?: string;
  amount: number;
  paidAt?: string;
  authorizationCode?: string;
  customerCode?: string;
  raw: any;
};

// Resolve by Paystack subscription_code. Used by events that carry it
// (invoice.update, and the charge.success variant that includes `subscription`).
const applyRecurringRenewal = async (
  subscriptionCode: string,
  charge: RecurringCharge,
): Promise<void> => {
  const subscription = await prisma.subscription.findFirst({
    where: { paystackSubscriptionCode: subscriptionCode },
  });

  if (!subscription) {
    logger.warn('Subscription not found for recurring charge', { subscriptionCode });
    return;
  }

  await applyRecurringRenewalToSubscription(subscription, charge);
};

// Core renewal against an already-resolved subscription. Idempotent on the
// transaction reference, so the invoice.update path and the authorization
// fallback below can both fire for one charge without double-extending.
const applyRecurringRenewalToSubscription = async (
  subscription: Subscription,
  charge: RecurringCharge,
): Promise<void> => {
  const subscriptionCode = subscription.paystackSubscriptionCode;

  // A CANCELLED sub was explicitly terminated (user/admin intent). Reviving
  // it on a Paystack-driven charge would grant access we don't want to grant,
  // and re-bill the customer on a cycle they thought was over. Disable on
  // Paystack to stop future invoice attempts.
  if (subscription.status === 'CANCELLED') {
    logger.warn('Recurring charge for CANCELLED subscription — not extending; disabling on Paystack', {
      subscriptionCode,
      subscriptionId: subscription.id,
    });
    if (subscriptionCode && subscription.paystackEmailToken) {
      await disablePaystackSubscription(subscriptionCode, subscription.paystackEmailToken);
    }
    return;
  }

  const price = await priceForSubscription(subscription.planId, subscription.planPriceId);
  if (!price) {
    // Loud, not silent: an unresolvable plan means a paying subscriber's renewal
    // is being dropped.
    await alertAdmins('Renewal dropped — plan/price not found for subscription', {
      subscriptionId: subscription.id,
      planId: subscription.planId,
      reference: charge.reference,
    });
    return;
  }

  if (!currencyMatches(charge.raw)) {
    await alertAdmins('Recurring charge in unexpected currency — subscription NOT extended', {
      subscriptionCode,
      subscriptionId: subscription.id,
      expectedCurrency: PLAN_CURRENCY,
      receivedCurrency: charge.raw?.currency,
    });
    return;
  }

  if (Number(charge.amount) < price.amount) {
    await alertAdmins('Recurring charge below plan price — subscription NOT extended', {
      subscriptionCode,
      subscriptionId: subscription.id,
      expected: price.amount,
      received: charge.amount,
    });
    return;
  }

  // Idempotency: if we've already recorded this transaction, don't extend again.
  if (charge.reference) {
    const existing = await prisma.payment.findUnique({ where: { reference: charge.reference } });
    if (existing?.status === 'SUCCESS') {
      logger.info('Recurring charge already processed, skipping', { reference: charge.reference });
      return;
    }
  }

  await prisma.$transaction(async (tx) => {
    // Extend from the later of (current expiry, now) so a late-delivered webhook
    // never loses already-paid time, and an early one doesn't grant extra.
    const base = subscription.expiryDate > new Date() ? subscription.expiryDate : new Date();
    const expiryDate = new Date(base.getTime() + price.durationDays * 24 * 60 * 60 * 1000);

    const graceEndDate = new Date(expiryDate);
    graceEndDate.setDate(graceEndDate.getDate() + GRACE_PERIOD_DAYS);

    if (charge.reference) {
      await tx.payment.upsert({
        where: { reference: charge.reference },
        update: {
          status: 'SUCCESS',
          paidAt: new Date(charge.paidAt || Date.now()),
          paystackData: redactPaystackData(charge.raw) ?? undefined,
          subscriptionId: subscription.id,
        },
        create: {
          userId: subscription.userId,
          reference: charge.reference,
          amount: charge.amount,
          planId: subscription.planId,
          status: 'SUCCESS',
          paidAt: new Date(charge.paidAt || Date.now()),
          paystackData: redactPaystackData(charge.raw) ?? undefined,
          subscriptionId: subscription.id,
        },
      });
    }

    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'ACTIVE',
        expiryDate,
        graceEndDate,
        // Refresh both identifiers. When a charge matched via customer code
        // after a card change, this stores the new authorization so subsequent
        // renewals match on the more specific key again.
        paystackAuthorizationCode:
          charge.authorizationCode ?? subscription.paystackAuthorizationCode,
        paystackCustomerCode: charge.customerCode ?? subscription.paystackCustomerCode,
      },
    });

    logger.info('Subscription renewed (recurring)', {
      subscriptionCode,
      subscriptionId: subscription.id,
      userId: subscription.userId,
      expiryDate,
    });
  });

  await deliverRenewal(subscription.channel, subscription.userId, subscription.planId);
};

// --- manual renewal via stored authorization ---

const applyRenewalCharge = async (
  subscriptionId: string,
  reference: string,
  data: any,
): Promise<void> => {
  // Outcomes that need an alert or a notification are reported back and handled
  // AFTER the transaction commits — an HTTP call (email) inside an interactive
  // transaction would pin a DB connection for the length of a network round trip.
  type Outcome =
    | { kind: 'noop' }
    | { kind: 'planMissing'; planId: string }
    | { kind: 'underpaid'; expected: number; received: number }
    | { kind: 'renewed' };

  // Resolve pricing before opening the transaction so no plan lookup (which may
  // hit the DB on a cold cache) happens while the transaction holds a connection.
  //
  // Price from the PAYMENT, not the subscription: a plan change pre-links a
  // payment carrying the NEW plan/price, and that is what the customer is being
  // charged for. When they match, this is an ordinary renewal.
  const existing = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  const paymentRow = await prisma.payment.findUnique({ where: { reference } });
  const price = paymentRow
    ? await priceForSubscription(paymentRow.planId, paymentRow.planPriceId)
    : undefined;

  const isPlanChange =
    !!existing &&
    !!paymentRow &&
    (paymentRow.planId !== existing.planId || paymentRow.planPriceId !== existing.planPriceId);

  const outcome = await prisma.$transaction(async (tx): Promise<Outcome> => {
    const payment = await tx.payment.findUnique({ where: { reference } });
    if (!payment || payment.status === 'SUCCESS') return { kind: 'noop' };

    const subscription = await tx.subscription.findUnique({ where: { id: subscriptionId } });
    if (!subscription) return { kind: 'noop' };

    if (!price) return { kind: 'planMissing', planId: subscription.planId };

    if (Number(data.amount) < price.amount) {
      return { kind: 'underpaid', expected: price.amount, received: Number(data.amount) };
    }

    // Extend from the later of (current expiry, now) so an early renewal adds
    // a full period without granting extra free time to an already-expired sub.
    const base = subscription.expiryDate > new Date() ? subscription.expiryDate : new Date();
    const expiryDate = new Date(base.getTime() + price.durationDays * 24 * 60 * 60 * 1000);
    const graceEndDate = new Date(expiryDate);
    graceEndDate.setDate(graceEndDate.getDate() + GRACE_PERIOD_DAYS);

    await tx.payment.update({
      where: { reference },
      data: {
        status: 'SUCCESS',
        paidAt: new Date(data.paid_at || Date.now()),
        paystackData: redactPaystackData(data) ?? undefined,
      },
    });

    await tx.subscription.update({
      where: { id: subscriptionId },
      data: {
        status: 'ACTIVE',
        expiryDate,
        graceEndDate,
        // On a plan change the subscription moves to the plan that was paid for.
        ...(isPlanChange
          ? { planId: paymentRow!.planId, planPriceId: paymentRow!.planPriceId }
          : {}),
        paystackAuthorizationCode:
          data.authorization?.authorization_code ?? subscription.paystackAuthorizationCode,
      },
    });

    logger.info(isPlanChange ? 'Subscription plan changed' : 'Subscription renewed via authorization', {
      subscriptionId,
      reference,
      expiryDate,
      ...(isPlanChange ? { from: subscription.planId, to: paymentRow!.planId } : {}),
    });

    return { kind: 'renewed' };
  });

  if (outcome.kind === 'planMissing') {
    await alertAdmins('Renewal dropped — plan/price not found for subscription', {
      subscriptionId,
      reference,
      planId: outcome.planId,
    });
    return;
  }

  if (outcome.kind === 'underpaid') {
    await alertAdmins('Renewal charge below plan price — subscription NOT extended', {
      subscriptionId,
      reference,
      expected: outcome.expected,
      received: outcome.received,
    });
    return;
  }

  if (outcome.kind !== 'renewed') return;

  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  if (!sub) return;

  // The Paystack subscription is bound to a plan code, so a plan change needs a
  // new one: disable the old (or it keeps billing the old price) and open one on
  // the new plan so future cycles auto-charge correctly.
  if (isPlanChange) {
    if (existing?.paystackSubscriptionCode && existing.paystackEmailToken) {
      await disablePaystackSubscription(existing.paystackSubscriptionCode, existing.paystackEmailToken);
    }

    const newPrice = await priceForSubscription(sub.planId, sub.planPriceId);
    const customerCode = data.customer?.customer_code ?? sub.paystackCustomerCode;
    const authorizationCode = data.authorization?.authorization_code ?? sub.paystackAuthorizationCode;

    const created =
      customerCode && authorizationCode && newPrice
        ? await createPaystackSubscription(customerCode, newPrice.paystackPlanCode, authorizationCode)
        : null;

    await prisma.subscription.update({
      where: { id: sub.id },
      data: {
        paystackSubscriptionCode: created?.code ?? null,
        paystackEmailToken: created?.emailToken ?? null,
        cancelAtPeriodEnd: false,
      },
    });

    if (!created) {
      // Access is granted and paid for, but nothing will auto-renew it.
      await alertAdmins('Plan changed but new Paystack subscription was not created', {
        subscriptionId: sub.id,
        userId: sub.userId,
        newPlanId: sub.planId,
        reference,
      });
    }
  }

  await deliverRenewal(sub.channel, sub.userId, sub.planId);
};

// Generates a Paystack payment link for renewing an EXISTING subscription
// in place. Pre-links the Payment row to the subscription so the eventual
// charge.success webhook routes through applyRenewalCharge (extend the
// existing sub) rather than handleInitialPayment (create a new sub).
export const initializeRenewalPayment = async (
  subscriptionId: string,
): Promise<InitializePaymentResult> => {
  const subscription = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: { user: true },
  });
  if (!subscription) throw new Error('Subscription not found');

  const price = await priceForSubscription(subscription.planId, subscription.planPriceId);
  if (!price) throw new Error(`Unknown plan/price: ${subscription.planId}`);

  const email =
    subscription.user.email ||
    `${subscription.user.phoneNumber}@whatsapp.placeholder.com`;
  const reference = `RNW_${subscription.planId.toUpperCase()}_${uuidv4().slice(0, 8)}`;

  await prisma.payment.create({
    data: {
      userId: subscription.userId,
      subscriptionId: subscription.id,
      reference,
      amount: price.amount,
      planId: subscription.planId,
      planPriceId: price.id,
      status: 'PENDING',
    },
  });

  try {
    const response = await paystackClient.post('/transaction/initialize', {
      email,
      amount: price.amount,
      reference,
      // Card only — a renewal must leave behind a reusable authorization, or the
      // subscription can never auto-charge again. See initializePayment.
      channels: ['card'],
      metadata: {
        userId: subscription.userId,
        planId: subscription.planId,
        subscriptionId: subscription.id,
        renewal: true,
      },
    });

    return {
      reference,
      authorizationUrl: response.data.data.authorization_url,
      accessCode: response.data.data.access_code,
    };
  } catch (error: any) {
    logger.error('Failed to initialize renewal payment', {
      subscriptionId,
      reference,
      error: error.response?.data || error.message,
    });
    // Clean up the orphan PENDING row so the user can try again with a fresh ref.
    await prisma.payment.delete({ where: { reference } }).catch(() => {});
    throw new Error('Failed to initialize renewal payment');
  }
};

// --- subscription.create ---

const handleSubscriptionCreated = async (data: any): Promise<void> => {
  const { subscription_code, email_token } = data;
  const customerEmail = data.customer?.email;
  const planCode = data.plan?.plan_code;

  // Try updating by subscription_code first (charge.success already stored it)
  const updated = await prisma.subscription.updateMany({
    where: { paystackSubscriptionCode: subscription_code },
    data: { paystackEmailToken: email_token },
  });

  // If nothing matched, charge.success didn't store the code — find the subscription
  // by the customer phone/email + plan and backfill both the code and email token
  if (updated.count === 0 && customerEmail && planCode) {
    const phoneNumber = customerEmail.endsWith('@whatsapp.placeholder.com')
      ? customerEmail.replace('@whatsapp.placeholder.com', '')
      : null;

    const user = await prisma.user.findFirst({
      where: phoneNumber ? { phoneNumber } : { email: customerEmail },
    });

    if (user) {
      const matched = await findByPaystackPlanCode(planCode);

      if (matched) {
        await prisma.subscription.updateMany({
          where: {
            userId: user.id,
            planId: matched.plan.code,
            paystackSubscriptionCode: null,
            status: { in: ['ACTIVE', 'GRACE'] },
          },
          data: {
            paystackSubscriptionCode: subscription_code,
            paystackEmailToken: email_token,
          },
        });

        logger.info('Backfilled missing subscription code', { subscription_code, userId: user.id });
      }
    }
  }

  logger.info('Subscription created event processed', { subscription_code });
};

// --- subscription.disable ---

const handleSubscriptionDisabled = async (data: any): Promise<void> => {
  const { subscription_code } = data;

  // Skip if already terminal — when we disable in response to a failed invoice
  // we set the row to EXPIRED first, and the resulting webhook should not
  // overwrite that with CANCELLED.
  await prisma.subscription.updateMany({
    where: {
      paystackSubscriptionCode: subscription_code,
      status: { notIn: ['EXPIRED', 'CANCELLED'] },
    },
    data: { status: 'CANCELLED' },
  });

  logger.info('Subscription cancelled', { subscription_code });
};

// --- subscription.not_renew ---

// Paystack will not auto-charge this subscription again, but the period already
// paid for still runs. Flag it rather than cancelling: the customer keeps the
// access they bought, we just stop promising a renewal that isn't coming, and
// the expiry sweep retires it naturally at period end.
const handleSubscriptionNotRenew = async (data: any): Promise<void> => {
  const subscriptionCode = data.subscription_code ?? data.subscription?.subscription_code;
  if (!subscriptionCode) {
    logger.warn('subscription.not_renew without subscription_code — skipping');
    return;
  }

  const updated = await prisma.subscription.updateMany({
    where: { paystackSubscriptionCode: subscriptionCode, status: { in: ['ACTIVE', 'GRACE'] } },
    data: { cancelAtPeriodEnd: true },
  });

  logger.info('Subscription marked as not renewing', {
    subscriptionCode,
    matched: updated.count,
  });
};

// --- refunds & disputes ---

// A refunded charge must not keep granting access. Revokes the subscription the
// refunded payment paid for.
const handleRefundProcessed = async (data: any): Promise<void> => {
  const reference = data.transaction_reference ?? data.transaction?.reference ?? data.reference;
  if (!reference) {
    logger.warn('refund.processed without a transaction reference — skipping');
    return;
  }

  const payment = await prisma.payment.findUnique({ where: { reference } });
  if (!payment) {
    logger.warn('Payment not found for refund', { reference });
    return;
  }

  await prisma.payment.update({
    where: { reference },
    data: { status: 'REFUNDED' },
  });

  if (!payment.subscriptionId) {
    logger.info('Refund processed for payment with no linked subscription', { reference });
    return;
  }

  const subscription = await prisma.subscription.findUnique({
    where: { id: payment.subscriptionId },
  });

  // Stop Paystack re-billing a subscription we're about to revoke.
  if (subscription?.paystackSubscriptionCode && subscription.paystackEmailToken) {
    await disablePaystackSubscription(
      subscription.paystackSubscriptionCode,
      subscription.paystackEmailToken,
    );
  }

  await prisma.subscription.updateMany({
    where: { id: payment.subscriptionId, status: { in: ['ACTIVE', 'GRACE'] } },
    data: { status: 'CANCELLED' },
  });

  await alertAdmins('Subscription revoked due to refund', {
    reference,
    subscriptionId: payment.subscriptionId,
    userId: payment.userId,
  });
};

// Disputes are not resolved yet and can still be won, so access is left intact —
// revoking on a dispute that we later win would penalise a legitimate customer.
// Surfaced loudly for operator attention instead.
const handleDisputeOpened = async (data: any): Promise<void> => {
  const reference = data.transaction?.reference ?? data.transaction_reference;
  await alertAdmins('Chargeback/dispute opened — operator review required', {
    reference,
    disputeId: data.id,
    status: data.status,
    amount: data.refund_amount ?? data.transaction?.amount,
  });
};

// Only a dispute lost to the customer means the money is gone; revoke then.
const handleDisputeResolved = async (data: any): Promise<void> => {
  const reference = data.transaction?.reference ?? data.transaction_reference;
  const resolution: string = data.resolution ?? '';
  const lost = /merchant-accepted|lost/i.test(resolution);

  logger.warn('Dispute resolved', { reference, resolution, revokingAccess: lost });

  if (lost && reference) {
    await handleRefundProcessed({ transaction_reference: reference });
  }
};

// --- invoice.payment_failed ---

const handleInvoicePaymentFailed = async (data: any): Promise<void> => {
  const subscriptionCode = data.subscription?.subscription_code;
  if (!subscriptionCode) return;

  const subscription = await prisma.subscription.findUnique({
    where: { paystackSubscriptionCode: subscriptionCode },
  });

  if (!subscription) {
    logger.warn('Subscription not found for failed invoice', { subscriptionCode });
    return;
  }

  // Insufficient-funds failures are transient — Paystack will auto-retry and a
  // future recurring charge.success will move this sub back to ACTIVE. Anything
  // else (card declined, expired, stolen, fraud, etc.) is treated as terminal.
  //
  // Paystack does NOT put the decline reason in the invoice.payment_failed
  // payload, so fetch the subscription and read most_recent_invoice.description
  // (e.g. "Insufficient funds", "Card expired", "Bank declined the transaction").
  const paystackSub = await fetchPaystackSubscription(subscriptionCode);
  const invoice = paystackSub?.most_recent_invoice;

  const reason: string = invoice?.description ?? '';
  const isInsufficientFunds = /insufficient\s*funds?/i.test(reason);

  // If we couldn't resolve the reason (fetch failed, or no description), default
  // to the transient path: GRACE keeps access reversible while Paystack keeps
  // retrying. Treating an unknown failure as terminal would wrongly disable the
  // subscription and stop retries that might otherwise succeed.
  const reasonResolved = reason.length > 0;
  const treatAsTerminal = reasonResolved && !isInsufficientFunds;

  logger.info('Invoice payment failed', {
    subscriptionId: subscription.id,
    subscriptionCode,
    reason: reason || '(unresolved)',
    invoiceStatus: invoice?.status,
    nextAction: treatAsTerminal ? 'EXPIRED' : 'GRACE',
  });

  if (!treatAsTerminal) {
    await moveToGracePeriod(subscription.id);
  } else {
    if (subscription.paystackSubscriptionCode && subscription.paystackEmailToken) {
      await disablePaystackSubscription(
        subscription.paystackSubscriptionCode,
        subscription.paystackEmailToken,
      );
    } else {
      logger.warn('Missing subscription code/token; cannot disable on Paystack', {
        subscriptionId: subscription.id,
      });
    }
    await expireSubscription(subscription.id);
  }
};

// --- charge.failed ---

const handleFailedPayment = async (reference: string): Promise<void> => {
  await prisma.payment.updateMany({
    where: { reference },
    data: { status: 'FAILED' },
  });

  logger.info('Payment marked as failed', { reference });
};

// --- plan configuration drift ---

// Days granted locally per charge, keyed by Paystack's billing interval.
const INTERVAL_DAYS: Record<string, number> = {
  hourly: 1 / 24,
  daily: 1,
  weekly: 7,
  monthly: 30,
  quarterly: 90,
  biannually: 180,
  annually: 365,
};

// What each local BillingInterval should look like on Paystack.
const EXPECTED_PAYSTACK_INTERVAL: Record<string, string> = {
  HOURLY: 'hourly',
  DAILY: 'daily',
  MONTHLY: 'monthly',
  SEMIANNUAL: 'biannually',
  ANNUAL: 'annually',
};

export interface PlanCheck {
  planId: string;
  interval: string;
  paystackPlanCode: string;
  localDurationDays: number;
  paystackInterval?: string;
  expectedDurationDays?: number;
  localAmount: number;
  paystackAmount?: number;
  ok: boolean;
  issues: string[];
}

// Paystack owns the charge cadence and price; this app owns how much access a
// charge grants. Nothing keeps those in sync, so a dashboard edit (or a stale
// *_PLAN_DURATION_DAYS env) silently gives users too much or too little time.
// This compares the two and reports drift.
export const verifyPlanConfiguration = async (): Promise<PlanCheck[]> => {
  const checks: PlanCheck[] = [];

  for (const plan of await getAllPlans()) {
    for (const price of plan.prices) {
      const check: PlanCheck = {
        planId: plan.code,
        interval: price.interval,
        paystackPlanCode: price.paystackPlanCode,
        localDurationDays: price.durationDays,
        localAmount: price.amount,
        ok: true,
        issues: [],
      };

      // Placeholders are seeded deliberately for plans that aren't live yet;
      // flag them as not-configured rather than calling Paystack.
      if (price.paystackPlanCode.startsWith('PLN_TODO_')) {
        check.issues.push('Paystack plan code not set yet (placeholder)');
        check.ok = false;
        checks.push(check);
        continue;
      }

      try {
        const { data: res } = await paystackClient.get(`/plan/${price.paystackPlanCode}`);
        const remote = res.data;

        check.paystackInterval = remote?.interval;
        check.paystackAmount = remote?.amount;
        check.expectedDurationDays = INTERVAL_DAYS[remote?.interval];

        const expectedInterval = EXPECTED_PAYSTACK_INTERVAL[price.interval];
        if (expectedInterval && remote?.interval !== expectedInterval) {
          check.issues.push(
            `Local interval ${price.interval} expects Paystack "${expectedInterval}" but plan bills "${remote?.interval}"`,
          );
        }

        if (check.expectedDurationDays === undefined) {
          check.issues.push(`Unrecognised Paystack interval "${remote?.interval}"`);
        } else if (Math.abs(check.expectedDurationDays - price.durationDays) > 1e-6) {
          check.issues.push(
            `Paystack bills ${remote.interval} (${check.expectedDurationDays}d) but local durationDays is ${price.durationDays}`,
          );
        }

        if (typeof remote?.amount === 'number' && remote.amount !== price.amount) {
          check.issues.push(`Paystack amount ${remote.amount} != local amount ${price.amount}`);
        }
      } catch (error: any) {
        check.issues.push(
          `Could not fetch plan from Paystack: ${error.response?.data?.message || error.message}`,
        );
      }

      check.ok = check.issues.length === 0;
      if (!check.ok) {
        await alertAdmins('Plan configuration drift between Paystack and local config', {
          planId: plan.code,
          interval: price.interval,
          issues: check.issues.join('; '),
        });
      }
      checks.push(check);
    }
  }

  logger.info('Plan configuration verified', {
    total: checks.length,
    drifted: checks.filter((c) => !c.ok).length,
  });
  return checks;
};

// Starts an upgrade/downgrade. The switch is applied only once the charge
// succeeds (see applyRenewalCharge), so an abandoned payment changes nothing.
//
// Policy: the new plan takes effect immediately and unused days on the old plan
// are carried over rather than refunded — Paystack has no native proration, and
// crediting value would mean charging a custom amount outside the plan model.
export const initializePlanChange = async (
  subscriptionId: string,
  newPlanId: string,
  interval?: BillingInterval,
): Promise<InitializePaymentResult> => {
  const subscription = await prisma.subscription.findUnique({
    where: { id: subscriptionId },
    include: { user: true },
  });
  if (!subscription) throw new Error('Subscription not found');

  const plan = await resolvePlan(newPlanId);
  if (!plan?.isActive) throw new Error(`Unknown or unavailable plan: ${newPlanId}`);

  const price = interval
    ? plan.prices.find((pr) => pr.interval === interval && pr.isActive)
    : plan.defaultPrice;
  if (!price?.isActive) throw new Error(`No purchasable ${interval ?? 'default'} price for ${newPlanId}`);

  if (subscription.planId === newPlanId && subscription.planPriceId === price.id) {
    throw new SamePlanError(newPlanId);
  }

  // Moving INTO a capped plan consumes a seat, so it must be checked before
  // taking money — same rule as a new subscription.
  if (subscription.planId !== newPlanId) {
    const capacity = await checkCapacity(newPlanId);
    if (!capacity.hasCapacity) throw new PlanFullError(newPlanId, capacity.limit ?? 0);
  }

  const email =
    subscription.user.email || `${subscription.user.phoneNumber}@whatsapp.placeholder.com`;
  const reference = `CHG_${newPlanId.toUpperCase()}_${uuidv4().slice(0, 8)}`;

  // Pre-linked to the subscription and carrying the NEW plan/price — that
  // mismatch is what applyRenewalCharge reads as "this is a plan change".
  await prisma.payment.create({
    data: {
      userId: subscription.userId,
      subscriptionId: subscription.id,
      reference,
      amount: price.amount,
      planId: newPlanId,
      planPriceId: price.id,
      status: 'PENDING',
      channel: subscription.channel,
    },
  });

  try {
    const callbackUrl = env.FRONTEND_URL
      ? `${env.FRONTEND_URL.replace(/\/$/, '')}/payment/success?reference=${reference}`
      : undefined;

    const response = await paystackClient.post('/transaction/initialize', {
      email,
      amount: price.amount,
      reference,
      channels: ['card'],
      ...(callbackUrl ? { callback_url: callbackUrl } : {}),
      metadata: {
        userId: subscription.userId,
        subscriptionId: subscription.id,
        planId: newPlanId,
        interval: price.interval,
        planChange: true,
      },
    });

    logger.info('Plan change initialized', {
      subscriptionId,
      from: subscription.planId,
      to: newPlanId,
      interval: price.interval,
      reference,
    });

    return {
      reference,
      authorizationUrl: response.data.data.authorization_url,
      accessCode: response.data.data.access_code,
    };
  } catch (error: any) {
    logger.error('Failed to initialize plan change', {
      subscriptionId,
      reference,
      error: error.response?.data || error.message,
    });
    await prisma.payment.delete({ where: { reference } }).catch(() => {});
    throw new Error('Failed to initialize plan change');
  }
};

// --- reconciliation ---

export interface ReconciliationResult {
  pendingChecked: number;
  activated: number;
  markedFailed: number;
  subscriptionsChecked: number;
  subscriptionsCorrected: number;
  expiryCorrected: number;
  webhooksReplayed: number;
  errors: number;
}

// Paystack's webhooks are the fast path, not the source of truth — this account
// has demonstrably dropped events (zero invoice.update across 62 charges). This
// pulls state from Paystack's API instead, so anything a missed webhook would
// have done gets done anyway.
//
// Idempotent: activation and renewal are both keyed on the transaction reference,
// so re-running is safe and re-running often is cheap.
export const runReconciliation = async (opts?: {
  pendingOlderThanMinutes?: number;
  maxAgeDays?: number;
  batchSize?: number;
  includeSubscriptions?: boolean;
}): Promise<ReconciliationResult> => {
  const pendingOlderThanMinutes = opts?.pendingOlderThanMinutes ?? 10;
  const maxAgeDays = opts?.maxAgeDays ?? 7;
  const batchSize = opts?.batchSize ?? 50;

  const result: ReconciliationResult = {
    pendingChecked: 0,
    activated: 0,
    markedFailed: 0,
    subscriptionsChecked: 0,
    subscriptionsCorrected: 0,
    expiryCorrected: 0,
    webhooksReplayed: 0,
    errors: 0,
  };

  // --- 0. Replay webhooks we received but failed to process ---
  // The handler acks 200 even when processing throws, so Paystack considers
  // these delivered and will never retry them. Without a replay they are lost
  // permanently. Every handler is idempotent, so re-running is safe.
  const unprocessed = await prisma.webhookLog.findMany({
    where: {
      source: 'paystack',
      processed: false,
      // Never replay events that failed signature verification — they were
      // rejected as unauthenticated and must stay rejected.
      NOT: { error: 'signature_invalid' },
      createdAt: { gte: new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000) },
    },
    orderBy: { createdAt: 'asc' },
    take: batchSize,
  });

  for (const log of unprocessed) {
    try {
      await processWebhookEvent(log.payload as any);
      await prisma.webhookLog.update({
        where: { id: log.id },
        data: { processed: true, error: null },
      });
      result.webhooksReplayed++;
      logger.info('Replayed a webhook that failed on first delivery', {
        webhookLogId: log.id,
        eventType: log.eventType,
      });
    } catch (error: any) {
      result.errors++;
      await prisma.webhookLog
        .update({ where: { id: log.id }, data: { error: `replay: ${error.message}` } })
        .catch(() => {});
      logger.error('Webhook replay failed', { webhookLogId: log.id, error: error.message });
    }
  }

  // --- 1. Payments stuck PENDING ---
  // Old enough that a webhook should have arrived, recent enough to still matter.
  const stuck = await prisma.payment.findMany({
    where: {
      status: 'PENDING',
      createdAt: {
        lte: new Date(Date.now() - pendingOlderThanMinutes * 60 * 1000),
        gte: new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000),
      },
    },
    orderBy: { createdAt: 'asc' },
    take: batchSize,
  });

  for (const payment of stuck) {
    result.pendingChecked++;
    try {
      const { data: res } = await paystackClient.get(`/transaction/verify/${payment.reference}`);
      const data = res.data;

      if (data?.status === 'success') {
        // Same idempotent path the webhook uses.
        await handleInitialPayment(payment.reference, data);
        result.activated++;
        logger.info('Reconciliation activated a stuck payment', { reference: payment.reference });
      } else if (data?.status === 'failed' || data?.status === 'abandoned') {
        // Terminal on Paystack's side — stop reconsidering it every run.
        await prisma.payment.updateMany({
          where: { reference: payment.reference, status: 'PENDING' },
          data: { status: 'FAILED' },
        });
        result.markedFailed++;
      }
      // Anything else (still genuinely pending) is left for the next run.
    } catch (error: any) {
      result.errors++;
      logger.error('Reconciliation failed for payment', {
        reference: payment.reference,
        error: error.response?.data || error.message,
      });
    }
  }

  // --- 2. Subscription state drift ---
  if (opts?.includeSubscriptions) {
    const subs = await prisma.subscription.findMany({
      where: {
        status: { in: ['ACTIVE', 'GRACE'] },
        paystackSubscriptionCode: { not: null },
      },
      orderBy: { updatedAt: 'asc' },
      take: batchSize,
    });

    for (const sub of subs) {
      result.subscriptionsChecked++;
      try {
        const { data: res } = await paystackClient.get(
          `/subscription/${sub.paystackSubscriptionCode}`,
        );
        const remote = res.data;
        const remoteStatus: string = remote?.status ?? '';

        // Paystack says it will not renew, but we still expect a renewal.
        if (remoteStatus === 'non-renewing' && !sub.cancelAtPeriodEnd) {
          await prisma.subscription.update({
            where: { id: sub.id },
            data: { cancelAtPeriodEnd: true },
          });
          result.subscriptionsCorrected++;
          logger.info('Reconciliation: marked subscription non-renewing', { subscriptionId: sub.id });
        }

        // Paystack has ended it entirely; ours should not stay live past expiry.
        if ((remoteStatus === 'cancelled' || remoteStatus === 'complete') && !sub.cancelAtPeriodEnd) {
          await prisma.subscription.update({
            where: { id: sub.id },
            data: { cancelAtPeriodEnd: true },
          });
          result.subscriptionsCorrected++;
          logger.info('Reconciliation: Paystack subscription ended', {
            subscriptionId: sub.id,
            remoteStatus,
          });
        }

        // Self-heal a renewal whose events were all lost. Paystack's
        // next_payment_date is when the CURRENT paid period ends, so our
        // expiryDate should track it. If theirs is meaningfully further out,
        // they have collected for a period we never granted — and without this
        // the expiry sweep would eventually cut off a paying customer.
        const nextPayment = remote?.next_payment_date ? new Date(remote.next_payment_date) : null;
        const TOLERANCE_MS = 24 * 60 * 60 * 1000; // ignore clock/settlement skew

        if (
          nextPayment &&
          !Number.isNaN(nextPayment.getTime()) &&
          nextPayment.getTime() - sub.expiryDate.getTime() > TOLERANCE_MS
        ) {
          const graceEndDate = new Date(nextPayment);
          graceEndDate.setDate(graceEndDate.getDate() + GRACE_PERIOD_DAYS);

          await prisma.subscription.update({
            where: { id: sub.id },
            data: { status: 'ACTIVE', expiryDate: nextPayment, graceEndDate },
          });
          result.expiryCorrected++;

          await alertAdmins('Renewal recovered by reconciliation — webhooks were missed', {
            subscriptionId: sub.id,
            userId: sub.userId,
            planId: sub.planId,
            wasExpiringAt: sub.expiryDate.toISOString(),
            nowExpiringAt: nextPayment.toISOString(),
          });
        }
      } catch (error: any) {
        result.errors++;
        logger.error('Reconciliation failed for subscription', {
          subscriptionId: sub.id,
          error: error.response?.data || error.message,
        });
      }
    }
  }

  logger.info('Reconciliation complete', { ...result });

  // Activating a stuck payment means a customer waited on a webhook that never
  // came — worth knowing about, since a pattern of it means webhooks are broken.
  if (result.activated > 0) {
    await alertAdmins('Reconciliation activated payments a webhook should have handled', {
      activated: result.activated,
      pendingChecked: result.pendingChecked,
    });
  }

  return result;
};

export const getPaymentByReference = async (reference: string) => {
  return prisma.payment.findUnique({
    where: { reference },
    include: {
      user: true,
      subscription: true,
    },
  });
};

export const getUserPayments = async (userId: string) => {
  return prisma.payment.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
};
