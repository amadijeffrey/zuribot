import { z } from 'zod';
import { BillingInterval } from '@prisma/client';

// Mirrors the schemas the handlers use. Pure parsing — no database involved.
const intervalSchema = z.string().transform(v => v.trim().toUpperCase()).pipe(z.nativeEnum(BillingInterval));

const phone = z.string().trim().regex(/^\+?[1-9]\d{6,14}$/);
const email = z.string().trim().toLowerCase().email();

describe('billing interval parsing', () => {
  it.each([['monthly','MONTHLY'], ['Monthly','MONTHLY'], ['ANNUAL','ANNUAL'], ['  semiannual  ','SEMIANNUAL']])(
    'accepts %s in any case', (input, expected) => {
      expect(intervalSchema.parse(input)).toBe(expected);
    });

  it.each(['yearly', 'six-months', '', 'MONTH'])('rejects %s', (input) => {
    expect(intervalSchema.safeParse(input).success).toBe(false);
  });
});

describe('phone validation', () => {
  it.each(['+2347033744427', '2347033744427'])('accepts %s', (v) => {
    expect(phone.safeParse(v).success).toBe(true);
  });
  it.each(['0803374442', '+0803374442', 'abc', '+23'])('rejects %s', (v) => {
    expect(phone.safeParse(v).success).toBe(false);
  });
});

describe('email normalisation', () => {
  it('lowercases and trims so duplicates cannot slip past the unique index', () => {
    expect(email.parse('  Chibuike@Example.COM ')).toBe('chibuike@example.com');
  });
});
