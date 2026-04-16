import { prisma } from '../config/database';
import { env } from '../config/env';
import { SUBSCRIPTION_PLANS, UPGRADE_KEYWORDS } from '../config/constants';
import { getOrCreateUser } from './user';
import { initializePayment } from './payment';
import { sendTextMessage, sendInteractiveButtons, sendInteractiveList } from './whatsapp';
import { getActiveSubscription, getUserLatestSubscription } from './subscription';
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

  try {
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
  } catch (error) {
    logger.error('Error processing message', { phoneNumber, error });
    await sendTextMessage(
      phoneNumber,
      'Sorry, something went wrong. Please try again later.'
    );
  }
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

  // Check for existing active subscription to same plan
  const existingSubscription = await getActiveSubscription(user.id);

  if (existingSubscription && existingSubscription.planId === planId) {
    const expiryDate = existingSubscription.expiryDate.toLocaleDateString();
    await sendTextMessage(
      phoneNumber,
      `You already have an active *${plan.name}* subscription that expires on ${expiryDate}.\n\nTo renew early, reply with *RENEW*.`
    );
    return;
  }

  // Initialize payment
  const payment = await initializePayment({
    userId: user.id,
    planId: plan.id,
    amount: plan.amount,
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
  const subscription = await getActiveSubscription(user.id);

  if (!subscription) {
    await sendTextMessage(
      user.phoneNumber,
      "You don't have an active subscription.\n\nReply with *UPGRADE* to see available plans."
    );
    return;
  }

  const plan = SUBSCRIPTION_PLANS[subscription.planId as keyof typeof SUBSCRIPTION_PLANS];
  const expiryDate = subscription.expiryDate.toLocaleDateString();
  const daysRemaining = Math.ceil(
    (subscription.expiryDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
  );

  const statusEmoji = subscription.status === 'GRACE' ? '⚠️' : '✅';
  const statusText = subscription.status === 'GRACE' ? 'Grace Period' : 'Active';

  const message = `*Your Subscription Status*\n\n` +
    `📋 *Plan:* ${plan?.name || subscription.planId}\n` +
    `${statusEmoji} *Status:* ${statusText}\n` +
    `📅 *Expires:* ${expiryDate}\n` +
    `⏳ *Days Remaining:* ${Math.max(daysRemaining, 0)}\n\n` +
    `${subscription.status === 'GRACE' ? '⚠️ Your subscription has expired. Renew now to maintain access!' : ''}`;

  await sendTextMessage(user.phoneNumber, message);
};

const handleRenewalRequest = async (user: any): Promise<void> => {
  const subscription = await getUserLatestSubscription(user.id);

  if (subscription) {
    await handleSubscriptionRequest(user, subscription.planId);
  } else {
    await sendAvailablePlans(user.phoneNumber);
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