/**
 * Paystack webhook payload builders.
 *
 * PROVENANCE MATTERS HERE. A hand-invented fixture makes the suite assert that
 * the code agrees with my guess, which is worthless — the bug it would miss is
 * exactly "we read a field Paystack doesn't send under that name". So every
 * builder below is annotated with where its shape came from:
 *
 *   [CAPTURED]  Copied from a real Paystack delivery stored in webhook_logs
 *               during the scenario 1/2 runs on 2026-08-16. Field names,
 *               nesting and value formats are Paystack's own.
 *   [DERIVED]   Same envelope as a CAPTURED event, with the outcome fields
 *               changed. Used for invoice.update, whose success variant test
 *               mode never settles — invoice.create and invoice.payment_failed
 *               arrived byte-identical in structure, so the envelope is known
 *               even though a successful one was never observed.
 *   [DOCUMENTED] From Paystack's published payload samples. Never observed here,
 *               because nothing can trigger it in test mode. Treat assertions
 *               built on these as weaker than the rest.
 */

/**
 * Unique per built event — as Paystack's own identifiers are.
 *
 * This is load-bearing, not cosmetic. eventKey() fingerprints an event as
 * `${event}|${id ?? reference ?? invoice_code ?? subscription_code}|${status}|${paid_at ?? updatedAt}`.
 * A fixture with a hardcoded id and no paid_at therefore produces the SAME
 * fingerprint on every run, so the replay guard drops it as a duplicate of the
 * previous run's delivery — the test passes once and then silently stops
 * exercising anything. Every builder below must vary at least one field that
 * feeds that fingerprint.
 */
let eventSeq = 0;
const uniqueId = () => Date.now() * 1000 + (eventSeq++ % 1000);

// Real values observed in the captures, reused so fixtures look like Paystack's.
const TEST_AUTHORIZATION = {
  bin: '408408',
  bank: 'TEST BANK',
  brand: 'visa',
  last4: '4081',
  channel: 'card',
  exp_year: '2030',
  reusable: true,
  card_type: 'visa ',
  exp_month: '12',
  signature: 'SIG_Jea43eZVko75L9jcErDQ',
  account_name: null,
  country_code: 'NG',
  authorization_code: 'AUTH_replay000',
};

const customer = (email: string, customerCode: string) => ({
  id: 391444512,
  email,
  phone: null,
  metadata: null,
  last_name: null,
  first_name: null,
  risk_action: 'default',
  customer_code: customerCode,
  international_format_phone: null,
});

export type ChargeOpts = {
  reference: string;
  amount: number;
  email?: string;
  currency?: string;
  customerCode?: string;
  authorizationCode?: string;
  planCode?: string;
  subscriptionCode?: string;
};

/**
 * [CAPTURED] charge.success — from SUB_TESTHEALTH_400a38ed, the scenario 1
 * activation. `plan` and `subaccount` really do arrive as empty objects on a
 * one-off charge, and `metadata` carries the userId/planId the backend set.
 */
export const chargeSuccess = (o: ChargeOpts) => ({
  event: 'charge.success',
  data: {
    id: uniqueId(),
    log: null,
    fees: 14500,
    plan: o.planCode ? { plan_code: o.planCode } : {},
    split: {},
    amount: o.amount,
    domain: 'test',
    paidAt: new Date().toISOString(),
    source: { type: 'api', source: 'merchant_api', identifier: null, entry_point: 'transaction_initialize' },
    status: 'success',
    channel: 'card',
    message: null,
    paid_at: new Date().toISOString(),
    currency: o.currency ?? 'NGN',
    customer: customer(o.email ?? 'replay@example.com', o.customerCode ?? 'CUS_replay0000'),
    metadata: 0,
    order_id: null,
    reference: o.reference,
    created_at: new Date().toISOString(),
    ip_address: '102.89.69.178',
    subaccount: {},
    authorization: {
      ...TEST_AUTHORIZATION,
      authorization_code: o.authorizationCode ?? TEST_AUTHORIZATION.authorization_code,
    },
    response_code: '00',
    gateway_response: 'Successful',
    requested_amount: o.amount,
    gateway_response_code: 'approved',
    ...(o.subscriptionCode ? { subscription: { subscription_code: o.subscriptionCode } } : {}),
  },
});

