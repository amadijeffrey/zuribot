import axios from 'axios';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { GRACE_PERIOD_DAYS } from '../config/constants';
import { resolvePlan, getFreeGroupBenefit } from './plan';
import { logger } from '../utils/logger';

// Resend's HTTP API. Plain HTTPS keeps this working on serverless hosts that
// block outbound SMTP ports, and a send completes in a few hundred ms rather
// than the tens of seconds an unreachable SMTP socket costs.
const resendClient = axios.create({
  baseURL: 'https://api.resend.com',
  timeout: 10000,
  headers: { 'Content-Type': 'application/json' },
});

// Resend's shared test sender. Only delivers to the address that owns the
// Resend account — verify a domain and set EMAIL_FROM for real recipients.
const RESEND_TEST_SENDER = 'onboarding@resend.dev';

const fromAddress = (): string => env.EMAIL_FROM || RESEND_TEST_SENDER;

interface SendMailArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

// Never throws — email is a best-effort backup channel. A delivery failure must
// not roll back an already-successful payment/activation.
const sendMail = async ({ to, subject, html, text }: SendMailArgs): Promise<boolean> => {
  if (!env.RESEND_API_KEY) {
    logger.error('RESEND_API_KEY not configured — emails will not be sent', { to, subject });
    return false;
  }

  try {
    const { data } = await resendClient.post(
      '/emails',
      { from: fromAddress(), to, subject, html, text },
      { headers: { Authorization: `Bearer ${env.RESEND_API_KEY}` } },
    );
    logger.info('Email sent', { to, subject, emailId: data?.id });
    return true;
  } catch (error: any) {
    logger.error('Failed to send email', {
      to,
      subject,
      error: error.response?.data || error.message,
    });
    return false;
  }
};

// --- operator alerts ---

const escapeHtml = (v: unknown): string =>
  String(v).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));

// Emails every active admin. Never throws — an alert is itself an error path,
// and failing to deliver it must not mask the original problem or break the
// flow that raised it.
export const notifyAdmins = async (
  subject: string,
  context: Record<string, unknown> = {},
): Promise<void> => {
  try {
    const admins = await prisma.admin.findMany({
      where: { isActive: true },
      select: { email: true },
    });

    if (admins.length === 0) {
      logger.warn('No admin alert recipients configured — alert not emailed', { subject });
      return;
    }

    const entries = Object.entries(context);
    const text = [subject, '', ...entries.map(([k, v]) => `${k}: ${String(v)}`)].join('\n');
    const html =
      `<p><strong>${escapeHtml(subject)}</strong></p>` +
      (entries.length
        ? `<ul>${entries
            .map(([k, v]) => `<li><code>${escapeHtml(k)}</code>: ${escapeHtml(v)}</li>`)
            .join('')}</ul>`
        : '');

    await Promise.all(
      admins.map((a) =>
        sendMail({ to: a.email, subject: `[ZuriBot alert] ${subject}`, text, html }),
      ),
    );
  } catch (error: any) {
    logger.error('Failed to notify admins', { subject, error: error.message });
  }
};

// Logs the alert and emails the operators. Use for conditions a human must act
// on — money discrepancies, dropped renewals, config drift. Never throws.
export const alertAdmins = async (
  message: string,
  context: Record<string, unknown> = {},
): Promise<void> => {
  logger.error(`ALERT: ${message}`, context);
  await notifyAdmins(message, context);
};

