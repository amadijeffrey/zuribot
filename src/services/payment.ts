import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { SUBSCRIPTION_PLANS, GRACE_PERIOD_DAYS } from '../config/constants';
import { sendActivationConfirmation } from './subscription';
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
  const { userId, planId, amount, email } = params;

  const reference = `SUB_${planId.toUpperCase()}_${uuidv4().slice(0, 8)}`;

  try {
    await prisma.payment.create({
      data: {
        userId,
        reference,
        amount,
        planId,
        status: 'PENDING',
      },
    });

    const response = await paystackClient.post('/transaction/initialize', {
      email,
      amount,
      reference,
      callback_url: `${env.API_BASE_URL}/payment/callback`,
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

    logger.info('Payment initialized', { reference, userId, planId, amount });

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
      await handleSuccessfulPayment(reference, data);
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
  const { reference, status } = event.data;

  logger.info('Processing Paystack webhook', {
    event: event.event,
    reference,
    status,
  });

  const existingPayment = await prisma.payment.findUnique({
    where: { reference },
  });

  if (!existingPayment) {
    logger.warn('Payment not found for webhook', { reference });
    return;
  }

  if (existingPayment.status === 'SUCCESS') {
    logger.info('Payment already processed, skipping', { reference });
    return;
  }

  switch (event.event) {
    case 'charge.success':
      await handleSuccessfulPayment(reference, event.data);
      break;

    case 'charge.failed':
      await handleFailedPayment(reference);
      break;

    default:
      logger.info('Unhandled Paystack event', { event: event.event });
  }
};

const handleSuccessfulPayment = async (reference: string, data: any): Promise<void> => {
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
    if (!plan) {
      throw new Error(`Plan not found: ${payment.planId}`);
    }

    const startDate = new Date();
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + plan.durationDays);

    const graceEndDate = new Date(expiryDate);
    graceEndDate.setDate(graceEndDate.getDate() + GRACE_PERIOD_DAYS);

    const group = await tx.group.findUnique({
      where: { planId: payment.planId },
    });

    const subscription = await tx.subscription.create({
      data: {
        userId: payment.userId,
        planId: payment.planId,
        status: 'ACTIVE',
        startDate,
        expiryDate,
        graceEndDate,
        groupInviteId: group?.id,
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

const handleFailedPayment = async (reference: string): Promise<void> => {
  await prisma.payment.update({
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