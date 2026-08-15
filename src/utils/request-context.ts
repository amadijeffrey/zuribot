import { AsyncLocalStorage } from 'async_hooks';

// Request-scoped state, carried implicitly through the async call stack.
//
// The point is correlation: a single Paystack webhook fans out through
// payment.ts, subscription.ts, plan.ts and email.ts, each logging on its own.
// Without a shared id those lines are unattributable once two requests overlap —
// which is precisely when you need to read them. AsyncLocalStorage propagates
// the id into every await'd continuation, so existing logger calls gain it with
// no change to their call sites.
export interface RequestContext {
  requestId: string;
  method: string;
  path: string;
  /** Who the caller is, once an auth middleware has established it. */
  actor?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

export const runWithRequestContext = <T>(context: RequestContext, fn: () => T): T =>
  storage.run(context, fn);

export const getRequestContext = (): RequestContext | undefined => storage.getStore();

// The store object lives for the length of the request, so mutating it is
// visible to every line logged afterwards. Used by the auth middlewares, which
// only learn who the caller is after the logger has already started.
export const setRequestActor = (actor: string): void => {
  const context = storage.getStore();
  if (context) context.actor = actor;
};
