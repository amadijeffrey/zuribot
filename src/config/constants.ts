import { env } from './env';

export const SUBSCRIPTION_PLANS = {
  wealth: {
    id: 'wealth',
    name: 'Wealth Plan',
    keywords: ['JOIN WEALTH', 'WEALTH'],
    amount: env.WEALTH_PLAN_AMOUNT,
    paystackPlanCode: env.PAYSTACK_WEALTH_PLAN_CODE,
    durationDays: 30,
    inviteLink: 'https://chat.whatsapp.com/IpXuZdgcQnT2R3qhQavmYz?s=sh&p=a&ilr=1',
    description: 'Access to Wealth building tips and exclusive group',
  },
  health: {
    id: 'health',
    name: 'Health Plan',
    keywords: ['JOIN HEALTH', 'HEALTH'],
    amount: env.HEALTH_PLAN_AMOUNT,
    paystackPlanCode: env.PAYSTACK_HEALTH_PLAN_CODE,
    durationDays: 30,
    inviteLink: 'https://chat.whatsapp.com/JcCTGFHk5qD0SBBg5vPu2D?s=sh&p=a&ilr=1',
    description: 'Access to Health tips and exclusive group',
  },
  //  test: {
  //   id: 'test',
  //   name: 'ZCN Test Plan',
  //   keywords: ['JOIN TEST', 'TEST'],
  //   amount: 200000,
  //   paystackPlanCode: 'PLN_xt19zozmdq0w0ja',
  //   durationDays: 1 / 24,
  //   inviteLink: 'https://chat.whatsapp.com/CSSdJsiVmCLIZjW87ySMBX?mode=hqctcli',
  //   description: 'Access to Test tips and exclusive group',
  // },
  // boost: {
  //   id: 'boost',
  //   name: 'Boost Plan',
  //   keywords: ['JOIN BOOST', 'BOOST'],
  //   amount: env.BOOST_PLAN_AMOUNT,
  //   paystackPlanCode: env.PAYSTACK_BOOST_PLAN_CODE,
  //   durationDays: 30,
  //   description: 'Access to Boost strategies and premium group',
  // },
  // premium: {
  //   id: 'premium',
  //   name: 'Premium Plan',
  //   keywords: ['PREMIUM'],
  //   amount: env.PREMIUM_PLAN_AMOUNT,
  //   paystackPlanCode: env.PAYSTACK_PREMIUM_PLAN_CODE,
  //   durationDays: 30,
  //   description: 'Full access to all features and VIP group',
  // },
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