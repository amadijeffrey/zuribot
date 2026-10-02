// email.ts imports prisma at module load; the builder under test never touches it.
jest.mock('../../src/config/database', () => ({ prisma: {} }));

import { buildMembershipActivationReminder } from '../../src/services/email';

const URL_ = 'https://app.example.com/login';

describe('membership activation reminder email', () => {
  it('has the agreed subject', () => {
    expect(buildMembershipActivationReminder('Ada', URL_).subject).toBe('Your Membership Is Not Yet Active');
  });

  it('greets by first name only, however many names are stored', () => {
    expect(buildMembershipActivationReminder('Ada Obi Nwosu', URL_).text).toMatch(/^Hi Ada,\n/);
    expect(buildMembershipActivationReminder('  Ada   Obi ', URL_).html).toContain('<p>Hi Ada,</p>');
  });

  it.each([null, undefined, '', '   '])('falls back to a neutral greeting for %p', (name) => {
    const { text, html } = buildMembershipActivationReminder(name as any, URL_);
    expect(text).toMatch(/^Hi there,\n/);
    expect(html).toContain('<p>Hi there,</p>');
  });

  it('links the Activate Now button to the given URL', () => {
    const { html, text } = buildMembershipActivationReminder('Ada', URL_);
    expect(html).toContain(`<a href="${URL_}"`);
    expect(html).toContain('>Activate Now</a>');
    // A text-only client cannot render the button, so the URL must be in the body.
    expect(text).toContain(URL_);
  });

  it('closes like a letter', () => {
    const { html, text } = buildMembershipActivationReminder('Ada', URL_);
    expect(text.endsWith('Warmly,\nThe Zuri Circle Network Team')).toBe(true);
    expect(html).toContain('<p>Warmly,<br>The Zuri Circle Network Team</p>');
  });

  it('escapes a hostile name and URL instead of injecting markup', () => {
    const { html } = buildMembershipActivationReminder('<script>alert(1)</script>', 'https://x.test/?a=1&b="2"');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;script&gt;');
    // The quote must not be able to end the href attribute early.
    expect(html).toContain('href="https://x.test/?a=1&amp;b=&quot;2&quot;"');
  });
});