// Activation email for WEB registrants. This is the ONLY channel that delivers
// the group links for a web signup — the success page just confirms payment —
// so it must include every group the plan grants, not just the first.
export const sendActivationEmail = async (userId: string, planId: string): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.email) {
    logger.error('Cannot send activation email — user has no email', { userId });
    return;
  }

  const plan = await resolvePlan(planId);
  const subscription = await prisma.subscription.findFirst({
    where: { userId, planId, status: { in: ['ACTIVE', 'GRACE'] } },
    orderBy: { createdAt: 'desc' },
  });
  const expiryDate = subscription?.expiryDate.toLocaleDateString() || 'N/A';

  const groups = plan?.groupLinks ?? [];
  // Perks that aren't a joinable link (the Apex VIP event) — mentioned, not linked.
  const perks = (plan?.benefits ?? []).filter((b) => b.type !== 'WHATSAPP_GROUP');

  if (groups.length === 0) {
    // Paid, but we have nothing to deliver — the plan's invite links are unset.
    // Louder than a silent empty email: the customer is owed access.
    logger.error('ALERT: activation email has no group links to send', {
      userId,
      planId,
      benefitCount: plan?.benefits.length ?? 0,
    });
  }

  const greeting = user.name ? `Hi ${user.name},` : 'Hi,';
  const subject = `Your ${plan?.name} subscription is active 🎉`;
  const groupWord = groups.length === 1 ? 'group' : 'groups';

  const text =
    `${greeting}\n\n` +
    `Your ${plan?.name} subscription is now active. It expires on ${expiryDate}.\n\n` +
    (groups.length
      ? `Join your ${groups.length} exclusive ${groupWord}:\n` +
        groups.map((g, i) => `${i + 1}. ${g.name}: ${g.inviteLink}`).join('\n') +
        '\n\n'
      : '') +
    (perks.length ? `Also included: ${perks.map((p) => p.name).join(', ')}\n\n` : '') +
    `Thank you for subscribing.`;

  const html =
    `<p>${greeting}</p>` +
    `<p>Your <strong>${escapeHtml(plan?.name)}</strong> subscription is now active. ` +
    `It expires on <strong>${escapeHtml(expiryDate)}</strong>.</p>` +
    (groups.length
      ? `<p>Join your ${groups.length} exclusive ${groupWord}:</p>` +
        groups
          .map(
            (g) =>
              `<p style="margin:8px 0;"><a href="${escapeHtml(g.inviteLink)}" ` +
              `style="display:inline-block;padding:12px 20px;background:#25D366;color:#fff;` +
              `text-decoration:none;border-radius:6px;">Join ${escapeHtml(g.name)}</a></p>`,
          )
          .join('') +
        `<p style="font-size:13px;color:#555;">If a button doesn't work, copy the link:<br>` +
        groups
          .map((g) => `${escapeHtml(g.name)}: <a href="${escapeHtml(g.inviteLink)}">${escapeHtml(g.inviteLink)}</a>`)
          .join('<br>') +
        `</p>`
      : '') +
    (perks.length
      ? `<p><strong>Also included:</strong> ${perks.map((p) => escapeHtml(p.name)).join(', ')}</p>`
      : '') +
    `<p>Thank you for subscribing.</p>`;

  await sendMail({ to: user.email, subject, html, text });
};

// Sent on registration. Membership is free, so this is the only email a user is
// guaranteed to receive — it carries the free community group.
export const sendWelcomeEmail = async (userId: string): Promise<boolean> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.email) {
    logger.error('Cannot send welcome email — user has no email', { userId });
    return false;
  }

  const free = await getFreeGroupBenefit();
  const greeting = user.name ? `Hi ${user.name},` : 'Hi,';

  if (!free?.inviteLink) {
    logger.error('Welcome email has no free group link configured', {
      userId,
      benefit: free ? free.code : 'missing',
    });
  }

  const text =
    `${greeting}\n\nWelcome to ZuriCircle Network — your account is ready.\n\n` +
    (free?.inviteLink ? `Join our community group: ${free.inviteLink}\n\n` : '') +
    `You can subscribe to a plan any time from your dashboard to unlock the exclusive groups.`;

  const html =
    `<p>${greeting}</p><p>Welcome to ZuriCircle Network — your account is ready.</p>` +
    (free?.inviteLink
      ? `<p><a href="${escapeHtml(free.inviteLink)}" style="display:inline-block;padding:12px 20px;` +
        `background:#25D366;color:#fff;text-decoration:none;border-radius:6px;">Join ${escapeHtml(free.name)}</a></p>`
      : '') +
    `<p>You can subscribe to a plan any time from your dashboard to unlock the exclusive groups.</p>`;

  return sendMail({ to: user.email, subject: 'Welcome to ZuriCircle Network', html, text });
};

// Free-form message from an operator to one subscriber. Replaces the WhatsApp
// direct-message and broadcast paths. Returns whether it was delivered so
// callers can report accurate counts.
export const sendCustomEmail = async (
  userId: string,
  subject: string,
  body: string,
): Promise<boolean> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.email) {
    logger.warn('Cannot send message — user has no email', { userId });
    return false;
  }

  const greeting = user.name ? `Hi ${user.name},` : 'Hi,';
  const paragraphs = body
    .split(/\n{2,}/)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

  return sendMail({
    to: user.email,
    subject,
    text: `${greeting}\n\n${body}`,
    html: `<p>${greeting}</p>${paragraphs}`,
  });
};

// Sent when an operator manually extends a subscription.
export const sendExtensionEmail = async (
  userId: string,
  planId: string,
  days: number,
  newExpiryDate: Date,
): Promise<boolean> => {
  const plan = await resolvePlan(planId);
  const expiry = newExpiryDate.toLocaleDateString();

  return sendCustomEmail(
    userId,
    `Your ${plan?.name ?? 'subscription'} has been extended`,
    `Good news — your ${plan?.name ?? 'subscription'} has been extended by ${days} day${days === 1 ? '' : 's'}.\n\n` +
      `It now runs until ${expiry}.`,
  );
};

