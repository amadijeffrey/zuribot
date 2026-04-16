import { env } from './env';

export const SUBSCRIPTION_PLANS = {
  wealth: {
    id: 'wealth',
    name: 'Wealth Plan',
    keywords: ['JOIN WEALTH', 'WEALTH'],
    amount: env.WEALTH_PLAN_AMOUNT,
    durationDays: 30,
    description: 'Access to Wealth building tips and exclusive group',
  },
  boost: {
    id: 'boost',
    name: 'Boost Plan',
    keywords: ['JOIN BOOST', 'BOOST'],
    amount: env.BOOST_PLAN_AMOUNT,
    durationDays: 30,
    description: 'Access to Boost strategies and premium group',
  },
  premium: {
    id: 'premium',
    name: 'Premium Plan',
    keywords: ['PREMIUM'],
    amount: env.PREMIUM_PLAN_AMOUNT,
    durationDays: 30,
    description: 'Full access to all features and VIP group',
  },
} as const;

export const UPGRADE_KEYWORDS = ['UPGRADE', 'PLANS', 'OPTIONS'];

export const SUBSCRIPTION_STATUS = {
  ACTIVE: 'ACTIVE',
  GRACE: 'GRACE',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;

export const PAYMENT_STATUS = {
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
} as const;

export const GRACE_PERIOD_DAYS = env.GRACE_PERIOD_DAYS;