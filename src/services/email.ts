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


interface PlanActivationCopy {
  intro: string;
  lead: string;
  items: string[];
  /** Numbered for the tiers whose copy reads as a sequence; bulleted otherwise. */
  ordered: boolean;
}

const PLAN_ACTIVATION_COPY: Record<string, PlanActivationCopy> = {
  premium: {
    intro:
      "You made the call most people talk themselves out of. Everything below is built for " +
      "someone who's done waiting for the right time, because you just proved you are.",
    lead: 'Along with everything in Free Access, you now have unlocked our specialized execution rooms:',
    ordered: true,
    items: [
      'Specialized Circles: Dive into the Accelerator, SME Circle, Founders Circle, Tech Circle, or New Mums Circle depending on your current season.',
      'Monthly Virtual Accountability Circle: Our standing monthly check-in to keep your goals on track.',
      'SME Spotlight & Lounge Advertising: As a Premium member, you get featured weekly business slots and free ad placements in The Lounge to showcase your brand to the full network.',
    ],
  },
  apex: {
    intro:
      'You are officially one of only 100 women holding a seat in our Apex tier. We cap this room ' +
      'strictly because the level of access, health integration, and financial structure provided ' +
      'here cannot be delivered at scale.',
    lead: 'Your Sovereign Access Includes:',
    ordered: true,
    items: [
      'ZCN | Health: 2 monthly 1-on-1 specialist doctor consultations, dietician access, mental health support, and wellness webinars. (Follow-ups from ₦1,000).',
      'ZCN | Wealth: Financial tools via platforms like Herconomy, HerVest, Bamboo, Risevest, and Busha.',
      'Accountability: Access to both Virtual AND Physical in-person Accountability Circles.',
      'VIP Access: Guaranteed VIP admission to The Refined Woman Conference 2026.',
      'Accelerator Fast-Track: Skip the initial compliance screening round for Fearless Female Founders 3.0.',
    ],
  },
  health: {
    intro:
      "You made a specific, deliberate choice: your body doesn't wait for the rest of your life " +
      'to slow down. It gets attention now.',
    lead: 'Live for you:',
    ordered: false,
    items: [
      'One monthly specialist doctor consultation',
      'Direct dietician access',
      'Guided wellness webinars',
    ],
  },
  wealth: {
    intro:
      'Most women wait for ‘enough’ before they start investing and that wait is the single most ' +
      "expensive decision they never notice making. You didn't make it.",
    lead: 'Your partner access, live now:',
    ordered: false,
    items: [
      'Investments & savings, built specifically for you',
      'Dollar diversification and real estate',
      'Licensed, education-first crypto access',
    ],
  },
};

const planCopyToText = (copy: PlanActivationCopy): string =>
  `${copy.intro}\n\n${copy.lead}\n` +
  copy.items.map((item, i) => (copy.ordered ? `${i + 1}. ${item}` : `• ${item}`)).join('\n') +
  '\n\n';

const planCopyToHtml = (copy: PlanActivationCopy): string => {
  const tag = copy.ordered ? 'ol' : 'ul';
  return (
    `<p>${escapeHtml(copy.intro)}</p><p>${escapeHtml(copy.lead)}</p>` +
    `<${tag}>${copy.items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</${tag}>`
  );
};

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
  const planCopy = PLAN_ACTIVATION_COPY[planId];

  const text =
    `${greeting}\n\n` +
    `Your ${plan?.name} subscription is now active. It expires on ${expiryDate}.\n\n` +
    (planCopy ? planCopyToText(planCopy) : '') +
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
    (planCopy ? planCopyToHtml(planCopy) : '') +
    (groups.length
      ? `<p>Join your ${groups.length} exclusive ${groupWord}:</p>` +
        groups
          .map(
            (g) =>
              `<p style="margin:8px 0;"><a href="${escapeHtml(g.inviteLink)}" ` +
              `style="display:inline-block;padding:12px 20px;background:#25D366;color:#fff;` +
              `text-decoration:none;border-radius:6px;">Join ${escapeHtml(g.name)}</a></p>`,
          )
          .join('')
      : '') +
    (perks.length
      ? `<p><strong>Also included:</strong> ${perks.map((p) => escapeHtml(p.name)).join(', ')}</p>`
      : '') +
    `<p>Thank you for subscribing.</p>`;

  await sendMail({ to: user.email, subject, html, text });
};

