import { prisma } from '../config/database';
import { env } from '../config/env';
import { SUBSCRIPTION_PLANS, UPGRADE_KEYWORDS } from '../config/constants';
import { getOrCreateUser } from './user';
import { initializePayment, initializeRenewalPayment } from './payment';
import { sendTextMessage, sendInteractiveButtons, sendInteractiveList } from './whatsapp';
import { getActiveSubscriptions, getSubscriptionForPlan } from './subscription';
import { logger } from '../utils/logger';
import { IncomingMessage, WebhookContact } from '../types/whatsapp.types';

interface MessageContext {
  message: IncomingMessage;
  contact?: WebhookContact;
}

export const processMessage = async (context: MessageContext): Promise<void> => {
  const { message, contact } = context;
  const phoneNumber = message.from;
  const profileName = contact?.profile?.name || 'User';

  // Idempotency guard. WhatsApp delivery is at-least-once and the webhook
  // relies on retries (it returns non-200 on failure), so the same message.id
  // can arrive more than once. Skip anything we've already fully processed.
  const seen = await prisma.processedMessage.findUnique({
    where: { messageId: message.id },
  });
  if (seen) {
    logger.info('Skipping already-processed message', {
      messageId: message.id,
      phoneNumber,
    });
    return;
  }

  if (env.ENABLE_MESSAGE_LOGGING) {
    await logMessage(phoneNumber, 'incoming', message);
  }

  const user = await getOrCreateUser({
    phoneNumber,
    name: profileName,
  });

  switch (message.type) {
    case 'text':
      await handleTextMessage(user, message.text?.body || '');
      break;

    case 'interactive':
      await handleInteractiveMessage(user, message);
      break;

    case 'button':
      await handleButtonMessage(user, message);
      break;

    default:
      await handleUnsupportedMessage(user.phoneNumber);
  }

  // Record only after every side effect above succeeded. A throw before this
  // point leaves no row, so the webhook returns non-200 and WhatsApp retries.
  await prisma.processedMessage.create({
    data: { messageId: message.id },
  });
};

const handleTextMessage = async (user: any, text: string): Promise<void> => {
  const normalizedText = text.trim().toUpperCase();
  const phoneNumber = user.phoneNumber;

  // Check for UPGRADE keyword first - shows all plans
  if (UPGRADE_KEYWORDS.some(keyword => normalizedText.includes(keyword))) {
    await sendAvailablePlans(phoneNumber);
    return;
  }

  // Detect direct subscription intent (e.g., "JOIN WEALTH")
  const matchedPlan = detectSubscriptionIntent(normalizedText);

  if (matchedPlan) {
    await handleSubscriptionRequest(user, matchedPlan);
    return;
  }

  // Check for other keywords
  if (normalizedText.includes('STATUS') || normalizedText.includes('MY SUBSCRIPTION')) {
    await handleStatusCheck(user);
    return;
  }

  if (normalizedText.includes('HELP') || normalizedText.includes('MENU')) {
    await sendHelpMenu(phoneNumber);
    return;
  }

  if (normalizedText.includes('RENEW') || normalizedText.includes('EXTEND')) {
    await handleRenewalRequest(user);
    return;
  }

  if (['HI', 'HELLO', 'START'].includes(normalizedText)) {
    await sendWelcomeMessage(user);
    return;
  }

  // Default response
  await sendTextMessage(
    phoneNumber,
    "I didn't understand that. Reply with *HELP* to see available options or *UPGRADE* to view plans."
  );
};

const detectSubscriptionIntent = (text: string): string | null => {
  for (const plan of Object.values(SUBSCRIPTION_PLANS)) {
    for (const keyword of plan.keywords) {
      if (text.includes(keyword.toUpperCase())) {
        return plan.id;
      }
    }
  }
  return null;
};

