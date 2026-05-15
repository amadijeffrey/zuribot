import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { SUBSCRIPTION_PLANS, GRACE_PERIOD_DAYS } from '../config/constants';
import { sendActivationConfirmation, moveToGracePeriod } from './subscription';
import { logger } from '../utils/logger';
import { InitializePaymentParams, InitializePaymentResult } from '../types';

const paystackClient = axios.create({
  baseURL: 'https://api.paystack.co',
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

    const response = await paystackClient.post('/transaction/initialize', {
      email,
      amount: plan.amount,
      reference,
      plan: plan.paystackPlanCode,
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

    default:
      logger.info('Unhandled Paystack event', { event: event.event });
  }
};

// --- charge.success ---

const handleChargeSuccess = async (data: any): Promise<void> => {
  const isRecurring = !!data.subscription?.subscription_code;

  if (isRecurring) {
    await handleRecurringCharge(data);
    return;
  }

  const payment = await prisma.payment.findUnique({ where: { reference: data.reference } });

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

const handleInitialPayment = async (reference: string, data: any): Promise<void> => {
  const payment = await prisma.payment.findUnique({
    where: { reference },
    include: { user: true },
  });

  if (!payment) {
    logger.error('Payment not found', { reference });
    return;
  }

  await prisma.$transaction(async (tx) => {
    await tx.payment.update({
      where: { reference },
      data: {
        status: 'SUCCESS',
        paidAt: new Date(data.paid_at || Date.now()),
        paystackData: data,
      },
    });

    const plan = SUBSCRIPTION_PLANS[payment.planId as keyof typeof SUBSCRIPTION_PLANS];
    if (!plan) throw new Error(`Plan not found: ${payment.planId}`);

    const startDate = new Date();
    const expiryDate = new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000);

    const graceEndDate = new Date(expiryDate);
    graceEndDate.setDate(graceEndDate.getDate() + GRACE_PERIOD_DAYS);

    const group = await tx.group.findUnique({ where: { planId: payment.planId } });

    const subscription = await tx.subscription.create({
      data: {
        userId: payment.userId,
        planId: payment.planId,
        status: 'ACTIVE',
        startDate,
        expiryDate,
        graceEndDate,
        groupInviteId: group?.id,
        paystackSubscriptionCode: data.subscription?.subscription_code ?? null,
        paystackEmailToken: data.subscription?.email_token ?? null,
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
    });
  });

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

  const plan = SUBSCRIPTION_PLANS[subscription.planId as keyof typeof SUBSCRIPTION_PLANS];
  if (!plan) return;

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

  await prisma.subscription.updateMany({
    where: { paystackSubscriptionCode: subscription_code },
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

  await moveToGracePeriod(subscription.id);

  logger.info('Subscription moved to grace after failed invoice', { subscriptionCode });
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