/** [DERIVED] charge.failed — the failure variant of the captured charge envelope. */
export const chargeFailed = (o: { reference: string; amount: number }) => ({
  event: 'charge.failed',
  data: {
    id: uniqueId(),
    amount: o.amount,
    domain: 'test',
    status: 'failed',
    paid_at: null,
    currency: 'NGN',
    customer: customer('replay@example.com', 'CUS_replay0000'),
    reference: o.reference,
    created_at: new Date().toISOString(),
    authorization: TEST_AUTHORIZATION,
    gateway_response: 'Declined',
    gateway_response_code: 'declined',
  },
});

type InvoiceOpts = {
  subscriptionCode: string;
  amount: number;
  transactionReference: string;
  email?: string;
  customerCode?: string;
  authorizationCode?: string;
  currency?: string;
  emailToken?: string;
};

/**
 * [DERIVED] invoice.update (successful) — THE production renewal signal.
 *
 * Structure is exactly the captured invoice.create / invoice.payment_failed
 * envelope; only the outcome fields differ (paid 1, status success, paid_at set,
 * transaction.status success). Those two captured events were structurally
 * identical to each other, which is what makes this derivation safe rather than
 * invented. It has still never been observed from Paystack — test mode's cron
 * never settles a recurring charge — so it stays [DERIVED], not [CAPTURED].
 */
export const invoiceUpdateSuccess = (o: InvoiceOpts) => ({
  event: 'invoice.update',
  data: {
    paid: 1,
    amount: o.amount,
    domain: 'test',
    status: 'success',
    paid_at: new Date().toISOString(),
    customer: customer(o.email ?? 'replay@example.com', o.customerCode ?? 'CUS_replay0000'),
    createdAt: new Date().toISOString(),
    period_end: new Date(Date.now() + 3_600_000).toISOString(),
    description: null,
    transaction: {
      amount: o.amount,
      status: 'success',
      currency: o.currency ?? 'NGN',
      reference: o.transactionReference,
    },
    invoice_code: `INV_replay${uniqueId()}`,
    period_start: new Date().toISOString(),
    subscription: {
      amount: o.amount,
      status: 'active',
      email_token: o.emailToken ?? 'idxomxpb1ickxhf',
      open_invoice: null,
      cron_expression: '5 * * * *',
      next_payment_date: new Date(Date.now() + 3_600_000).toISOString(),
      subscription_code: o.subscriptionCode,
    },
    authorization: {
      ...TEST_AUTHORIZATION,
      authorization_code: o.authorizationCode ?? TEST_AUTHORIZATION.authorization_code,
    },
  },
});

/** [DERIVED] invoice.update that did NOT succeed — must be ignored, not applied. */
export const invoiceUpdateFailed = (o: InvoiceOpts) => {
  const evt = invoiceUpdateSuccess(o);
  evt.data.paid = 0;
  evt.data.status = 'failed';
  (evt.data as any).paid_at = null;
  evt.data.transaction.status = 'failed';
  return evt;
};

/** [CAPTURED] invoice.create — verbatim shape from the real 16:15 delivery. */
export const invoiceCreate = (o: InvoiceOpts) => {
  const evt = invoiceUpdateSuccess(o);
  return { ...evt, event: 'invoice.create' };
};

/**
 * [CAPTURED] invoice.payment_failed — verbatim shape from the real 16:15
 * delivery, including `description: null`, which is what drove the handler down
 * its "reason unresolved -> GRACE" branch.
 */
export const invoicePaymentFailed = (o: InvoiceOpts) => {
  const evt = invoiceUpdateFailed(o);
  return { ...evt, event: 'invoice.payment_failed' };
};