const sendAvailablePlans = async (phoneNumber: string): Promise<void> => {
  const sections = [{
    title: 'Available Plans',
    rows: Object.values(SUBSCRIPTION_PLANS).map(plan => ({
      id: `select_plan_${plan.id}`,
      title: plan.name,
      description: `₦${(plan.amount / 100).toLocaleString()} - ${plan.durationDays} days`,
    })),
  }];

  await sendInteractiveList(
    phoneNumber,
    '🎯 *Choose Your Plan*\n\nSelect a subscription plan to view details and proceed with payment.',
    'View Plans',
    sections,
    'Subscription Plans',
    'Tap to select a plan'
  );

  logger.info('Available plans sent', { phoneNumber });
};

const handleSubscriptionRequest = async (user: any, planId: string): Promise<void> => {
  const phoneNumber = user.phoneNumber;
  const plan = SUBSCRIPTION_PLANS[planId as keyof typeof SUBSCRIPTION_PLANS];

  if (!plan) {
    await sendTextMessage(phoneNumber, 'Invalid plan selected. Reply with *UPGRADE* to see available plans.');
    return;
  }

  // Check for an existing ACTIVE or GRACE subscription for THIS plan
  // (scoped to planId so multi-plan users don't get a duplicate row when
  // they subscribe to a plan they already hold). Latest first.
  const existingForPlan = await getSubscriptionForPlan(user.id, planId);

  if (existingForPlan) {
    if (existingForPlan.status === 'ACTIVE') {
      const expiryDate = existingForPlan.expiryDate.toLocaleDateString();
      await sendTextMessage(
        phoneNumber,
        `You already have an active *${plan.name}* subscription that expires on ${expiryDate}.`
      );
      return;
    }

    // GRACE: don't create a new sub or open a new Paystack subscription —
    // direct them to RENEW so the existing row is auth-charged in place.
    await sendTextMessage(
      phoneNumber,
      `Your *${plan.name}* subscription is in its grace period. Reply *RENEW* to reactivate it using your saved card, or *UPGRADE* to view other plans.`
    );
    return;
  }

  // Initialize payment
  const payment = await initializePayment({
    userId: user.id,
    planId: plan.id,
    email: user.email || `${phoneNumber}@whatsapp.placeholder.com`,
  });

  // Send plan details with payment link
  const message = `*${plan.name}*\n\n` +
    `${plan.description}\n\n` +
    `💰 *Amount:* ₦${(plan.amount / 100).toLocaleString()}\n` +
    `⏱️ *Duration:* ${plan.durationDays} days\n\n` +
    `Click the link below to complete your payment:\n\n` +
    `${payment.authorizationUrl}\n\n` +
    `_Reference: ${payment.reference}_`;

  await sendTextMessage(phoneNumber, message);

  logger.info('Subscription request processed', {
    userId: user.id,
    planId,
    reference: payment.reference,
  });
};

const handleStatusCheck = async (user: any): Promise<void> => {
  const subscriptions = await getActiveSubscriptions(user.id);

  if (subscriptions.length === 0) {
    await sendTextMessage(
      user.phoneNumber,
      "You don't have an active subscription.\n\nReply with *UPGRADE* to see available plans."
    );
    return;
  }

  const lines = subscriptions.map(subscription => {
    const plan = SUBSCRIPTION_PLANS[subscription.planId as keyof typeof SUBSCRIPTION_PLANS];
    const expiryDate = subscription.expiryDate.toLocaleDateString();
    const daysRemaining = Math.max(
      Math.ceil((subscription.expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)),
      0
    );
    const statusEmoji = subscription.status === 'GRACE' ? '⚠️' : '✅';
    const statusText = subscription.status === 'GRACE' ? 'Grace Period' : 'Active';

    return `📋 *Plan:* ${plan?.name || subscription.planId}\n` +
      `${statusEmoji} *Status:* ${statusText}\n` +
      `📅 *Expires:* ${expiryDate}\n` +
      `⏳ *Days Remaining:* ${daysRemaining}` +
      `${subscription.status === 'GRACE' ? '\n⚠️ Renew now to maintain access!' : ''}`;
  });

  const message = `*Your Subscription Status*\n\n` + lines.join('\n\n─────────────\n\n');

  await sendTextMessage(user.phoneNumber, message);
};

