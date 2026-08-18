import type { BillingInterval } from '@prisma/client';
export * from './whatsapp.types';

export interface InitializePaymentParams {
  userId: string;
  planId: string;
  email: string;
  // Origination channel. Defaults to WHATSAPP; WEB adds a Paystack redirect
  // (callback_url) and routes post-payment delivery through email, not WhatsApp.
  channel?: 'WHATSAPP' | 'WEB';
  // Which billing interval to charge for a tiered plan, e.g. 'SEMIANNUAL'.
  // Omit only for single-interval plans; the caller resolves it to a PlanPrice.
  // Typed from the Prisma enum so the two cannot drift apart.
  interval?: BillingInterval;
  // Baked into callback_url (never sent as Paystack metadata — it's a
  // frontend routing hint, not something either handleInitialPayment or the
  // webhook needs). 'registration' marks a checkout for a member who hasn't
  // finished /membership-activation yet — either the original checkout from
  // POST /users/register, or a retry from /membership-activation/plans —
  // so /payment/success can send a failed "Try again" back to the
  // pre-activation plan picker instead of the dashboard one, and send a
  // successful "You're in" on to /membership-activation instead of /dashboard.
  // Defaults to 'dashboard': every other caller (an already-activated member
  // subscribing, changing, or renewing) is unaffected without having to say so.
  origin?: 'registration' | 'dashboard';
}

export interface InitializePaymentResult {
  reference: string;
  authorizationUrl: string;
  accessCode: string;
}

export interface PaystackWebhookEvent {
  event: string;
  data: {
    reference: string;
    amount: number;
    currency: string;
    status: string;
    paid_at: string;
    channel: string;
    customer: {
      email: string;
      phone: string;
    };
    metadata: {
      userId: string;
      planId: string;
    };
  };
}

export interface CreateUserParams {
  phoneNumber: string;
  name?: string;
  email?: string;
}

export interface SubscriptionStats {
  active: number;
  grace: number;
  expired: number;
  total: number;
}

export interface PaginationParams {
  page?: number;
  limit?: number;
}

export interface PaginationResult {
  page: number;
  limit: number;
  total: number;
  pages: number;
}