import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

// An env var written as `KEY=` arrives as an empty string, and zod's .default()
// only applies to a MISSING key — so the empty value would pass straight through
// to consumers. Treating '' as absent makes `KEY=` behave like `KEY` unset.
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema);

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

  ADMIN_API_KEY: z.string(),
  JWT_SECRET: optional(z.string().min(32).optional()),
  JWT_EXPIRES_IN: optional(z.string().min(1).default('2h')),
  CRON_SECRET: optional(z.string().optional()),


  GRACE_PERIOD_DAYS: z.string().transform(Number).default('3'),
  
  // WhatsApp outbound messaging. Off by default: the product now delivers over
  // email, and the bot's send functions are kept only so the flow can be revived
  // by flipping this back on. Inbound bot webhooks are unaffected.
  ENABLE_WHATSAPP_NOTIFICATIONS: z.string().transform(v => v === 'true').default('false'),

  ENABLE_WEBHOOK_LOGGING: z.string().transform(v => v === 'true').default('true'),
  ENABLE_MESSAGE_LOGGING: z.string().transform(v => v === 'true').default('true'),
  // Comma-separated browser origins allowed to call the API. Validated here so a
  // missing value is visible in config rather than silently blocking every
  // browser request at runtime.
  ALLOWED_ORIGINS: z.string().default(''),

  FRONTEND_URL: optional(z.string().url().optional()),
  RESEND_API_KEY: optional(z.string().optional()),
  EMAIL_FROM: optional(z.string().optional()),
});

export const env = envSchema.parse(process.env);