// Re-sends the group invite links for a subscriber's plan.
export const resendGroupLinksEmail = async (userId: string, planId: string): Promise<boolean> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.email) {
    logger.warn('Cannot resend links — user has no email', { userId });
    return false;
  }

  const plan = await resolvePlan(planId);
  const groups = plan?.groupLinks ?? [];
  if (groups.length === 0) return false;

  const greeting = user.name ? `Hi ${user.name},` : 'Hi,';
  const word = groups.length === 1 ? 'link' : 'links';

  return sendMail({
    to: user.email,
    subject: `Your ${plan?.name} group ${word}`,
    text:
      `${greeting}\n\nHere ${groups.length === 1 ? 'is' : 'are'} your ${plan?.name} group ${word}:\n` +
      groups.map((g, i) => `${i + 1}. ${g.name}: ${g.inviteLink}`).join('\n'),
    html:
      `<p>${greeting}</p><p>Here ${groups.length === 1 ? 'is' : 'are'} your <strong>${escapeHtml(plan?.name)}</strong> group ${word}:</p>` +
      groups
        .map(
          (g) =>
            `<p style="margin:8px 0;"><a href="${escapeHtml(g.inviteLink)}" ` +
            `style="display:inline-block;padding:12px 20px;background:#25D366;color:#fff;` +
            `text-decoration:none;border-radius:6px;">Join ${escapeHtml(g.name)}</a></p>`,
        )
        .join(''),
  });
};

// Pre-renewal reminder, sent when Paystack raises the upcoming invoice.
export const sendRenewalReminderEmail = async (
  userId: string,
  planId: string,
  daysRemaining: number,
): Promise<boolean> => {
  const plan = await resolvePlan(planId);
  const day = daysRemaining === 1 ? 'day' : 'days';

  return sendCustomEmail(
    userId,
    `Your ${plan?.name ?? 'subscription'} renews in ${daysRemaining} ${day}`,
    `Your ${plan?.name ?? 'subscription'} renews in ${daysRemaining} ${day}.\n\n` +
      `No action is needed — your saved card will be charged automatically.`,
  );
};

// Grace-period notice for WEB subscribers (bot equivalent: sendGracePeriodNotification).
export const sendGracePeriodEmail = async (userId: string, planId: string): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.email) {
    logger.error('Cannot send grace period email — user has no email', { userId });
    return;
  }

  const plan = await resolvePlan(planId);
  const greeting = user.name ? `Hi ${user.name},` : 'Hi,';
  const subject = `Your ${plan?.name} subscription has expired`;

  const text =
    `${greeting}\n\n` +
    `Your ${plan?.name} subscription has expired. You have a ${GRACE_PERIOD_DAYS}-day grace ` +
    `period to renew before access is removed.\n\n` +
    `Renew to keep your access.`;

  const html =
    `<p>${greeting}</p>` +
    `<p>Your <strong>${plan?.name}</strong> subscription has expired. You have a ` +
    `<strong>${GRACE_PERIOD_DAYS}-day grace period</strong> to renew before access is removed.</p>` +
    `<p>Renew to keep your access.</p>`;

  await sendMail({ to: user.email, subject, html, text });
};

// Final expiry notice for WEB subscribers (bot equivalent: sendExpiryNotification).
export const sendExpiryEmail = async (userId: string, planId: string): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.email) {
    logger.error('Cannot send expiry email — user has no email', { userId });
    return;
  }

  const plan = await resolvePlan(planId);
  const greeting = user.name ? `Hi ${user.name},` : 'Hi,';
  const subject = `Your ${plan?.name} access has ended`;

  const text =
    `${greeting}\n\n` +
    `Your ${plan?.name} subscription and grace period have ended, so your access has been removed.\n\n` +
    `You can resubscribe at any time.`;

  const html =
    `<p>${greeting}</p>` +
    `<p>Your <strong>${plan?.name}</strong> subscription and grace period have ended, ` +
    `so your access has been removed.</p>` +
    `<p>You can resubscribe at any time.</p>`;

  await sendMail({ to: user.email, subject, html, text });
};

// Renewal confirmation email for WEB subscribers — no invite link (already in
// the group), mirroring the bot's sendRenewalConfirmation.
export const sendRenewalEmail = async (userId: string, planId: string): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.email) {
    logger.error('Cannot send renewal email — user has no email', { userId });
    return;
  }

  const plan = await resolvePlan(planId);
  const subscription = await prisma.subscription.findFirst({
    where: { userId, planId, status: { in: ['ACTIVE', 'GRACE'] } },
    orderBy: { createdAt: 'desc' },
  });
  const expiryDate = subscription?.expiryDate.toLocaleDateString() || 'N/A';

  const greeting = user.name ? `Hi ${user.name},` : 'Hi,';
  const subject = `Your ${plan?.name} subscription has been renewed`;

  const text =
    `${greeting}\n\n` +
    `Your ${plan?.name} subscription has been renewed. New expiry: ${expiryDate}.\n\n` +
    `Thank you for staying with us.`;

  const html =
    `<p>${greeting}</p>` +
    `<p>Your <strong>${plan?.name}</strong> subscription has been renewed. ` +
    `New expiry: <strong>${expiryDate}</strong>.</p>` +
    `<p>Thank you for staying with us.</p>`;

  await sendMail({ to: user.email, subject, html, text });
};
