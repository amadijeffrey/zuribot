import { z } from 'zod';
import dotenv from 'dotenv';

// APP_ENV names the *deployment* — which box, which data, which audience.
// NODE_ENV stays a separate axis and keeps its conventional three values,
// because Express and much of npm read it to decide whether to enable
// production optimisations. A staging box therefore runs NODE_ENV=production
// and APP_ENV=staging; conflating the two would put staging into development
// mode and, in this codebase, would have mounted the state-mutating test routes
// on a deployed environment.
// Falling back to 'local' when APP_ENV is unset is right on a laptop and
// dangerous on a deployment: local semantics mount the state-mutating test
// routes and skip every deployed-environment requirement. Vercel stamps
// VERCEL_ENV on each deployment, so use it to recognise a deployment that was
// pushed without APP_ENV configured — a forgotten dashboard variable then fails
// safe instead of publishing test tooling.
//
// Preview deployments map to staging: they are real, publicly reachable URLs.
const fromVercel = (): string | undefined => {
  switch (process.env.VERCEL_ENV) {
    case 'production':
      return 'production';
    case 'preview':
      return 'staging';
    case 'development':
      return 'local'; // `vercel dev`, i.e. someone's machine
    default:
      return undefined;
  }
};

const appEnv = process.env.APP_ENV || fromVercel() || 'local';
// Written back so the schema below sees the resolved value.
process.env.APP_ENV = appEnv;

// Most specific file first. dotenv never overwrites a variable that is already
// set, so the precedence is: real environment (Vercel dashboard, docker
// env_file) > .env.<APP_ENV> > .env. A missing file is a no-op, so deployments
// that inject everything through the platform are unaffected.
dotenv.config({ path: `.env.${appEnv}` });
dotenv.config();

// An env var written as `KEY=` arrives as an empty string, and zod's .default()
// only applies to a MISSING key — so the empty value would pass straight through
// to consumers. Treating '' as absent makes `KEY=` behave like `KEY` unset.
const optional = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), schema);

const envSchema = z.object({
  // Which deployment this process is. Drives anything that must differ between
  // a laptop and a real environment; see the refinements below.
  APP_ENV: z.enum(['local', 'staging', 'production']).default('local'),

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
  JWT_SECRET: z.string().min(32),
  JWT_EXPIRES_IN: z.string().min(1),
  CRON_SECRET: z.string().optional(),


  GRACE_PERIOD_DAYS: z.string().transform(Number).default('3'),
  
  // WhatsApp outbound messaging. Off by default: the product now delivers over
  // email, and the bot's send functions are kept only so the flow can be revived
  // by flipping this back on. Inbound bot webhooks are unaffected.
  ENABLE_WHATSAPP_NOTIFICATIONS: z.string().transform(v => v === 'true').default('false'),

  // Local development escape hatch: turns off every rate limiter. Needed because
  // the docker dev stack runs with NODE_ENV=production and traffic reaches the
  // container from the Docker gateway, so neither NODE_ENV nor the client IP can
  // identify it as local. Never set this on a deployed environment.
  DISABLE_RATE_LIMIT: z.string().transform(v => v === 'true').default('false'),

  ENABLE_WEBHOOK_LOGGING: z.string().transform(v => v === 'true').default('true'),
  ENABLE_MESSAGE_LOGGING: z.string().transform(v => v === 'true').default('true'),
  // Comma-separated browser origins allowed to call the API. Validated here so a
  // missing value is visible in config rather than silently blocking every
  // browser request at runtime.
  ALLOWED_ORIGINS: z.string().default(''),

  // Optional directory for on-disk logs. Unset by default: stdout is captured on
  // every target we deploy to (Vercel natively; Docker's json-file driver on the
  // VM, which also rotates it). Set this only on a host where stdout is not
  // collected — the files it enables are size-bounded, see utils/logger.ts.
  LOG_FILE_DIR: optional(z.string().optional()),

  FRONTEND_URL: optional(z.string().url().optional()),
  RESEND_API_KEY: optional(z.string().optional()),
  EMAIL_FROM: optional(z.string().optional()),
})
  // Requirements that only apply once this is a real deployment. Checked here so
  // a misconfigured box fails at boot with a named variable, rather than at the
  // first customer who needs the thing that was missing.
  //
  // Staging is held to the same bar as production deliberately: it runs live
  // Paystack keys, so it is production in every way that can affect a customer.
  .superRefine((cfg, ctx) => {
    if (cfg.APP_ENV === 'local') return;

    const require = (key: keyof typeof cfg, why: string) => {
      if (!cfg[key]) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: `Required on ${cfg.APP_ENV} — ${why}` });
      }
    };

    // Email is the only delivery channel while ENABLE_WHATSAPP_NOTIFICATIONS is
    // off. Without these, a paying customer is charged and receives nothing.
    require('RESEND_API_KEY', 'no email would be sent to paying customers');
    require('EMAIL_FROM', 'emails would come from the Resend test sender');

    // Empty means every browser origin is rejected, so the frontend cannot call
    // this API at all.
    require('ALLOWED_ORIGINS', 'all browser origins would be blocked');

    // The expiry/reconciliation sweep 503s without it, so subscriptions would
    // never transition out of ACTIVE and dropped webhooks would never be caught.
    require('CRON_SECRET', 'the scheduled sweep would refuse every request');

    // Checkout redirects back here after payment.
    require('FRONTEND_URL', 'payment callbacks would have nowhere to return to');

    if (cfg.DISABLE_RATE_LIMIT) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['DISABLE_RATE_LIMIT'],
        message: `Must not be set on ${cfg.APP_ENV} — it disables every rate limiter, including admin and member login`,
      });
    }
  });

export const env = envSchema.parse(process.env);

// Read these instead of comparing APP_ENV inline, so the set of environments can
// grow without hunting down string comparisons.
export const isLocal = env.APP_ENV === 'local';
export const isStaging = env.APP_ENV === 'staging';
export const isProduction = env.APP_ENV === 'production';
/** True on any real deployment — use for "this is not a laptop" decisions. */
export const isDeployed = !isLocal;