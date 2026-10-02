import { classifyCheckoutGroup, PaystackLookup } from '../../src/utils/reminder-eligibility';

const status = (s: string): PaystackLookup => ({ kind: 'status', status: s });
const lookup = (reference: string, result: PaystackLookup) => ({ reference, result });
const held = (...plans: string[]) => new Set(plans);

describe('classifyCheckoutGroup — one plan\'s worth of abandoned checkouts', () => {
  describe('already subscribed to that plan', () => {
    it('ignores the checkout', () => {
      expect(classifyCheckoutGroup(held('premium'), 'premium', [])).toEqual({
        remind: false, reason: 'already subscribed', paidReferences: [],
      });
    });

    it('ignores it even when Paystack says abandoned — a stale row from an earlier attempt', () => {
      const v = classifyCheckoutGroup(held('premium'), 'premium', [lookup('SUB_PREMIUM_old', status('abandoned'))]);
      expect(v.remind).toBe(false);
    });

    it('is decided per plan: holding Health does not silence a Premium checkout', () => {
      const v = classifyCheckoutGroup(held('health'), 'premium', [lookup('SUB_PREMIUM_a', status('abandoned'))]);
      expect(v).toEqual({ remind: true });
    });
  });

  describe('not subscribed to that plan', () => {
    it.each(['abandoned', 'failed'])('reminds when every checkout is %s', (s) => {
      expect(classifyCheckoutGroup(held(), 'wealth', [lookup('SUB_WEALTH_a', status(s))])).toEqual({ remind: true });
    });

    it('reminds when several checkouts for the plan are all left/failed', () => {
      const v = classifyCheckoutGroup(held(), 'wealth', [
        lookup('SUB_WEALTH_a', status('abandoned')),
        lookup('SUB_WEALTH_b', status('failed')),
      ]);
      expect(v).toEqual({ remind: true });
    });

    it('never reminds someone who paid on Paystack, and reports the reference for reconciliation', () => {
      const v = classifyCheckoutGroup(held(), 'wealth', [
        lookup('SUB_WEALTH_a', status('abandoned')),
        lookup('SUB_WEALTH_b', status('success')),
      ]);
      expect(v).toEqual({
        remind: false, reason: 'paid on Paystack — needs reconcile', paidReferences: ['SUB_WEALTH_b'],
      });
    });

    it('surfaces a paid checkout even when another row in the group is unverifiable', () => {
      const v = classifyCheckoutGroup(held(), 'wealth', [
        lookup('SUB_WEALTH_a', { kind: 'error', detail: 'HTTP 404' }),
        lookup('SUB_WEALTH_b', status('success')),
      ]);
      expect(v).toMatchObject({ remind: false, paidReferences: ['SUB_WEALTH_b'] });
    });

    it('does not guess when Paystack cannot be reached', () => {
      const v = classifyCheckoutGroup(held(), 'wealth', [lookup('SUB_WEALTH_a', { kind: 'error', detail: 'HTTP 404' })]);
      expect(v).toEqual({ remind: false, reason: 'paystack unverifiable (HTTP 404)', paidReferences: [] });
    });

    // Arbitrary strings outside the allowlist, not a claim about what Paystack
    // emits: the rule is "abandoned or failed, and nothing else".
    it.each(['ongoing', 'pending', 'processing', 'queued', 'reversed'])(
      'leaves alone any status outside abandoned/failed, e.g. "%s" — they may be mid-payment',
      (s) => {
        const v = classifyCheckoutGroup(held(), 'wealth', [lookup('SUB_WEALTH_a', status(s))]);
        expect(v).toEqual({ remind: false, reason: `paystack status "${s}"`, paidReferences: [] });
      },
    );

    it('one non-remindable checkout in the group holds back the whole plan', () => {
      const v = classifyCheckoutGroup(held(), 'wealth', [
        lookup('SUB_WEALTH_a', status('abandoned')),
        lookup('SUB_WEALTH_b', status('ongoing')),
      ]);
      expect(v.remind).toBe(false);
    });
  });
});
