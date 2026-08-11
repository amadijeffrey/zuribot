// Data minimisation for stored gateway payloads and logs.
//
// Paystack's transaction payload carries far more than we ever read: card BIN,
// expiry, cardholder name, issuing bank, the payer's IP and a full checkout
// trail. Keeping it is an avoidable liability, so only the fields we actually
// use are persisted.

// Keeps what is useful for reconciliation, renewals and customer support, and
// drops the rest. `last4`/`brand` are retained so support can say "the card
// ending 4354" — bin, expiry, cardholder name and bank are not needed for that.
// Returns a Prisma-compatible JSON object (Prisma's InputJsonValue rejects a
// loose index signature, hence the concrete return type).
export const redactPaystackData = (data: any): Record<string, any> | null => {
  if (!data || typeof data !== 'object') return null;

  const auth = data.authorization ?? {};
  const customer = data.customer ?? {};

  return {
    reference: data.reference,
    amount: data.amount,
    currency: data.currency,
    status: data.status,
    channel: data.channel,
    paid_at: data.paid_at ?? data.paidAt,
    gateway_response: data.gateway_response,
    authorization: {
      authorization_code: auth.authorization_code,
      last4: auth.last4,
      brand: auth.brand,
      card_type: auth.card_type,
      reusable: auth.reusable,
    },
    customer: {
      customer_code: customer.customer_code,
      email: customer.email,
    },
    plan: data.plan?.plan_code ?? (typeof data.plan === 'string' ? data.plan : undefined),
    subscription_code: data.subscription?.subscription_code,
    // Marks rows written by the redacting path, so a backfill can tell them apart.
    _redacted: true,
  };
};

// --- log redaction ---

const maskEmail = (v: string): string => {
  const [local, domain] = v.split('@');
  if (!domain) return maskGeneric(v);
  return `${local.slice(0, 3)}***@${domain}`;
};

const maskGeneric = (v: string): string =>
  v.length <= 4 ? '***' : `${v.slice(0, 4)}${'*'.repeat(Math.max(3, v.length - 8))}${v.slice(-4)}`;

// Keys whose values identify a person. Matched loosely so new call sites are
// covered without having to remember to redact at each one.
const PII_KEY = /(email|phone|account_name|^to$|customeremail)/i;

export const maskValue = (value: unknown): unknown => {
  if (typeof value !== 'string' || value.length === 0) return value;
  return value.includes('@') ? maskEmail(value) : maskGeneric(value);
};

// Redacts a winston `info` object IN PLACE. Winston attaches internal symbols to
// that object, so rebuilding it (e.g. by destructuring) loses them and the
// transports render nothing — the metadata must be mutated, not replaced.
const RESERVED = new Set(['level', 'message', 'timestamp', 'stack', 'service']);

export const redactInfoInPlace = <T extends Record<string, any>>(info: T): T => {
  for (const [key, value] of Object.entries(info)) {
    if (RESERVED.has(key)) continue;
    info[key as keyof T] = (
      PII_KEY.test(key) ? maskValue(value) : redactLogMeta(value)
    ) as T[keyof T];
  }
  return info;
};

// Walks log metadata and masks anything that looks like a personal identifier.
export const redactLogMeta = (input: unknown, depth = 0): unknown => {
  if (depth > 6 || input === null || typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map((v) => redactLogMeta(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (PII_KEY.test(key)) out[key] = maskValue(value);
    else if (value && typeof value === 'object') out[key] = redactLogMeta(value, depth + 1);
    else out[key] = value;
  }
  return out;
};