// Sent once PATCH /users/edit succeeds — the actual delivery point for every
// group invite link a new member is owed. The welcome email sent at
// registration only points here (its CTA is /membership-activation); it never
// carries a link itself, because a paid plan chosen at registration may not
// have finished checkout yet by the time that email goes out. By the time
// profile completion succeeds the member's paid subscription(s), if any, are
// active — so this always includes the free group plus every plan they
// currently hold.
export const sendMembershipActivationEmail = async (userId: string): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.email) {
    logger.error('Cannot send membership activation email — user has no email', { userId });
    return;
  }

  const free = await getFreeGroupBenefit();
  const subscriptions = await prisma.subscription.findMany({
    where: { userId, status: { in: ['ACTIVE', 'GRACE'] } },
  });
  const plans = (await Promise.all(subscriptions.map((s) => resolvePlan(s.planId)))).filter(
    (p): p is NonNullable<typeof p> => !!p,
  );

  const groups: { name: string; inviteLink: string }[] = [];
  if (free?.inviteLink) groups.push({ name: free.name, inviteLink: free.inviteLink });
  for (const plan of plans) {
    for (const g of plan.groupLinks) {
      if (!groups.some((existing) => existing.inviteLink === g.inviteLink)) groups.push(g);
    }
  }
  const perks = plans.flatMap((p) => p.benefits.filter((b) => b.type !== 'WHATSAPP_GROUP'));

  if (groups.length === 0) {
    // Everyone gets at least the free group — this means it's unconfigured.
    logger.error('ALERT: membership activation email has no group links to send', { userId });
  }

  const greeting = user.name ? `Hi ${user.name},` : 'Hi,';
  const groupWord = groups.length === 1 ? 'group' : 'groups';
  const planCopies = subscriptions
    .map((s) => PLAN_ACTIVATION_COPY[s.planId])
    .filter((c): c is PlanActivationCopy => !!c);

  // Paired off `subscriptions` rather than `plans`, which is filtered — one
  // unresolvable plan would shift the indexes and print somebody else's expiry
  // date against the wrong tier. resolvePlan reads the in-process cache, so
  // resolving a second time costs no query.
  const activeLines = await Promise.all(
    subscriptions.map(async (s) => {
      const plan = await resolvePlan(s.planId);
      return { name: plan?.name ?? s.planId, expiry: s.expiryDate.toLocaleDateString() };
    }),
  );

  const text =
    `${greeting}\n\nYour profile is complete and your Zuri Circle Network access is ready.\n\n` +
    (activeLines.length
      ? activeLines
          .map((l) => `Your ${l.name} subscription is now active. It expires on ${l.expiry}.`)
          .join('\n') + '\n\n'
      : '') +
    planCopies.map(planCopyToText).join('') +
    (groups.length
      ? `Join your ${groups.length} exclusive ${groupWord}:\n` +
        groups.map((g, i) => `${i + 1}. ${g.name}: ${g.inviteLink}`).join('\n') +
        '\n\n'
      : '') +
    (perks.length ? `Also included: ${perks.map((p) => p.name).join(', ')}\n\n` : '') +
    `Welcome aboard.`;

  const html =
    `<p>${greeting}</p><p>Your profile is complete and your Zuri Circle Network access is ready.</p>` +
    activeLines
      .map(
        (l) =>
          `<p>Your <strong>${escapeHtml(l.name)}</strong> subscription is now active. ` +
          `It expires on <strong>${escapeHtml(l.expiry)}</strong>.</p>`,
      )
      .join('') +
    planCopies.map(planCopyToHtml).join('') +
    (groups.length
      ? `<p>Join your ${groups.length} exclusive ${groupWord}:</p>` +
        groups
          .map(
            (g) =>
              `<p style="margin:8px 0;"><a href="${escapeHtml(g.inviteLink)}" ` +
              `style="display:inline-block;padding:12px 20px;background:#25D366;color:#fff;` +
              `text-decoration:none;border-radius:6px;">Join ${escapeHtml(g.name)}</a></p>`,
          )
          .join('')
      : '') +
    (perks.length
      ? `<p><strong>Also included:</strong> ${perks.map((p) => escapeHtml(p.name)).join(', ')}</p>`
      : '') +
    `<p>Welcome aboard.</p>`;

  await sendMail({ to: user.email, subject: 'Your Zuri Circle Network access is ready', html, text });
};

