// Resend is mocked: nothing here sends mail. The point is to pin what would be sent.
const mockPost = jest.fn();
jest.mock('axios', () => ({
  __esModule: true,
  default: { create: () => ({ post: (...args: unknown[]) => mockPost(...args) }) },
}));

jest.mock('../../src/config/database', () => ({ prisma: {} }));
jest.mock('../../src/config/env', () => ({
  env: {
    RESEND_API_KEY: 'test-key',
    EMAIL_FROM: 'ZCN <info@zcn.test>',
    FRONTEND_URL: 'https://app.test/',
    GRACE_PERIOD_DAYS: 3,
  },
  isLocal: true,
}));

import { env } from '../../src/config/env';
import { sendPendingPaymentReminderToAddress } from '../../src/services/email';

const mutableEnv = env as unknown as { FRONTEND_URL?: string };

beforeEach(() => {
  mockPost.mockReset();
  mutableEnv.FRONTEND_URL = 'https://app.test/';
});

describe('sendPendingPaymentReminderToAddress', () => {
  it('sends the built reminder to exactly the address given, from the configured sender', async () => {
    mockPost.mockResolvedValue({ data: { id: 'em_1' } });

    const ok = await sendPendingPaymentReminderToAddress('me@example.com', 'Ada Obi');

    expect(ok).toBe(true);
    expect(mockPost).toHaveBeenCalledTimes(1);
    const [path, body, config] = mockPost.mock.calls[0];
    expect(path).toBe('/emails');
    expect(body.to).toBe('me@example.com');
    expect(body.from).toBe('ZCN <info@zcn.test>');
    expect(body.subject).toBe("You're One Step Away From Joining Zuri Circle Network");
    expect(body.text).toMatch(/^Hi Ada,\n/);
    expect(config.headers.Authorization).toBe('Bearer test-key');
  });

  it('points the button at FRONTEND_URL/login, trimming a trailing slash', async () => {
    mockPost.mockResolvedValue({ data: { id: 'em_1' } });

    await sendPendingPaymentReminderToAddress('me@example.com', null);

    const body = mockPost.mock.calls[0][1];
    expect(body.html).toContain('href="https://app.test/login"');
    expect(body.text).toContain('https://app.test/login');
    expect(body.text).toMatch(/^Hi there,\n/);
  });

  it('sends nothing and reports failure when FRONTEND_URL is unset', async () => {
    mutableEnv.FRONTEND_URL = undefined;

    expect(await sendPendingPaymentReminderToAddress('me@example.com', 'Ada')).toBe(false);
    expect(mockPost).not.toHaveBeenCalled();
  });

  it('reports failure — rather than throwing — when Resend rejects the mail', async () => {
    mockPost.mockRejectedValue({ response: { data: { message: 'domain not verified' } } });

    await expect(sendPendingPaymentReminderToAddress('me@example.com', 'Ada')).resolves.toBe(false);
  });
});
