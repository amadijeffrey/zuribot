import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).default('3000'),
  
  DATABASE_URL: z.string(),

  WHATSAPP_API_VERSION: z.string().default('v18.0'),
  WHATSAPP_PHONE_NUMBER_ID: z.string(),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string(),
  WHATSAPP_ACCESS_TOKEN: z.string(),
  WHATSAPP_VERIFY_TOKEN: z.string(),
  WHATSAPP_APP_SECRET: z.string(),
  
  PAYSTACK_SECRET_KEY: z.string(),
  PAYSTACK_PUBLIC_KEY: z.string(),
  PAYSTACK_WEALTH_PLAN_CODE: z.string().min(1),
  PAYSTACK_HEALTH_PLAN_CODE: z.string().min(1),
  PAYSTACK_BOOST_PLAN_CODE: z.string().min(1),

  ADMIN_API_KEY: z.string(),

  WEALTH_PLAN_AMOUNT: z.string().transform(Number).default('500000'),
  HEALTH_PLAN_AMOUNT: z.string().transform(Number).default('500000'),
  BOOST_PLAN_AMOUNT: z.string().transform(Number).default('1000000'),
  PREMIUM_PLAN_AMOUNT: z.string().transform(Number).default('2500000'),
  GRACE_PERIOD_DAYS: z.string().transform(Number).default('3'),
  
  ENABLE_WEBHOOK_LOGGING: z.string().transform(v => v === 'true').default('true'),
  ENABLE_MESSAGE_LOGGING: z.string().transform(v => v === 'true').default('true'),
});

export const env = envSchema.parse(process.env);