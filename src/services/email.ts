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

// Recipients for every operator email. The admins table IS the distribution
// list — there is no separate alert address — so an empty result means alerts
// go nowhere, which is why callers log rather than fail silently.
const activeAdminEmails = async (): Promise<string[]> => {
  const admins = await prisma.admin.findMany({ where: { isActive: true }, select: { email: true } });
  return admins.map((a) => a.email);
};

// Emails every active admin. Never throws — an alert is itself an error path,
// and failing to deliver it must not mask the original problem or break the
// flow that raised it.
export const notifyAdmins = async (
  subject: string,
  context: Record<string, unknown> = {},
): Promise<void> => {
  try {
    const admins = await activeAdminEmails();

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
      admins.map((email) =>
        sendMail({ to: email, subject: `[ZuriBot alert] ${subject}`, text, html }),
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

// Documents a plan entitles the member to, rendered as download buttons.
//
// Without this a DOCUMENT benefit would only be NAMED in the "Also included"
// line alongside non-deliverable perks, so the member would be told the
// worksheet exists and never given it. Links rather than attaches: the file is
// hosted, so the email stays small and the member always gets the current
// version rather than whatever was attached the day they joined.
interface DocumentBenefit {
  name: string;
  inviteLink: string;
}

const documentBenefits = (benefits: { type: string; name: string; inviteLink: string | null }[]) =>
  benefits.filter((b): b is DocumentBenefit & { type: string } => b.type === 'DOCUMENT' && !!b.inviteLink);

const documentsToText = (docs: DocumentBenefit[]): string =>
  docs.length
    ? docs.map((d) => `Download the worksheet — ${d.name}:\n${d.inviteLink}`).join('\n\n') +
      '\n\n'
    : '';

const documentsToHtml = (docs: DocumentBenefit[]): string =>
  docs.length
    ? docs
        .map(
          (d) =>
            // The document's full name already sits above it in the plan copy, so
            // the button says what it does rather than repeating the title.
            `<p style="margin:8px 0;"><a href="${escapeHtml(d.inviteLink)}" ` +
            `style="display:inline-block;padding:12px 20px;background:#111;color:#fff;` +
            `text-decoration:none;border-radius:6px;">Download the worksheet</a></p>`,
        )
        .join('')
    : '';

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
  // Documents are delivered as their own buttons below, so they must not also
  // appear in the "Also included" name list.
  const docs = documentBenefits(plan?.benefits ?? []);
  const perks = (plan?.benefits ?? []).filter(
    (b) => b.type !== 'WHATSAPP_GROUP' && b.type !== 'DOCUMENT',
  );

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
    documentsToText(docs) +
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
    documentsToHtml(docs) +
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
  const docs = documentBenefits(plans.flatMap((p) => p.benefits));
  const perks = plans.flatMap((p) =>
    p.benefits.filter((b) => b.type !== 'WHATSAPP_GROUP' && b.type !== 'DOCUMENT'),
  );

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
    documentsToText(docs) +
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
    documentsToHtml(docs) +
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

  // Renewing happens behind a session, so the CTA points at login rather than
  // straight at a renewal route. Omitted entirely when FRONTEND_URL is unset —
  // a button linking nowhere is worse than no button.
  const loginUrl = env.FRONTEND_URL
    ? `${env.FRONTEND_URL.replace(/\/$/, '')}/login`
    : undefined;

  // Offered unconditionally, without trying to establish WHY the charge failed.
  // Paystack does not reliably report a reason — a live fraud decline came back
  // with description: null on both the webhook and the API — so any branching on
  // cause would be branching on a value we usually do not have.
  //
  // Instead the copy covers both remedies and lets the member pick: top up (for
  // insufficient funds, where Paystack's own retry resolves it and replacing the
  // card would be pointless work) or replace the card (expired/declined, where a
  // retry on the same card fails forever). Presented as an option rather than an
  // instruction, so neither reader is misdirected.
  //
  // Points at our own redirect rather than a Paystack link minted here. Paystack's
  // token expires in ~24h while the grace period runs for GRACE_PERIOD_DAYS, so an
  // embedded link would be dead for anyone opening this a day later — and minting
  // it here also put an outbound call inside the webhook request path. The
  // redirect mints one at click time instead.
  const subscription = await prisma.subscription.findFirst({
    where: { userId, planId, status: { in: ['ACTIVE', 'GRACE'] } },
    orderBy: { createdAt: 'desc' },
  });
  // Both halves required: the token is what authorises the redirect, and it is
  // nullable on subscriptions created before that path existed.
  const manageCardUrl =
    env.API_BASE_URL && subscription?.paystackSubscriptionCode && subscription.paystackEmailToken
      ? `${env.API_BASE_URL.replace(/\/$/, '')}/paystack/manage/` +
        `${subscription.paystackSubscriptionCode}/${subscription.paystackEmailToken}`
      : null;

  const text =
    `${greeting}\n\n` +
    `Your ${plan?.name} subscription has expired. You have a ${GRACE_PERIOD_DAYS}-day grace ` +
    `period to renew before access is removed.\n\n` +
    (manageCardUrl
      ? `Two ways to sort this out:\n` +
        `• If there simply weren't funds available, top up — we retry automatically, nothing else needed.\n` +
        `• If the card has expired or was declined, replace it here (this also fixes future renewals): ${manageCardUrl}\n\n`
      : '') +
    (loginUrl ? `Renew to keep your access: ${loginUrl}\n\n` : `Renew to keep your access via your dashboard.\n\n`) +
    `Glad you're here,\nThe ZCN Team`;

  const html =
    `<p>${greeting}</p>` +
    `<p>Your <strong>${plan?.name}</strong> subscription has expired. You have a ` +
    `<strong>${GRACE_PERIOD_DAYS}-day grace period</strong> to renew before access is removed.</p>` +
    (manageCardUrl
      ? `<p>Two ways to sort this out:</p>` +
        `<ul><li>If there simply weren't funds available, top up — we retry automatically, nothing else needed.</li>` +
        `<li>If the card has expired or was declined, replace it below. This also fixes future renewals.</li></ul>` +
        `<p><a href="${escapeHtml(manageCardUrl)}" style="display:inline-block;padding:12px 20px;` +
        `background:#25D366;color:#fff;text-decoration:none;border-radius:6px;">Update your card</a></p>`
      : '') +
    (loginUrl
      ? `<p><a href="${escapeHtml(loginUrl)}" style="display:inline-block;padding:12px 20px;` +
        `background:#111;color:#fff;text-decoration:none;border-radius:6px;">Renew your subscription</a></p>`
      : `<p>Renew to keep your access via your dashboard.</p>`) +
    `<p>Glad you're here,<br>The ZCN Team</p>`;

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

  const loginUrl = env.FRONTEND_URL
    ? `${env.FRONTEND_URL.replace(/\/$/, '')}/login`
    : undefined;

  const text =
    `${greeting}\n\n` +
    `Your ${plan?.name} subscription and grace period have ended, so your access has been removed.\n\n` +
    (loginUrl ? `You can resubscribe at any time: ${loginUrl}\n\n` : `You can resubscribe at any time.\n\n`) +
    `Glad you're here,\nThe ZCN Team`;

  const html =
    `<p>${greeting}</p>` +
    `<p>Your <strong>${plan?.name}</strong> subscription and grace period have ended, ` +
    `so your access has been removed.</p>` +
    (loginUrl
      ? `<p><a href="${escapeHtml(loginUrl)}" style="display:inline-block;padding:12px 20px;` +
        `background:#25D366;color:#fff;text-decoration:none;border-radius:6px;">Resubscribe</a></p>`
      : `<p>You can resubscribe at any time.</p>`) +
    `<p>Glad you're here,<br>The ZCN Team</p>`;

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

// Monthly check-in for the tiers that include the 90-Day Execution Track &
// Goal-Bursting Worksheet. Sent by the scheduled worksheet-reminder job.
//

export const sendWorksheetReminderEmail = async (
  userId: string,
  planId: string,
): Promise<boolean> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.email) {
    logger.error('Cannot send worksheet reminder — user has no email', { userId });
    return false;
  }

  const plan = await resolvePlan(planId);
  const greeting = user.name ? `Hi ${user.name},` : 'Hi,';
  const subject = 'Your 90-day Worksheet — how is it going?';

  // The member may have lost the activation email months ago, so the monthly
  // check-in carries the worksheet itself rather than only asking about it.
  const docs = documentBenefits(plan?.benefits ?? []);


  const text =
    `${greeting}\n\n` +
    `Your ${plan?.name} membership includes the 90-Day Execution Track & Goal-Bursting ` +
    `Worksheet — your annual goals broken into enforced 90-day sprints, with a working ` +
    `document that turns each sprint into a real, trackable plan.\n\n` +
    `Two questions, and they only take a minute to answer honestly:\n` +
    `1. Have you filled yours in yet?\n` +
    `2. If you have — are you actually hitting the goals you set for each interval?\n\n` +
    documentsToText(docs);

  const html =
    `<p>${greeting}</p>` +
    `<p>Your <strong>${escapeHtml(plan?.name)}</strong> membership includes the ` +
    `<strong>90-Day Execution Track &amp; Goal-Bursting Worksheet</strong> — your annual goals ` +
    `broken into enforced 90-day sprints, with a working document that turns each sprint into a ` +
    `real, trackable plan.</p>` +
    `<p>Two questions, and they only take a minute to answer honestly:</p>` +
    `<ol><li>Have you filled yours in yet?</li>` +
    `<li>If you have — are you actually hitting the goals you set for each interval?</li></ol>` +
    documentsToHtml(docs);

  return sendMail({ to: user.email, subject, html, text });
};

export interface ExpiredSubscriberSummary {
  memberId: string | null;
  name: string | null;
  email: string | null;
  phoneNumber: string;
  planName: string;
  expiryDate: Date;
}

// One digest per sweep rather than one email per member: a single run can expire
// up to its batch size, and forty separate emails would be unreadable and would
// train the operators to ignore them.
//
// Sent to the operators, so member contact details are included deliberately —
// they are exactly what is needed to action the removals below. Never throws:
// this is a notification about work already committed, and a failed send must
// not roll back an expiry the member's access already reflects.
export const sendExpiryDigestToAdmins = async (
  expired: ExpiredSubscriberSummary[],
): Promise<void> => {
  if (expired.length === 0) return;

  try {
    const admins = await activeAdminEmails();
    if (admins.length === 0) {
      logger.warn('Subscriptions expired but no admin recipients are configured', {
        count: expired.length,
      });
      return;
    }

    const subject = `${expired.length} subscription${expired.length === 1 ? '' : 's'} expired`;
    const row = (s: ExpiredSubscriberSummary) =>
      [s.memberId ?? '—', s.name ?? '—', s.email ?? s.phoneNumber, s.planName, s.expiryDate.toLocaleDateString()];

    const text =
      `${expired.length} subscription${expired.length === 1 ? '' : 's'} moved from grace to expired.\n\n` +
      expired.map((s) => `• ${row(s).join('  |  ')}`).join('\n') +
      `\n\nEach of these now needs removing from the WhatsApp groups their plan granted — ` +
      `WhatsApp's API cannot do this for us. They are queued at GET /api/admin/removals.`;

    const html =
      `<p><strong>${expired.length} subscription${expired.length === 1 ? '' : 's'}</strong> ` +
      `moved from grace to expired.</p>` +
      `<table cellpadding="6" style="border-collapse:collapse;font-size:14px;">` +
      `<tr style="background:#f4f4f4;text-align:left;">` +
      ['Member ID', 'Name', 'Contact', 'Plan', 'Expired'].map((h) => `<th>${h}</th>`).join('') +
      `</tr>` +
      expired
        .map(
          (s) =>
            `<tr style="border-top:1px solid #ddd;">` +
            row(s).map((c) => `<td>${escapeHtml(c)}</td>`).join('') +
            `</tr>`,
        )
        .join('') +
      `</table>` +
      `<p>Each of these now needs removing from the WhatsApp groups their plan granted — ` +
      `WhatsApp's API cannot do this for us. They are queued at ` +
      `<code>GET /api/admin/removals</code>.</p>`;

    await Promise.all(
      admins.map((email) => sendMail({ to: email, subject: `[ZuriBot] ${subject}`, html, text })),
    );
  } catch (error: any) {
    logger.error('Failed to send expiry digest to admins', { error: error.message });
  }
};
