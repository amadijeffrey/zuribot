import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { SUBSCRIPTION_PLANS, GRACE_PERIOD_DAYS } from '../config/constants';
import { sendActivationConfirmation, sendRenewalConfirmation, sendExpiryReminder, moveToGracePeriod, expireSubscription } from './subscription';
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

export const initializePayment = async (
  params: InitializePaymentParams
): Promise<InitializePaymentResult> => {
  const { userId, planId, email } = params;
  const plan = SUBSCRIPTION_PLANS[planId as keyof typeof SUBSCRIPTION_PLANS];

  if (!plan) throw new Error(`Unknown plan: ${planId}`);

  const reference = `SUB_${planId.toUpperCase()}_${uuidv4().slice(0, 8)}`;

  try {
    await prisma.payment.create({
      data: {
        userId,
        reference,
        amount: plan.amount,
        planId,
        status: 'PENDING',
      },
    });

    logger.info('Initializing Paystack transaction', {
      reference,
      planId,
      paystackPlanCode: plan.paystackPlanCode,
    });

    // Note: `plan` is intentionally NOT passed here. Letting Paystack auto-create
    // the subscription means the subscription_code only arrives via the separate
    // subscription.create webhook (racy + best-effort). Instead, we charge once now
    // and explicitly POST /subscription after charge.success to get the code back
    // synchronously.
    const response = await paystackClient.post('/transaction/initialize', {
      email,
      amount: plan.amount,
      reference,
      // callback_url: `${env.API_BASE_URL}/payment/callback`,
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

    logger.info('Paystack transaction initialized', {
      reference,
      userId,
      planId,
      paystackPlanCode: plan.paystackPlanCode,
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

  await sendExpiryReminder(subscription.user.phoneNumber, subscription.planId, 3);
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
    logger.warn('Payment not found for charge.success', { reference: data.reference });
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

const handleInitialPayment = async (reference: string, data: any): Promise<void> => {
  const payment = await prisma.payment.findUnique({
    where: { reference },
    include: { user: true },
  });

  if (!payment) {
    logger.error('Payment not found', { reference });
    return;
  }

  // Idempotency: webhook delivery + manual /payment/verify can both fire for
  // the same reference. First caller flips status to SUCCESS; later callers
  // no-op so we don't double-create the Subscription / double-bill on Paystack.
  if (payment.status === 'SUCCESS') {
    logger.info('Payment already processed — skipping initial activation', { reference });
    return;
  }

  const plan = SUBSCRIPTION_PLANS[payment.planId as keyof typeof SUBSCRIPTION_PLANS];
  if (!plan) throw new Error(`Plan not found: ${payment.planId}`);

  // Trust Paystack as the source of truth for what was actually charged.
  // Underpayments must NOT grant access — operator review required.
  if (Number(data.amount) < plan.amount) {
    logger.error('ALERT: charge amount below plan price — payment recorded, subscription NOT activated', {
      reference,
      userId: payment.userId,
      planId: payment.planId,
      expected: plan.amount,
      received: data.amount,
    });
    await prisma.payment.update({
      where: { reference },
      data: {
        status: 'SUCCESS',
        paidAt: new Date(data.paid_at || Date.now()),
        paystackData: data,
      },
    });
    return;
  }

  const customerCode = data.customer?.customer_code;
  const authorizationCode = data.authorization?.authorization_code;

  const paystackSub =
    customerCode && authorizationCode && plan.paystackPlanCode
      ? await createPaystackSubscription(customerCode, plan.paystackPlanCode, authorizationCode)
      : null;

  if (!paystackSub) {
    logger.warn('No Paystack subscription code at activation; subscription.create webhook will backfill if it arrives', {
      reference,
      hasCustomerCode: !!customerCode,
      hasAuthorizationCode: !!authorizationCode,
    });
  }

  try {
    await prisma.$transaction(async (tx) => {
      await tx.payment.update({
        where: { reference },
        data: {
          status: 'SUCCESS',
          paidAt: new Date(data.paid_at || Date.now()),
          paystackData: data,
        },
      });

      const startDate = new Date();
      const expiryDate = new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000);

      const graceEndDate = new Date(expiryDate);
      graceEndDate.setDate(graceEndDate.getDate() + GRACE_PERIOD_DAYS);

      const subscription = await tx.subscription.create({
        data: {
          userId: payment.userId,
          planId: payment.planId,
          status: 'ACTIVE',
          startDate,
          expiryDate,
          graceEndDate,
          paystackSubscriptionCode: paystackSub?.code ?? null,
          paystackEmailToken: paystackSub?.emailToken ?? null,
          paystackAuthorizationCode: authorizationCode ?? null,
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
    // Compensation: we already created the Paystack subscription before the
    // DB transaction. If the tx failed, disable it on Paystack so the customer
    // isn't auto-billed against a sub we have no record of locally.
    if (paystackSub?.code && paystackSub?.emailToken) {
      logger.error('DB transaction failed after Paystack subscription created — disabling on Paystack to avoid orphan billing', {
        reference,
        subscriptionCode: paystackSub.code,
        error: (err as Error).message,
      });
      await disablePaystackSubscription(paystackSub.code, paystackSub.emailToken);
    }
    throw err;
  }

  await sendActivationConfirmation(payment.userId, payment.planId);
};

const handleRecurringCharge = async (data: any): Promise<void> => {
  const subscriptionCode = data.subscription.subscription_code;

  const subscription = await prisma.subscription.findFirst({
    where: { paystackSubscriptionCode: subscriptionCode },
  });

  if (!subscription) {
    logger.warn('Subscription not found for recurring charge', { subscriptionCode });
    return;
  }

  // A CANCELLED sub was explicitly terminated (user/admin intent). Reviving
  // it on a Paystack-driven charge would grant access we don't want to grant,
  // and re-bill the customer on a cycle they thought was over. Disable on
  // Paystack to stop future invoice attempts.
  if (subscription.status === 'CANCELLED') {
    logger.warn('Recurring charge.success for CANCELLED subscription — not extending; disabling on Paystack', {
      subscriptionCode,
      subscriptionId: subscription.id,
    });
    if (subscription.paystackEmailToken) {
      await disablePaystackSubscription(subscriptionCode, subscription.paystackEmailToken);
    }
    return;
  }

  const plan = SUBSCRIPTION_PLANS[subscription.planId as keyof typeof SUBSCRIPTION_PLANS];
  if (!plan) return;

  if (Number(data.amount) < plan.amount) {
    logger.error('ALERT: recurring charge amount below plan price — not extending subscription', {
      subscriptionCode,
      subscriptionId: subscription.id,
      expected: plan.amount,
      received: data.amount,
    });
    return;
  }

  await prisma.$transaction(async (tx) => {
    const expiryDate = new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000);

    const graceEndDate = new Date(expiryDate);
    graceEndDate.setDate(graceEndDate.getDate() + GRACE_PERIOD_DAYS);

    const newPayment = await tx.payment.create({
      data: {
        userId: subscription.userId,
        reference: data.reference,
        amount: data.amount,
        planId: subscription.planId,
        status: 'SUCCESS',
        paidAt: new Date(data.paid_at || Date.now()),
        paystackData: data,
        subscriptionId: subscription.id,
      },
    });

    await tx.subscription.update({
      where: { id: subscription.id },
      data: {
        status: 'ACTIVE',
        expiryDate,
        graceEndDate,
        paystackAuthorizationCode:
          data.authorization?.authorization_code ?? subscription.paystackAuthorizationCode,
      },
    });

    logger.info('Subscription renewed', {
      subscriptionCode,
      paymentId: newPayment.id,
      userId: subscription.userId,
      expiryDate,
    });
  });
};

// --- manual renewal via stored authorization ---

const applyRenewalCharge = async (
  subscriptionId: string,
  reference: string,
  data: any,
): Promise<void> => {
  await prisma.$transaction(async (tx) => {
    const payment = await tx.payment.findUnique({ where: { reference } });
    if (!payment || payment.status === 'SUCCESS') return;

    const subscription = await tx.subscription.findUnique({ where: { id: subscriptionId } });
    if (!subscription) return;

    const plan = SUBSCRIPTION_PLANS[subscription.planId as keyof typeof SUBSCRIPTION_PLANS];
    if (!plan) return;

    if (Number(data.amount) < plan.amount) {
      logger.error('ALERT: renewal charge amount below plan price — not extending subscription', {
        subscriptionId,
        reference,
        expected: plan.amount,
        received: data.amount,
      });
      return;
    }

    // Extend from the later of (current expiry, now) so an early renewal adds
    // a full period without granting extra free time to an already-expired sub.
    const base = subscription.expiryDate > new Date() ? subscription.expiryDate : new Date();
    const expiryDate = new Date(base.getTime() + plan.durationDays * 24 * 60 * 60 * 1000);
    const graceEndDate = new Date(expiryDate);
    graceEndDate.setDate(graceEndDate.getDate() + GRACE_PERIOD_DAYS);

    await tx.payment.update({
      where: { reference },
      data: {
        status: 'SUCCESS',
        paidAt: new Date(data.paid_at || Date.now()),
        paystackData: data,
      },
    });

    await tx.subscription.update({
      where: { id: subscriptionId },
      data: {
        status: 'ACTIVE',
        expiryDate,
        graceEndDate,
        paystackAuthorizationCode:
          data.authorization?.authorization_code ?? subscription.paystackAuthorizationCode,
      },
    });

    logger.info('Subscription renewed via authorization', {
      subscriptionId,
      reference,
      expiryDate,
    });
  });

  const sub = await prisma.subscription.findUnique({ where: { id: subscriptionId } });
  if (sub) await sendRenewalConfirmation(sub.userId, sub.planId);
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

  const plan = SUBSCRIPTION_PLANS[subscription.planId as keyof typeof SUBSCRIPTION_PLANS];
  if (!plan) throw new Error(`Unknown plan: ${subscription.planId}`);

  const email =
    subscription.user.email ||
    `${subscription.user.phoneNumber}@whatsapp.placeholder.com`;
  const reference = `RNW_${subscription.planId.toUpperCase()}_${uuidv4().slice(0, 8)}`;

  await prisma.payment.create({
    data: {
      userId: subscription.userId,
      subscriptionId: subscription.id,
      reference,
      amount: plan.amount,
      planId: subscription.planId,
      status: 'PENDING',
    },
  });

  try {
    const response = await paystackClient.post('/transaction/initialize', {
      email,
      amount: plan.amount,
      reference,
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
      const plan = Object.values(SUBSCRIPTION_PLANS).find(
        p => p.paystackPlanCode === planCode
      );

      if (plan) {
        await prisma.subscription.updateMany({
          where: {
            userId: user.id,
            planId: plan.id,
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
  const reason: string =
    data.transaction?.gateway_response ?? data.transaction?.message ?? '';
  const isInsufficientFunds = /insufficient\s*funds?/i.test(reason);

  logger.info('Invoice payment failed', {
    subscriptionId: subscription.id,
    subscriptionCode,
    reason,
    nextAction: isInsufficientFunds ? 'GRACE' : 'EXPIRED',
  });

  if (isInsufficientFunds) {
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