const handleRenewalRequest = async (user: any): Promise<void> => {
  const subscriptions = await getActiveSubscriptions(user.id);

  if (subscriptions.length === 0) {
    await sendTextMessage(
      user.phoneNumber,
      "You don't have any subscriptions to renew. Reply *UPGRADE* to view available plans."
    );
    return;
  }

  // Dedupe by planId — keep the most recent per plan (subscriptions are
  // already ordered createdAt desc), so orphaned rows don't surface as
  // duplicate options.
  const latestByPlan = new Map<string, typeof subscriptions[number]>();
  for (const sub of subscriptions) {
    if (!latestByPlan.has(sub.planId)) latestByPlan.set(sub.planId, sub);
  }

  const rows = Array.from(latestByPlan.values()).flatMap(sub => {
    const plan = SUBSCRIPTION_PLANS[sub.planId as keyof typeof SUBSCRIPTION_PLANS];
    if (!plan) return [];
    const statusLabel = sub.status === 'GRACE' ? 'In grace' : 'Active';
    return [{
      id: `renew_plan_${sub.planId}`,
      title: plan.name,
      description: `${statusLabel} • Expires ${sub.expiryDate.toLocaleDateString()}`,
    }];
  });

  if (rows.length === 0) {
    await sendAvailablePlans(user.phoneNumber);
    return;
  }

  await sendInteractiveList(
    user.phoneNumber,
    '🔄 *Renew a Subscription*\n\nSelect the subscription you want to renew.',
    'Select Plan',
    [{ title: 'Your Subscriptions', rows }],
    'Renewal',
    'Tap to choose'
  );
};

const handleRenewalSelection = async (user: any, planId: string): Promise<void> => {
  const subscriptions = await getActiveSubscriptions(user.id);
  const target = subscriptions.find(s => s.planId === planId && s.status === 'GRACE');

  // Non-GRACE picks (ACTIVE early-renewal, or no matching sub) fall back to
  // the regular payment flow — handleSubscriptionRequest covers the
  // "already active" UX and the new-subscribe path for users with no
  // current sub for the plan.
  if (!target) {
    await handleSubscriptionRequest(user, planId);
    return;
  }

  const plan = SUBSCRIPTION_PLANS[target.planId as keyof typeof SUBSCRIPTION_PLANS];
  if (!plan) {
    await sendTextMessage(user.phoneNumber, 'Plan not found.');
    return;
  }

  try {
    // Issue a fresh Paystack payment link tied to the existing subscription.
    // The eventual charge.success webhook will extend this sub in place
    // (applyRenewalCharge) instead of creating a new Subscription row.
    const payment = await initializeRenewalPayment(target.id);

    const message = `🔄 *${plan.name} — Renewal*\n\n` +
      `💰 *Amount:* ₦${(plan.amount / 100).toLocaleString()}\n` +
      `⏱️ *Extends by:* ${plan.durationDays} days\n\n` +
      `Click the link below to complete your renewal:\n\n` +
      `${payment.authorizationUrl}\n\n` +
      `_Reference: ${payment.reference}_`;

    await sendTextMessage(user.phoneNumber, message);

    logger.info('Renewal payment link sent', {
      userId: user.id,
      subscriptionId: target.id,
      planId,
      reference: payment.reference,
    });
  } catch (error) {
    logger.error('Renewal selection failed', { userId: user.id, planId, error });
    await sendTextMessage(
      user.phoneNumber,
      "We hit a problem starting your renewal. Please try again or reply *UPGRADE* to view plans.",
    );
  }
};

