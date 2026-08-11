import { redactPaystackData, redactInfoInPlace } from '../../src/utils/redact';

describe('paystack payload redaction', () => {
  const raw = {
    reference: 'R1', amount: 500000, currency: 'NGN', status: 'success', channel: 'card',
    paid_at: '2026-08-09T00:00:00Z', ip_address: '102.89.1.2',
    log: { time_spent: 40, history: ['a'] },
    authorization: {
      bin: '418745', last4: '4354', brand: 'visa', exp_month: '01', exp_year: '2028',
      account_name: 'CHIBUIKE JEFFREY AMADI', bank: 'Access Bank', signature: 'SIG_x',
      authorization_code: 'AUTH_x', reusable: true, card_type: 'visa debit',
    },
    customer: { email: 'c@x.com', customer_code: 'CUS_x', phone: '+234700' },
    fees_breakdown: [{ amount: 750 }],
  };

  const clean = redactPaystackData(raw)!;
  const blob = JSON.stringify(clean);

  it.each(['bin','exp_month','exp_year','account_name','signature','bank','ip_address','log','fees_breakdown'])(
    'drops %s', (field) => {
      expect(blob).not.toContain(`"${field}"`);
    });

  it('keeps what reconciliation and support actually need', () => {
    expect(clean.authorization).toMatchObject({ authorization_code: 'AUTH_x', last4: '4354', brand: 'visa' });
    expect(clean.customer).toMatchObject({ customer_code: 'CUS_x' });
    expect(clean.amount).toBe(500000);
  });

  it('returns null for a non-object payload', () => {
    expect(redactPaystackData(null)).toBeNull();
    expect(redactPaystackData('nope')).toBeNull();
  });
});

describe('log PII masking', () => {
  it('masks emails, phones and nested identifiers but leaves ids readable', () => {
    const info: any = {
      level: 'info', message: 'x', service: 'zuribot',
      to: 'chibuikeamadi@enyata.com',
      phoneNumber: '+2347033744427',
      userId: 'keep-me-visible',
      context: { customerEmail: 'nested@example.com', amount: 50000 },
    };
    redactInfoInPlace(info);

    expect(info.to).toBe('chi***@enyata.com');
    expect(info.phoneNumber).not.toContain('7033744427');
    expect(info.userId).toBe('keep-me-visible');
    expect(info.context.customerEmail).toBe('nes***@example.com');
    expect(info.context.amount).toBe(50000);
  });

  it('leaves winston reserved fields untouched', () => {
    const info: any = { level: 'error', message: 'boom', timestamp: 't', service: 'zuribot' };
    redactInfoInPlace(info);
    expect(info).toEqual({ level: 'error', message: 'boom', timestamp: 't', service: 'zuribot' });
  });
});
