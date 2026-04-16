export * from './whatsapp.types';

export interface InitializePaymentParams {
  userId: string;
  planId: string;
  amount: number;
  email: string;
}

export interface InitializePaymentResult {
  reference: string;
  authorizationUrl: string;
  accessCode: string;
}

export interface PaystackWebhookEvent {
  event: string;
  data: {
    reference: string;
    amount: number;
    currency: string;
    status: string;
    paid_at: string;
    channel: string;
    customer: {
      email: string;
      phone: string;
    };
    metadata: {
      userId: string;
      planId: string;
    };
  };
}

export interface CreateUserParams {
  phoneNumber: string;
  name?: string;
  email?: string;
}

export interface SubscriptionStats {
  active: number;
  grace: number;
  expired: number;
  total: number;
}

export interface PaginationParams {
  page?: number;
  limit?: number;
}

export interface PaginationResult {
  page: number;
  limit: number;
  total: number;
  pages: number;
}