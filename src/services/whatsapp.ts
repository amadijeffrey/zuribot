import axios, { AxiosError } from 'axios';
import { env } from '../config/env';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { SendMessagePayload, InteractiveButton } from '../types/whatsapp.types';

const whatsappClient = axios.create({
  baseURL: `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}`,
  timeout: 15000,
  headers: {
    Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  },
});

export const sendTextMessage = async (
  to: string,
  text: string
): Promise<string | null> => {
  const payload: SendMessagePayload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'text',
    text: { body: text, preview_url: true },
  };

  return sendMessage(payload);
};

export const sendInteractiveButtons = async (
  to: string,
  bodyText: string,
  buttons: InteractiveButton[],
  footerText?: string
): Promise<string | null> => {
  const payload: SendMessagePayload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'button',
      body: { text: bodyText },
      footer: footerText ? { text: footerText } : undefined,
      action: { buttons },
    },
  };

  return sendMessage(payload);
};

export const sendInteractiveList = async (
  to: string,
  bodyText: string,
  buttonText: string,
  sections: { title: string; rows: { id: string; title: string; description?: string }[] }[],
  headerText?: string,
  footerText?: string
): Promise<string | null> => {
  const payload: SendMessagePayload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'list',
      header: headerText ? { type: 'text', text: headerText } : undefined,
      body: { text: bodyText },
      footer: footerText ? { text: footerText } : undefined,
      action: { button: buttonText, sections },
    },
  };

  return sendMessage(payload);
};

export const sendCtaUrlMessage = async (
  to: string,
  bodyText: string,
  displayText: string,
  url: string,
  footerText?: string
): Promise<string | null> => {
  const payload: SendMessagePayload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      body: { text: bodyText },
      footer: footerText ? { text: footerText } : undefined,
      action: {
        name: 'cta_url',
        parameters: {
          display_text: displayText,
          url,
        },
      },
    },
  };

  return sendMessage(payload);
};

export const sendTemplateMessage = async (
  to: string,
  templateName: string,
  languageCode: string = 'en',
  components?: any[]
): Promise<string | null> => {
  const payload: SendMessagePayload = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to,
    type: 'template',
    template: {
      name: templateName,
      language: { code: languageCode },
      components,
    },
  };

  return sendMessage(payload);
};

const sendMessage = async (
  payload: SendMessagePayload,
  retries: number = 3
): Promise<string | null> => {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await whatsappClient.post('/messages', payload);
      const messageId = response.data.messages?.[0]?.id;

      if (env.ENABLE_MESSAGE_LOGGING) {
        await logOutgoingMessage(payload, messageId);
      }

      logger.info('Message sent successfully', {
        to: payload.to,
        type: payload.type,
        messageId,
      });

      return messageId;
    } catch (error) {
      lastError = error as Error;
      const axiosError = error as AxiosError;

      logger.warn('Message send attempt failed', {
        attempt,
        to: payload.to,
        error: axiosError.response?.data || axiosError.message,
      });

      if (!isRetryableError(axiosError)) break;

      if (attempt < retries) {
        await delay(Math.pow(2, attempt) * 1000);
      }
    }
  }

  logger.error('Failed to send message after all retries', {
    to: payload.to,
    type: payload.type,
    error: lastError?.message,
  });

  return null;
};

const isRetryableError = (error: AxiosError): boolean => {
  const status = error.response?.status;
  return !!status && (status >= 500 || status === 429);
};

const logOutgoingMessage = async (
  payload: SendMessagePayload,
  messageId: string | undefined
): Promise<void> => {
  let content = '';
  
  if (payload.type === 'text' && payload.text) {
    content = payload.text.body;
  } else if (payload.type === 'template' && payload.template) {
    content = `Template: ${payload.template.name}`;
  } else if (payload.type === 'interactive' && payload.interactive) {
    content = payload.interactive.body.text;
  }

  await prisma.messageLog.create({
    data: {
      phoneNumber: payload.to,
      direction: 'outgoing',
      messageType: payload.type,
      content,
      messageId,
      status: 'sent',
    },
  });
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export const markAsRead = async (messageId: string): Promise<void> => {
  try {
    await whatsappClient.post('/messages', {
      messaging_product: 'whatsapp',
      status: 'read',
      message_id: messageId,
    });
  } catch (error) {
    logger.error('Failed to mark message as read', { messageId, error });
  }
};