/** [CAPTURED] subscription.create — from the real activation at 15:05. */
export const subscriptionCreate = (o: {
  subscriptionCode: string;
  emailToken: string;
  planCode: string;
  email: string;
  customerCode: string;
}) => ({
  event: 'subscription.create',
  data: {
    // Unique per build, NOT the captured 1271327. eventKey() fingerprints an
    // event as `${event}|${id}|${status}|${paid_at ?? updatedAt}` — and with no
    // paid_at on this event, reusing the captured id produced a fingerprint
    // identical to the real delivery already in webhook_logs, so the replay
    // guard silently dropped every fixture built from it.
    id: uniqueId(),
    plan: {
      id: 3702646,
      name: 'ZCN test',
      amount: 300000,
      currency: 'NGN',
      interval: 'hourly',
      plan_code: o.planCode,
      send_invoices: 1,
    },
    amount: 300000,
    domain: 'test',
    status: 'active',
    customer: customer(o.email, o.customerCode),
    createdAt: new Date().toISOString(),
    email_token: o.emailToken,
    integration: 1776726,
    open_invoice: null,
    authorization: TEST_AUTHORIZATION,
    subscription_code: o.subscriptionCode,
    next_payment_date: new Date(Date.now() + 3_600_000).toISOString(),
  },
});

/** [DOCUMENTED] subscription.disable. */
export const subscriptionDisable = (o: { subscriptionCode: string; emailToken?: string }) => ({
  event: 'subscription.disable',
  data: {
    domain: 'test',
    status: 'complete',
    subscription_code: o.subscriptionCode,
    email_token: o.emailToken ?? 'idxomxpb1ickxhf',
    amount: 300000,
    customer: customer('replay@example.com', 'CUS_replay0000'),
    created_at: new Date().toISOString(),
  },
});

/** [DOCUMENTED] subscription.not_renew — auto-renew off, current period stands. */
export const subscriptionNotRenew = (o: { subscriptionCode: string }) => ({
  event: 'subscription.not_renew',
  data: {
    domain: 'test',
    status: 'non-renewing',
    subscription_code: o.subscriptionCode,
    amount: 300000,
    customer: customer('replay@example.com', 'CUS_replay0000'),
    created_at: new Date().toISOString(),
  },
});

/** [DOCUMENTED] refund.processed. */
export const refundProcessed = (o: { transactionReference: string; amount: number }) => ({
  event: 'refund.processed',
  data: {
    id: uniqueId(),
    status: 'processed',
    domain: 'test',
    amount: o.amount,
    currency: 'NGN',
    transaction_reference: o.transactionReference,
    refund_reference: `RF_${Date.now()}`,
    customer: customer('replay@example.com', 'CUS_replay0000'),
  },
});

/** [DOCUMENTED] charge.dispute.create — nothing in test mode can produce one. */
export const disputeCreate = (o: { transactionReference: string; amount: number }) => ({
  event: 'charge.dispute.create',
  data: {
    id: uniqueId(),
    status: 'awaiting-merchant-feedback',
    domain: 'test',
    refund_amount: o.amount,
    currency: 'NGN',
    transaction: { reference: o.transactionReference, amount: o.amount },
    customer: customer('replay@example.com', 'CUS_replay0000'),
  },
});

/**
 * [DOCUMENTED] charge.dispute.resolve. `resolution` is what decides whether
 * access is revoked — handleDisputeResolved matches /merchant-accepted|lost/i.
 */
export const disputeResolve = (o: {
  transactionReference: string;
  amount: number;
  resolution: string;
}) => ({
  event: 'charge.dispute.resolve',
  data: {
    id: uniqueId(),
    status: 'resolved',
    domain: 'test',
    resolution: o.resolution,
    refund_amount: o.amount,
    currency: 'NGN',
    transaction: { reference: o.transactionReference, amount: o.amount },
    customer: customer('replay@example.com', 'CUS_replay0000'),
  },
});
