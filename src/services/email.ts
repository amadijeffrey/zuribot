import nodemailer from 'nodemailer';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { SUBSCRIPTION_PLANS } from '../config/constants';
import { logger } from '../utils/logger';

// Lazily-built singleton transporter. Returns null when SMTP isn't configured
// so callers can degrade gracefully instead of crashing the payment flow.
let transporter: nodemailer.Transporter | null | undefined;

const getTransporter = (): nodemailer.Transporter | null => {
  if (transporter !== undefined) return transporter;

  if (!env.SMTP_USER || !env.SMTP_PASS) {
    logger.error('SMTP not configured (SMTP_USER/SMTP_PASS missing) — emails will not be sent');
    transporter = null;
    return transporter;
  }

  transporter = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465, // 465 = implicit TLS, 587 = STARTTLS
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
  });
  return transporter;
};

const fromAddress = (): string => env.EMAIL_FROM || env.SMTP_USER || 'no-reply@zuribot';

interface SendMailArgs {
  to: string;
  subject: string;
  html: string;
  text: string;
}

// Never throws — email is a best-effort backup channel. A delivery failure must
// not roll back an already-successful payment/activation.
const sendMail = async ({ to, subject, html, text }: SendMailArgs): Promise<boolean> => {
  const tx = getTransporter();
  if (!tx) return false;

  try {
    await tx.sendMail({ from: fromAddress(), to, subject, html, text });
    logger.info('Email sent', { to, subject });
    return true;
  } catch (error: any) {
    logger.error('Failed to send email', { to, subject, error: error.message });
    return false;
  }
};

// Activation email for WEB registrants — carries the exclusive group invite link.
// This is the web equivalent of the bot's sendActivationConfirmation.
export const sendActivationEmail = async (userId: string, planId: string): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.email) {
    logger.error('Cannot send activation email — user has no email', { userId });
    return;
  }

  const plan = SUBSCRIPTION_PLANS[planId as keyof typeof SUBSCRIPTION_PLANS];
  const subscription = await prisma.subscription.findFirst({
    where: { userId, status: { in: ['ACTIVE', 'GRACE'] } },
    orderBy: { createdAt: 'desc' },
  });
  const expiryDate = subscription?.expiryDate.toLocaleDateString() || 'N/A';
  const inviteLink = plan?.inviteLink;

  const greeting = user.name ? `Hi ${user.name},` : 'Hi,';
  const subject = `Your ${plan?.name} subscription is active 🎉`;

  const text =
    `${greeting}\n\n` +
    `Your ${plan?.name} subscription is now active. It expires on ${expiryDate}.\n\n` +
    (inviteLink ? `Join your exclusive group: ${inviteLink}\n\n` : '') +
    `Thank you for subscribing.`;

  const html =
    `<p>${greeting}</p>` +
    `<p>Your <strong>${plan?.name}</strong> subscription is now active. ` +
    `It expires on <strong>${expiryDate}</strong>.</p>` +
    (inviteLink
      ? `<p><a href="${inviteLink}" style="display:inline-block;padding:12px 20px;` +
        `background:#25D366;color:#fff;text-decoration:none;border-radius:6px;">` +
        `Join your exclusive ${plan?.name} group</a></p>` +
        `<p>Or copy this link: <a href="${inviteLink}">${inviteLink}</a></p>`
      : '') +
    `<p>Thank you for subscribing.</p>`;

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

  const plan = SUBSCRIPTION_PLANS[planId as keyof typeof SUBSCRIPTION_PLANS];
  const subscription = await prisma.subscription.findFirst({
    where: { userId, status: { in: ['ACTIVE', 'GRACE'] } },
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
