// Decides whether one plan's worth of a person's abandoned checkouts is worth a
// reminder. Pure — no I/O — so the rule can be tested without a database or
// Paystack.
//
// Why this is per plan and not per person: one person can end up with several
// PENDING payments for the same plan (initializePayment only reuses a checkout for
// 30 minutes, then creates a new row and leaves the old one PENDING), and can pay
// on the last one. The stale rows stay PENDING, so "status = PENDING" alone would
// nag someone who has already subscribed. Checking the payment's own plan against
// what the person currently holds catches that, while still reminding someone who
// holds Health but left a Premium checkout unfinished.

export type PaystackLookup =
  | { kind: 'status'; status: string }
  | { kind: 'error'; detail: string };

export type GroupVerdict =
  | { remind: true }
  | { remind: false; reason: string; paidReferences: string[] };

// Only these mean "started and left". Anything else — including states that may
// mean the person is mid-checkout — is left alone rather than guessed at.
const REMINDABLE_PAYSTACK_STATUSES = new Set(['abandoned', 'failed']);

/**
 * @param heldPlanIds plans the person CURRENTLY holds (ACTIVE or GRACE). Expired
 *   and cancelled subscriptions deliberately do not count: someone who lapsed and
 *   is coming back is exactly who a reminder is for.
 * @param planId the plan these checkouts were for
 * @param lookups Paystack's answer for each checkout in the group. May be empty
 *   when the plan is already held, since the answer would not change the outcome.
 */
export const classifyCheckoutGroup = (
  heldPlanIds: ReadonlySet<string>,
  planId: string,
  lookups: { reference: string; result: PaystackLookup }[],
): GroupVerdict => {
  if (heldPlanIds.has(planId)) {
    return { remind: false, reason: 'already subscribed', paidReferences: [] };
  }

  // Checked across the whole group first: a checkout that succeeded on Paystack
  // is the most important thing to surface, even if another row is unverifiable.
  const paid = lookups
    .filter((l) => l.result.kind === 'status' && l.result.status === 'success')
    .map((l) => l.reference);
  if (paid.length > 0) {
    return { remind: false, reason: 'paid on Paystack — needs reconcile', paidReferences: paid };
  }

  for (const { result } of lookups) {
    if (result.kind === 'error') {
      return { remind: false, reason: `paystack unverifiable (${result.detail})`, paidReferences: [] };
    }
    if (!REMINDABLE_PAYSTACK_STATUSES.has(result.status)) {
      return { remind: false, reason: `paystack status "${result.status}"`, paidReferences: [] };
    }
  }

  return { remind: true };
};
