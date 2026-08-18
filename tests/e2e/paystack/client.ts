// Shared helpers for the Paystack capture E2E.
//
// These drive the REAL running backend over HTTP (not the express app in-process),
// because the point of this suite is to exercise the same path a browser and
// Paystack take: real network, real middleware, real webhook delivery through the
// tunnel. Everything here is safe to run repeatedly — see TAG.
import { prisma } from '../../../src/config/database';

/** Every row this suite creates carries this marker so cleanup can be exhaustive. */
export const TAG = 'zcn-e2e';

export const API = process.env.E2E_API_URL || 'http://localhost:3000';

// Paystack rejects reserved TLDs like .test/.invalid ("Invalid Email Address
// Passed"), and the member must have a deliverable-looking address because
// subscribe sends it to Paystack. example.com is reserved by RFC 2606 for
// exactly this and cannot receive mail, so no real inbox is ever touched.
export const uniqueEmail = () =>
  `${TAG}.${Date.now()}.${Math.random().toString(36).slice(2, 7)}@example.com`;

// E.164-ish, matching the register schema's /^\+?[1-9]\d{6,14}$/. Randomised so
// concurrent runs never collide on the unique phone_number column.
export const uniquePhone = () =>
  `+234${Math.floor(7_000_000_000 + Math.random() * 999_999_999)}`.slice(0, 15);

export const PASSWORD = 'e2e-Passw0rd!';

type Json = Record<string, any>;

async function call(path: string, init: RequestInit = {}): Promise<{ status: number; body: Json }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init.headers ?? {}) },
  });
  const text = await res.text();
  let body: Json = {};
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text };
  }
  return { status: res.status, body };
}

export type Member = { email: string; phoneNumber: string; token: string; userId: string };

/** POST /api/users/register — real member account, tagged for cleanup. */
export async function register(): Promise<Member> {
  const email = uniqueEmail();
  const phoneNumber = uniquePhone();

  const { status, body } = await call('/api/users/register', {
    method: 'POST',
    body: JSON.stringify({
      name: 'ZCN E2E Member',
      email,
      password: PASSWORD,
      phoneNumber,
      occupation: 'Automated Test',
      country: 'Nigeria',
    }),
  });

  if (status !== 201) throw new Error(`register failed: ${status} ${JSON.stringify(body)}`);
  return { email, phoneNumber, token: body.token, userId: body.user.id };
}

/** POST /api/users/login — proves the credential path independently of register's token. */
export async function login(email: string, password = PASSWORD): Promise<string> {
  const { status, body } = await call('/api/users/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  });
  if (status !== 200) throw new Error(`login failed: ${status} ${JSON.stringify(body)}`);
  return body.token;
}

/** GET /api/users/plans — authenticated plan catalogue. */
export async function listPlans(token: string): Promise<any[]> {
  const { status, body } = await call('/api/users/plans', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (status !== 200) throw new Error(`plans failed: ${status} ${JSON.stringify(body)}`);
  return body.plans;
}

/** GET /api/users/me — profile plus current subscriptions. */
export async function me(token: string): Promise<Json> {
  const { status, body } = await call('/api/users/me', {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (status !== 200) throw new Error(`me failed: ${status} ${JSON.stringify(body)}`);
  return body;
}

/**
 * POST /api/users/subscribe — starts checkout. Returns Paystack's hosted
 * authorization URL and the reference the backend minted.
 *
 * That reference cannot be completed server-side: passing it to
 * /transaction/initialize (which subscribe does) makes Paystack reserve it, and
 * both /charge and /transaction/charge_authorization then reject it with
 * "Duplicate Transaction Reference". The hosted page is the only way to pay it,
 * which is why the card step needs a browser.
 */
export async function subscribe(
  token: string,
  planId: string,
  interval?: string,
): Promise<{ reference: string; authorizationUrl: string }> {
  const { status, body } = await call('/api/users/subscribe', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    body: JSON.stringify({ planId, ...(interval ? { interval } : {}) }),
  });
  if (status !== 201) throw new Error(`subscribe failed: ${status} ${JSON.stringify(body)}`);
  return { reference: body.reference, authorizationUrl: body.authorizationUrl };
}

// --- waiting on asynchronous webhook delivery ---

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Polls until `predicate` returns a truthy value or the budget runs out.
 * Webhook delivery is asynchronous, so every assertion that depends on Paystack
 * calling back has to wait rather than read once.
 */
export async function waitFor<T>(
  label: string,
  predicate: () => Promise<T | null | undefined | false>,
  { timeoutMs = 90_000, intervalMs = 2_000 } = {},
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: any;
  while (Date.now() < deadline) {
    last = await predicate();
    if (last) return last as T;
    await sleep(intervalMs);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for: ${label}`);
}

/** Webhook events this run received, newest first. */
export async function webhookEvents(since: Date) {
  return prisma.webhookLog.findMany({
    where: { createdAt: { gte: since } },
    orderBy: { createdAt: 'asc' },
  });
}

/** Removes every row this suite created. Plans/benefits are seed data and stay. */
export async function cleanup(): Promise<{ payments: number; subscriptions: number; users: number }> {
  const users = await prisma.user.findMany({
    where: { email: { contains: TAG } },
    select: { id: true },
  });
  const ids = users.map((u) => u.id);
  if (ids.length === 0) return { payments: 0, subscriptions: 0, users: 0 };

  const payments = await prisma.payment.deleteMany({ where: { userId: { in: ids } } });
  const subscriptions = await prisma.subscription.deleteMany({ where: { userId: { in: ids } } });
  const deleted = await prisma.user.deleteMany({ where: { id: { in: ids } } });

  return { payments: payments.count, subscriptions: subscriptions.count, users: deleted.count };
}
