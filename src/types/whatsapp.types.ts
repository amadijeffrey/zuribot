export interface WhatsAppWebhookBody {
  object: string;
  entry: WebhookEntry[];
}

export interface WebhookEntry {
  id: string;
  changes: WebhookChange[];
}

export interface WebhookChange {
  value: WebhookValue;
  field: string;
}

export interface WebhookValue {
  messaging_product: string;
  metadata: WebhookMetadata;
  contacts?: WebhookContact[];
  messages?: IncomingMessage[];
  statuses?: MessageStatus[];
}

export interface WebhookMetadata {
  display_phone_number: string;
  phone_number_id: string;
}

export interface WebhookContact {
  profile: { name: string };
  wa_id: string;
}

export interface IncomingMessage {
  from: string;
  id: string;
  timestamp: string;
  type: 'text' | 'image' | 'document' | 'audio' | 'video' | 'location' | 'contacts' | 'interactive' | 'button';
  text?: { body: string };
  interactive?: {
    type: string;
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description: string };
  };
  button?: { text: string; payload: string };
  image?: { caption?: string; mime_type: string; id: string };
  document?: { caption?: string; mime_type: string; file_name: string; id: string };
  audio?: { mime_type: string; id: string };
  video?: { caption?: string; mime_type: string; id: string };
}

export interface MessageStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id: string;
  errors?: Array<{
    code: number;
    title: string;
  }>;
}

export interface SendMessagePayload {
  messaging_product: 'whatsapp';
  recipient_type: 'individual';
  to: string;
  type: 'text' | 'template' | 'interactive';
  text?: { body: string; preview_url?: boolean };
  template?: TemplateMessage;
  interactive?: InteractiveMessage;
}

export interface TemplateMessage {
  name: string;
  language: { code: string };
  components?: TemplateComponent[];
}

export interface TemplateComponent {
  type: 'header' | 'body' | 'button';
  parameters?: TemplateParameter[];
  sub_type?: string;
  index?: number;
}

export interface TemplateParameter {
  type: 'text' | 'currency' | 'date_time' | 'image' | 'document' | 'video';
  text?: string;
}

export interface InteractiveMessage {
  type: 'button' | 'list' | 'cta_url';
  header?: { type: string; text?: string };
  body: { text: string };
  footer?: { text: string };
  action: InteractiveAction;
}

export interface InteractiveAction {
  button?: string;
  buttons?: InteractiveButton[];
  sections?: InteractiveSection[];
  name?: string;
  parameters?: { display_text: string; url: string };
}

export interface InteractiveButton {
  type: 'reply';
  reply: { id: string; title: string };
}

export interface InteractiveSection {
  title: string;
  rows: { id: string; title: string; description?: string }[];
}