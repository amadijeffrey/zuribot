// email.ts imports prisma at module load; the builder under test never touches it.
jest.mock('../../src/config/database', () => ({ prisma: {} }));

import { buildPendingPaymentReminder } from '../../src/services/email';

const URL_ = 'https://app.example.com/login';

describe('pending payment reminder email', () => {
  it('has the agreed subject', () => {
    expect(buildPendingPaymentReminder('Ada', URL_).subject).toBe(
      "You're One Step Away From Joining Zuri Circle Network",
    );
  });

  it('greets by first name only, however many names are stored', () => {
    expect(buildPendingPaymentReminder('Ada Obi Nwosu', URL_).text).toMatch(/^Hi Ada,\n/);
    expect(buildPendingPaymentReminder('  Ada   Obi ', URL_).html).toContain('<p>Hi Ada,</p>');
  });

  it.each([null, undefined, '', '   '])('falls back to a neutral greeting for %p', (name) => {
    const { text, html } = buildPendingPaymentReminder(name as any, URL_);
    expect(text).toMatch(/^Hi there,\n/);
    expect(html).toContain('<p>Hi there,</p>');
  });

  it('links the Complete Payment button to the given URL', () => {
    const { html, text } = buildPendingPaymentReminder('Ada', URL_);
    expect(html).toContain(`<a href="${URL_}"`);
    expect(html).toContain('>Complete Payment</a>');
    // A text-only client cannot render the button, so the URL must be in the body.
    expect(text).toContain(URL_);
  });

  it('closes like a letter', () => {
    const { html, text } = buildPendingPaymentReminder('Ada', URL_);
    expect(text.endsWith('Warmly,\nThe Zuri Circle Network Team')).toBe(true);
    expect(html).toContain('<p>Warmly,<br>The Zuri Circle Network Team</p>');
  });

  it('escapes a hostile name and URL instead of injecting markup', () => {
    const { html } = buildPendingPaymentReminder('<script>alert(1)</script>', 'https://x.test/?a=1&b="2"');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    // The quote must not be able to end the href attribute early.
    expect(html).toContain('href="https://x.test/?a=1&amp;b=&quot;2&quot;"');
  });
});