const sendWelcomeMessage = async (user: any): Promise<void> => {
  const buttons = [
    { type: 'reply' as const, reply: { id: 'action_upgrade', title: 'View Plans' } },
    { type: 'reply' as const, reply: { id: 'action_status', title: 'My Status' } },
    { type: 'reply' as const, reply: { id: 'action_help', title: 'Help' } },
  ];

  await sendInteractiveButtons(
    user.phoneNumber,
    `Welcome ${user.name || ''}! 👋\n\nJoin our exclusive community and unlock premium content.\n\nWhat would you like to do?`,
    buttons,
    'Choose an option'
  );
};

const sendHelpMenu = async (phoneNumber: string): Promise<void> => {
  const plansList = Object.values(SUBSCRIPTION_PLANS)
    .map(plan => `• *${plan.name}* - ₦${(plan.amount / 100).toLocaleString()}/month`)
    .join('\n');

  const message = `*Available Plans*\n\n${plansList}\n\n` +
    `*Commands:*\n` +
    `• *UPGRADE* - View all plans\n` +
    `• *JOIN WEALTH* - Subscribe to Wealth Plan\n` +
    `• *JOIN BOOST* - Subscribe to Boost Plan\n` +
    `• *PREMIUM* - Subscribe to Premium Plan\n` +
    `• *STATUS* - Check your subscription\n` +
    `• *RENEW* - Renew your subscription\n` +
    `• *HELP* - Show this menu`;

  await sendTextMessage(phoneNumber, message);
};

const handleInteractiveMessage = async (user: any, message: IncomingMessage): Promise<void> => {
  const interactive = message.interactive;
  if (!interactive) return;

  let selectedId: string | undefined;

  if (interactive.button_reply) {
    selectedId = interactive.button_reply.id;
  } else if (interactive.list_reply) {
    selectedId = interactive.list_reply.id;
  }

  if (!selectedId) return;

  // Handle plan selection from list
  if (selectedId.startsWith('select_plan_')) {
    const planId = selectedId.replace('select_plan_', '');
    await handleSubscriptionRequest(user, planId);
    return;
  }

  // Handle renewal selection from list
  if (selectedId.startsWith('renew_plan_')) {
    const planId = selectedId.replace('renew_plan_', '');
    await handleRenewalSelection(user, planId);
    return;
  }

  // Handle action buttons
  switch (selectedId) {
    case 'action_upgrade':
      await sendAvailablePlans(user.phoneNumber);
      break;
    case 'action_status':
      await handleStatusCheck(user);
      break;
    case 'action_help':
      await sendHelpMenu(user.phoneNumber);
      break;
    default:
      if (selectedId.startsWith('plan_')) {
        const planId = selectedId.replace('plan_', '');
        await handleSubscriptionRequest(user, planId);
      }
  }
};

const handleButtonMessage = async (user: any, message: IncomingMessage): Promise<void> => {
  const payload = message.button?.payload;

  if (payload?.startsWith('plan_')) {
    const planId = payload.replace('plan_', '');
    await handleSubscriptionRequest(user, planId);
  }
};

const handleUnsupportedMessage = async (phoneNumber: string): Promise<void> => {
  await sendTextMessage(
    phoneNumber,
    'Sorry, I can only process text messages. Please send a text message or reply with *HELP*.'
  );
};

const logMessage = async (
  phoneNumber: string,
  direction: string,
  message: IncomingMessage
): Promise<void> => {
  await prisma.messageLog.create({
    data: {
      phoneNumber,
      direction,
      messageType: message.type,
      content: message.text?.body || JSON.stringify(message),
      messageId: message.id,
    },
  });
};

export const updateMessageStatus = async (
  messageId: string,
  status: string
): Promise<void> => {
  if (!env.ENABLE_MESSAGE_LOGGING) return;

  await prisma.messageLog.updateMany({
    where: { messageId },
    data: { status },
  });
};