// Sent on registration — the only email every registrant is guaranteed to
// receive, paid plan or not. Its CTA points at /membership-activation rather
// than carrying a group link directly: sendMembershipActivationEmail is what
// actually delivers those, once PATCH /users/edit completes the profile.
export const sendWelcomeEmail = async (userId: string): Promise<boolean> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.email) {
    logger.error('Cannot send welcome email — user has no email', { userId });
    return false;
  }

  const free = await getFreeGroupBenefit();
  const greeting = user.name ? `Hi ${user.name},` : 'Hi,';

  if (!free) {
    logger.error('Welcome email — free group benefit not configured', { userId });
  }

  // Omitted rather than shown blank when absent: memberId is nullable for rows
  // the bot created before member IDs existed, and "Member ID []" reads as a bug.
  const memberIdText = user.memberId ? ` Member ID [${user.memberId}]` : '';
  const memberIdHtml = user.memberId
    ? ` Member ID <strong>[${escapeHtml(user.memberId)}]</strong>`
    : '';

  // The CTA used to be a direct WhatsApp invite link. It now routes through
  // activation instead — group access (the invite link included) is granted
  // from there via PATCH /users/edit, not straight from this email.
  const activationUrl = env.FRONTEND_URL
    ? `${env.FRONTEND_URL.replace(/\/$/, '')}/membership-activation`
    : undefined;

  const text =
    `${greeting}\n\nWelcome to Zuri Circle Network. The door is officially open.\n\n` +
    `You just did something most people talk about and never do. You walked through the door ` +
    `instead of scrolling past it. Your Zuri Circle Network membership is active.${memberIdText}\n\n` +
    `Here's what's live for you right now:\n` +
    `• The Lounge: the daily pulse of the whole network.\n` +
    `• Careers & Opps: the doors that open quietly before they open publicly.\n` +
    `• The Prayer Room: grounding, for every faith.\n\n` +
    (activationUrl ? `Activate your membership: ${activationUrl}\n\n` : '') +
    `Your first move, right now: step into The Lounge and introduce yourself. Tell us who you are, what you're building, one thing you want this month. The women who get the most out of this network are the ones who stop waiting to be noticed.\n\n` +
    `Glad you're here,\nThe ZCN Team`;

  const html =
    `<p>${greeting}</p><p>Welcome to Zuri Circle Network. The door is officially open.</p>` +
    `<p>You just did something most people talk about and never do. You walked through the door ` +
    `instead of scrolling past it. Your Zuri Circle Network membership is active.${memberIdHtml}</p>` +
    `<p>Here's what's live for you right now:</p>` +
    `<ul>` +
    `<li><strong>The Lounge</strong>: the daily pulse of the whole network.</li>` +
    `<li><strong>Careers &amp; Opps</strong>: the doors that open quietly before they open publicly.</li>` +
    `<li><strong>The Prayer Room</strong>: grounding, for every faith.</li>` +
    `</ul>` +
    (activationUrl
      ? `<p><a href="${escapeHtml(activationUrl)}" style="display:inline-block;padding:12px 20px;` +
        `background:#25D366;color:#fff;text-decoration:none;border-radius:6px;">Activate your membership</a></p>`
      : '') +
    `<p>Your first move, right now: step into The Lounge and introduce yourself. Tell us who you are, what you're building, one thing you want this month. The women who get the most out of this network are the ones who stop waiting to be noticed.</p>` +
    // <br> rather than two <p>s so the sign-off reads as one block, the way the
    // closing lines of a letter sit together.
    `<p>Glad you're here,<br>The ZCN Team</p>`;

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
