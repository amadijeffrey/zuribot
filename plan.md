# WhatsApp Subscription System - Backend Implementation Plan

## Table of Contents
1. [System Architecture](#1-system-architecture)
2. [Project Setup](#2-project-setup)
3. [Database Design](#3-database-design)
4. [WhatsApp Webhook Implementation](#4-whatsapp-webhook-implementation)
5. [Bot Logic (Message Router)](#5-bot-logic-message-router)
6. [Payment Flow](#6-payment-flow)
7. [Subscription Engine](#7-subscription-engine)
8. [Scheduled Jobs](#8-scheduled-jobs)
9. [Notification System](#9-notification-system)
10. [Admin Capabilities](#10-admin-capabilities-backend-apis)
11. [Security & Best Practices](#11-security--best-practices)
12. [Scalability Considerations](#12-scalability-considerations)
13. [Deployment Plan](#13-deployment-plan)

---

## 1. System Architecture

### High-Level Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│                              WHATSAPP SUBSCRIPTION SYSTEM                        │
└─────────────────────────────────────────────────────────────────────────────────┘

┌──────────┐     ┌─────────────────┐     ┌─────────────────────────────────────────┐
│          │     │   META CLOUD    │     │              BACKEND SERVER              │
│   USER   │────▶│   (WhatsApp)    │────▶│                                         │
│          │     │                 │     │  ┌─────────────┐    ┌────────────────┐  │
└──────────┘     └─────────────────┘     │  │  Express.js │    │  Message Queue │  │
      ▲                   ▲              │  │   Router    │───▶│    (BullMQ)    │  │
      │                   │              │  └─────────────┘    └────────────────┘  │
      │                   │              │         │                   │           │
      │                   │              │         ▼                   ▼           │
      │                   │              │  ┌─────────────┐    ┌────────────────┐  │
      │                   │              │  │  Services   │    │   Job Workers  │  │
      │                   │              │  │  - WhatsApp │    │  - Reminders   │  │
      │                   │              │  │  - Payment  │    │  - Expiry      │  │
      │                   │              │  │  - Subscr.  │    │  - Grace       │  │
      │                   │              │  └─────────────┘    └────────────────┘  │
      │                   │              │         │                   │           │
      │                   │              │         ▼                   ▼           │
      │                   │              │  ┌─────────────────────────────────┐    │
      │          Send Msg │              │  │        PostgreSQL + Prisma      │    │
      └───────────────────┘              │  │  ┌───────┐ ┌─────────────┐      │    │
                                         │  │  │ Users │ │Subscriptions│      │    │
                                         │  │  └───────┘ └─────────────┘      │    │
                                         │  │  ┌──────────┐ ┌────────┐        │    │
                                         │  │  │ Payments │ │ Groups │        │    │
                                         │  │  └──────────┘ └────────┘        │    │
                                         │  └─────────────────────────────────┘    │
                                         │                                         │
                                         └─────────────────────────────────────────┘
                                                          │
                                                          │ Payment Init
                                                          ▼
┌─────────────────────────────────────────────────────────────────────────────────┐
│                                   PAYSTACK                                       │
│                                                                                  │
│   ┌─────────────────┐         ┌─────────────────┐         ┌─────────────────┐   │
│   │ Transaction Init│────────▶│  Payment Page   │────────▶│ Webhook Event   │   │
│   └─────────────────┘         └─────────────────┘         └─────────────────┘   │
│                                                                    │            │
└────────────────────────────────────────────────────────────────────│────────────┘
                                                                     │
                                                                     │ POST /paystack/webhook
                                                                     ▼
                                                        ┌─────────────────────────┐
                                                        │   Backend Webhook       │
                                                        │   Handler               │
                                                        │   - Verify Signature    │
                                                        │   - Activate Sub        │
                                                        │   - Send Group Link     │
                                                        └─────────────────────────┘
```

### Data Flow Sequence

```
1. USER SENDS MESSAGE
   User ──▶ WhatsApp ──▶ Meta Cloud API ──▶ POST /webhook

2. BACKEND PROCESSES MESSAGE
   Webhook Handler ──▶ Message Parser ──▶ Intent Detector ──▶ Response Generator

3. UPGRADE FLOW (shows available plans)
   User sends "UPGRADE" ──▶ Bot responds with plan options ──▶ User selects plan

4. PAYMENT INITIALIZATION (after plan selection)
   Backend ──▶ Paystack API (initialize) ──▶ Return payment link ──▶ Send via WhatsApp

5. USER COMPLETES PAYMENT
   User ──▶ Paystack Payment Page ──▶ Payment Processed

6. PAYMENT CONFIRMATION
   Paystack ──▶ POST /paystack/webhook ──▶ Verify Signature ──▶ Update DB

7. SUBSCRIPTION ACTIVATION
   Backend ──▶ Create/Update Subscription ──▶ Set Expiry ──▶ Send Group Link via WhatsApp

8. SCHEDULED JOBS (Daily)
   Cron ──▶ Check Expirations ──▶ Send Reminders ──▶ Update Statuses
```

---

## 2. Project Setup

### Folder Structure

```
zuribot/
├── src/
│   ├── config/
│   │   ├── database.ts          # Prisma client initialization
│   │   ├── redis.ts             # Redis connection
│   │   ├── env.ts               # Environment variables validation
│   │   └── constants.ts         # App constants (plans, keywords, etc.)
│   │
│   ├── handlers/
│   │   ├── webhook.handler.ts        # WhatsApp webhook handlers
│   │   ├── paystack.handler.ts       # Paystack webhook handlers
│   │   └── admin.handler.ts          # Admin API handlers
│   │
│   ├── services/
│   │   ├── whatsapp.ts               # WhatsApp API interactions
│   │   ├── payment.ts                # Paystack API interactions
│   │   ├── subscription.ts           # Subscription logic
│   │   ├── user.ts                   # User management
│   │   └── message.ts                # Message parsing & routing
│   │
│   ├── jobs/
│   │   ├── queue.ts                  # BullMQ queue setup
│   │   ├── workers/
│   │   │   ├── message.worker.ts     # Process incoming messages
│   │   │   └── notification.worker.ts # Send notifications
│   │   └── cron/
│   │       ├── scheduler.ts          # Cron job scheduler
│   │       ├── expiry-reminder.ts
│   │       ├── grace-period.ts
│   │       └── subscription-expiry.ts
│   │
│   ├── routes/
│   │   ├── index.ts                  # Route aggregator
│   │   ├── webhook.routes.ts         # WhatsApp webhook routes
│   │   ├── paystack.routes.ts        # Paystack webhook routes
│   │   └── admin.routes.ts           # Admin API routes
│   │
│   ├── middleware/
│   │   ├── error.ts                  # Global error handler
│   │   ├── validate.ts               # Request validation
│   │   ├── paystack-signature.ts
│   │   ├── rate-limit.ts
│   │   └── auth.ts                   # Admin authentication
│   │
│   ├── utils/
│   │   ├── logger.ts                 # Winston logger setup
│   │   ├── crypto.ts                 # Signature verification helpers
│   │   └── date.ts                   # Date manipulation helpers
│   │
│   ├── types/
│   │   ├── whatsapp.types.ts         # WhatsApp API types
│   │   ├── paystack.types.ts         # Paystack API types
│   │   └── index.ts                  # Shared types
│   │
│   ├── app.ts                        # Express app setup
│   └── server.ts                     # Server entry point
│
├── prisma/
│   ├── schema.prisma                 # Database schema
│   ├── migrations/                   # Migration files
│   └── seed.ts                       # Seed data
│
├── tests/
│   ├── unit/
│   ├── integration/
│   └── fixtures/
│
├── .env.example
├── .env
├── package.json
├── tsconfig.json
├── docker-compose.yml
└── README.md
```

### Environment Variables

Create `.env.example`:

```bash
# Server
NODE_ENV=development
PORT=3000
API_BASE_URL=https://your-domain.com

# Database
DATABASE_URL="postgresql://user:password@localhost:5432/zuribot?schema=public"

# Redis
REDIS_URL="redis://localhost:6379"

# WhatsApp Cloud API
WHATSAPP_API_VERSION=v18.0
WHATSAPP_PHONE_NUMBER_ID=your_phone_number_id
WHATSAPP_BUSINESS_ACCOUNT_ID=your_business_account_id
WHATSAPP_ACCESS_TOKEN=your_access_token
WHATSAPP_VERIFY_TOKEN=your_custom_verify_token
WHATSAPP_APP_SECRET=your_app_secret

# Paystack
PAYSTACK_SECRET_KEY=sk_test_xxxxx
PAYSTACK_PUBLIC_KEY=pk_test_xxxxx

# Admin
ADMIN_API_KEY=your_secure_admin_api_key

# Subscription Plans (amounts in kobo)
WEALTH_PLAN_AMOUNT=500000
BOOST_PLAN_AMOUNT=1000000
PREMIUM_PLAN_AMOUNT=2500000
GRACE_PERIOD_DAYS=3

# Feature Flags (optional logging tables)
ENABLE_WEBHOOK_LOGGING=true
ENABLE_MESSAGE_LOGGING=true
```

### Required Dependencies

```json
{
  "name": "zuribot",
  "version": "1.0.0",
  "scripts": {
    "dev": "ts-node-dev --respawn src/server.ts",
    "build": "tsc",
    "start": "node dist/server.js",
    "worker": "node dist/worker.js",
    "db:migrate": "prisma migrate dev",
    "db:generate": "prisma generate",
    "db:seed": "ts-node prisma/seed.ts",
    "test": "jest",
    "lint": "eslint src --ext .ts"
  },
  "dependencies": {
    "@prisma/client": "^5.10.0",
    "axios": "^1.6.7",
    "bullmq": "^5.4.2",
    "cors": "^2.8.5",
    "dotenv": "^16.4.5",
    "express": "^4.18.3",
    "express-rate-limit": "^7.2.0",
    "helmet": "^7.1.0",
    "ioredis": "^5.3.2",
    "node-cron": "^3.0.3",
    "uuid": "^9.0.1",
    "winston": "^3.12.0",
    "zod": "^3.22.4"
  },
  "devDependencies": {
    "@types/cors": "^2.8.17",
    "@types/express": "^4.17.21",
    "@types/node": "^20.11.24",
    "@types/node-cron": "^3.0.11",
    "@types/uuid": "^9.0.8",
    "jest": "^29.7.0",
    "prisma": "^5.10.0",
    "ts-jest": "^29.1.2",
    "ts-node-dev": "^2.0.0",
    "typescript": "^5.4.2"
  }
}
```

### Initial Configuration Files

**src/config/env.ts**
```typescript
import { z } from 'zod';
import dotenv from 'dotenv';

dotenv.config();

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().transform(Number).default('3000'),
  API_BASE_URL: z.string().url(),
  
  DATABASE_URL: z.string(),
  REDIS_URL: z.string(),
  
  WHATSAPP_API_VERSION: z.string().default('v18.0'),
  WHATSAPP_PHONE_NUMBER_ID: z.string(),
  WHATSAPP_BUSINESS_ACCOUNT_ID: z.string(),
  WHATSAPP_ACCESS_TOKEN: z.string(),
  WHATSAPP_VERIFY_TOKEN: z.string(),
  WHATSAPP_APP_SECRET: z.string(),
  
  PAYSTACK_SECRET_KEY: z.string(),
  PAYSTACK_PUBLIC_KEY: z.string(),
  
  ADMIN_API_KEY: z.string(),
  
  WEALTH_PLAN_AMOUNT: z.string().transform(Number).default('500000'),
  BOOST_PLAN_AMOUNT: z.string().transform(Number).default('1000000'),
  PREMIUM_PLAN_AMOUNT: z.string().transform(Number).default('2500000'),
  GRACE_PERIOD_DAYS: z.string().transform(Number).default('3'),
  
  // Feature flags for optional logging
  ENABLE_WEBHOOK_LOGGING: z.string().transform(v => v === 'true').default('true'),
  ENABLE_MESSAGE_LOGGING: z.string().transform(v => v === 'true').default('true'),
});

export const env = envSchema.parse(process.env);
```

**src/config/constants.ts**
```typescript
import { env } from './env';

export const SUBSCRIPTION_PLANS = {
  wealth: {
    id: 'wealth',
    name: 'Wealth Plan',
    keywords: ['JOIN WEALTH', 'WEALTH'],
    amount: env.WEALTH_PLAN_AMOUNT, // Amount in kobo (NGN)
    durationDays: 30,
    description: 'Access to Wealth building tips and exclusive group',
  },
  boost: {
    id: 'boost',
    name: 'Boost Plan',
    keywords: ['JOIN BOOST', 'BOOST'],
    amount: env.BOOST_PLAN_AMOUNT,
    durationDays: 30,
    description: 'Access to Boost strategies and premium group',
  },
  premium: {
    id: 'premium',
    name: 'Premium Plan',
    keywords: ['PREMIUM'],
    amount: env.PREMIUM_PLAN_AMOUNT,
    durationDays: 30,
    description: 'Full access to all features and VIP group',
  },
} as const;

// UPGRADE keyword is handled separately - shows all plans
export const UPGRADE_KEYWORDS = ['UPGRADE', 'PLANS', 'OPTIONS'];

export const SUBSCRIPTION_STATUS = {
  ACTIVE: 'ACTIVE',
  GRACE: 'GRACE',
  EXPIRED: 'EXPIRED',
  CANCELLED: 'CANCELLED',
} as const;

export const PAYMENT_STATUS = {
  PENDING: 'PENDING',
  SUCCESS: 'SUCCESS',
  FAILED: 'FAILED',
} as const;

export const GRACE_PERIOD_DAYS = env.GRACE_PERIOD_DAYS;
```

**src/config/database.ts**
```typescript
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient({
  log: process.env.NODE_ENV === 'development' ? ['query', 'error', 'warn'] : ['error'],
});
```

---

## 3. Database Design

### Prisma Schema

**prisma/schema.prisma**
```prisma
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model User {
  id            String         @id @default(uuid())
  phoneNumber   String         @unique @map("phone_number")
  name          String?
  email         String?
  createdAt     DateTime       @default(now()) @map("created_at")
  updatedAt     DateTime       @updatedAt @map("updated_at")
  
  subscriptions Subscription[]
  payments      Payment[]
  
  @@index([phoneNumber])
  @@map("users")
}

model Subscription {
  id            String             @id @default(uuid())
  userId        String             @map("user_id")
  planId        String             @map("plan_id")
  status        SubscriptionStatus @default(ACTIVE)
  startDate     DateTime           @map("start_date")
  expiryDate    DateTime           @map("expiry_date")
  graceEndDate  DateTime?          @map("grace_end_date")
  groupInviteId String?            @map("group_invite_id")
  createdAt     DateTime           @default(now()) @map("created_at")
  updatedAt     DateTime           @updatedAt @map("updated_at")
  
  user          User               @relation(fields: [userId], references: [id])
  payment       Payment?
  group         Group?             @relation(fields: [groupInviteId], references: [id])
  
  @@index([userId])
  @@index([status])
  @@index([expiryDate])
  @@index([graceEndDate])
  @@map("subscriptions")
}

model Payment {
  id              String        @id @default(uuid())
  userId          String        @map("user_id")
  subscriptionId  String?       @unique @map("subscription_id")
  reference       String        @unique // Paystack reference
  amount          Int           // Amount in kobo
  currency        String        @default("NGN")
  status          PaymentStatus @default(PENDING)
  planId          String        @map("plan_id")
  paystackData    Json?         @map("paystack_data") // Store raw webhook data
  paidAt          DateTime?     @map("paid_at")
  createdAt       DateTime      @default(now()) @map("created_at")
  updatedAt       DateTime      @updatedAt @map("updated_at")
  
  user            User          @relation(fields: [userId], references: [id])
  subscription    Subscription? @relation(fields: [subscriptionId], references: [id])
  
  @@index([userId])
  @@index([reference])
  @@index([status])
  @@map("payments")
}

model Group {
  id            String         @id @default(uuid())
  planId        String         @unique @map("plan_id")
  name          String
  inviteLink    String         @map("invite_link")
  isActive      Boolean        @default(true) @map("is_active")
  createdAt     DateTime       @default(now()) @map("created_at")
  updatedAt     DateTime       @updatedAt @map("updated_at")
  
  subscriptions Subscription[]
  
  @@index([planId])
  @@map("groups")
}

// ============================================================================
// OPTIONAL LOGGING TABLES
// These tables are useful for debugging, audit trails, and analytics.
// You can disable them via ENABLE_WEBHOOK_LOGGING and ENABLE_MESSAGE_LOGGING env vars.
// 
// WebhookLog: Stores raw webhook payloads from WhatsApp and Paystack
//   - Debugging failed webhook processing
//   - Idempotency checks (detect duplicate events)
//   - Audit trail for payment disputes
//   - Replay failed events during recovery
//
// MessageLog: Stores conversation history
//   - Track message delivery status (sent, delivered, read)
//   - Customer support (view past conversations)
//   - Analytics on user engagement and bot performance
//   - Debug message flow issues
// ============================================================================

model WebhookLog {
  id          String   @id @default(uuid())
  source      String   // 'whatsapp' | 'paystack'
  eventType   String   @map("event_type")
  payload     Json
  processed   Boolean  @default(false)
  error       String?
  createdAt   DateTime @default(now()) @map("created_at")
  
  @@index([source, createdAt])
  @@index([processed])
  @@map("webhook_logs")
}

model MessageLog {
  id          String   @id @default(uuid())
  phoneNumber String   @map("phone_number")
  direction   String   // 'incoming' | 'outgoing'
  messageType String   @map("message_type")
  content     String
  messageId   String?  @map("message_id") // WhatsApp message ID
  status      String?  // For outgoing: sent, delivered, read
  createdAt   DateTime @default(now()) @map("created_at")
  
  @@index([phoneNumber, createdAt])
  @@map("message_logs")
}

enum SubscriptionStatus {
  ACTIVE
  GRACE
  EXPIRED
  CANCELLED
}

enum PaymentStatus {
  PENDING
  SUCCESS
  FAILED
}
```

### Database Relationships Diagram

```
┌─────────────┐       ┌──────────────────┐       ┌──────────────┐
│    users    │       │  subscriptions   │       │    groups    │
├─────────────┤       ├──────────────────┤       ├──────────────┤
│ id (PK)     │──┐    │ id (PK)          │    ┌──│ id (PK)      │
│ phone_number│  │    │ user_id (FK)     │────┘  │ plan_id      │
│ name        │  └───▶│ plan_id          │       │ name         │
│ email       │       │ status           │       │ invite_link  │
│ created_at  │       │ start_date       │       │ is_active    │
│ updated_at  │       │ expiry_date      │       └──────────────┘
└─────────────┘       │ grace_end_date   │
      │               │ group_invite_id  │───────────────────────┘
      │               │ created_at       │
      │               │ updated_at       │
      │               └──────────────────┘
      │                        │
      │                        │ 1:1
      │                        ▼
      │               ┌──────────────────┐
      │               │    payments      │
      │               ├──────────────────┤
      └──────────────▶│ id (PK)          │
                      │ user_id (FK)     │
                      │ subscription_id  │
                      │ reference        │
                      │ amount           │
                      │ currency         │
                      │ status           │
                      │ plan_id          │
                      │ paystack_data    │
                      │ paid_at          │
                      │ created_at       │
                      │ updated_at       │
                      └──────────────────┘
```

### Key Indexes

| Table | Index | Purpose |
|-------|-------|---------|
| users | phone_number | Fast lookup by phone |
| subscriptions | user_id | Get user's subscriptions |
| subscriptions | status | Filter by status |
| subscriptions | expiry_date | Cron job queries |
| subscriptions | grace_end_date | Grace period checks |
| payments | reference | Webhook lookup (idempotency) |
| payments | user_id | User payment history |

---

## 4. WhatsApp Webhook Implementation

### Webhook Routes

**src/routes/webhook.routes.ts**
```typescript
import { Router } from 'express';
import { verifyWebhook, handleWebhook } from '../handlers/webhook.handler';

const router = Router();

// Webhook verification (GET) - Meta verifies this endpoint
router.get('/webhook', verifyWebhook);

// Webhook handler (POST) - Receives messages and events
router.post('/webhook', handleWebhook);

export default router;
```

### Webhook Handler (Functional)

**src/handlers/webhook.handler.ts**
```typescript
import { Request, Response } from 'express';
import crypto from 'crypto';
import { env } from '../config/env';
import { prisma } from '../config/database';
import { messageQueue } from '../jobs/queue';
import { logger } from '../utils/logger';
import { updateMessageStatus } from '../services/message';

/**
 * GET /webhook - Verification endpoint for Meta
 * Meta sends a GET request with hub.mode, hub.verify_token, and hub.challenge
 */
export const verifyWebhook = (req: Request, res: Response): void => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];

  logger.info('Webhook verification attempt', { mode, tokenReceived: !!token });

  if (mode === 'subscribe' && token === env.WHATSAPP_VERIFY_TOKEN) {
    logger.info('Webhook verified successfully');
    res.status(200).send(challenge);
    return;
  }

  logger.warn('Webhook verification failed');
  res.status(403).send('Forbidden');
};

/**
 * POST /webhook - Handles incoming messages and status updates
 */
export const handleWebhook = async (req: Request, res: Response): Promise<void> => {
  // IMPORTANT: Always respond with 200 quickly to prevent webhook retries
  res.status(200).send('EVENT_RECEIVED');

  try {
    // Verify request signature
    if (!verifySignature(req)) {
      logger.error('Invalid webhook signature');
      return;
    }

    const body = req.body;

    // Log webhook if enabled
    if (env.ENABLE_WEBHOOK_LOGGING) {
      await prisma.webhookLog.create({
        data: {
          source: 'whatsapp',
          eventType: body.entry?.[0]?.changes?.[0]?.field || 'unknown',
          payload: body,
          processed: false,
        },
      });
    }

    // Check if this is a WhatsApp message webhook
    if (body.object !== 'whatsapp_business_account') {
      logger.warn('Unknown webhook object type', { object: body.object });
      return;
    }

    // Process entries
    for (const entry of body.entry || []) {
      for (const change of entry.changes || []) {
        if (change.field !== 'messages') continue;

        const value = change.value;
        const contacts = value.contacts || [];
        const messages = value.messages || [];
        const statuses = value.statuses || [];

        // Process incoming messages - queue for async processing
        for (const message of messages) {
          const contact = contacts.find((c: any) => c.wa_id === message.from);
          
          await messageQueue.add('process-message', {
            message,
            contact,
            timestamp: new Date().toISOString(),
          }, {
            attempts: 3,
            backoff: { type: 'exponential', delay: 1000 },
          });

          logger.info('Message queued for processing', {
            messageId: message.id,
            from: message.from,
            type: message.type,
          });
        }

        // Process status updates (sent, delivered, read)
        for (const status of statuses) {
          await updateMessageStatus(status.id, status.status);
        }
      }
    }
  } catch (error) {
    logger.error('Error processing webhook', { error });
  }
};

/**
 * Verify webhook request signature using app secret
 */
const verifySignature = (req: Request): boolean => {
  const signature = req.headers['x-hub-signature-256'] as string;
  
  if (!signature) {
    return false;
  }

  const expectedSignature = crypto
    .createHmac('sha256', env.WHATSAPP_APP_SECRET)
    .update(JSON.stringify(req.body))
    .digest('hex');

  const expectedHeader = `sha256=${expectedSignature}`;
  
  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedHeader)
    );
  } catch {
    return false;
  }
};
```

### WhatsApp Types

**src/types/whatsapp.types.ts**
```typescript
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
  from: string;  // This is the phone number (e.g., "2348012345678")
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
}

export interface MessageStatus {
  id: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  timestamp: string;
  recipient_id: string;
  errors?: any[];
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
  type: 'button' | 'list';
  header?: { type: string; text?: string };
  body: { text: string };
  footer?: { text: string };
  action: InteractiveAction;
}

export interface InteractiveAction {
  button?: string;
  buttons?: InteractiveButton[];
  sections?: InteractiveSection[];
}

export interface InteractiveButton {
  type: 'reply';
  reply: { id: string; title: string };
}

export interface InteractiveSection {
  title: string;
  rows: { id: string; title: string; description?: string }[];
}
```

---

## 5. Bot Logic (Message Router)

### Message Service (Functional)

**src/services/message.ts**
```typescript
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

/**
 * Main message processing entry point
 */
export const processMessage = async (context: MessageContext): Promise<void> => {
  const { message, contact } = context;
  const phoneNumber = message.from;
  const profileName = contact?.profile?.name || 'User';

  try {
    // Log incoming message if enabled
    if (env.ENABLE_MESSAGE_LOGGING) {
      await logMessage(phoneNumber, 'incoming', message);
    }

    // Get or create user
    const user = await getOrCreateUser({
      phoneNumber,
      name: profileName,
    });

    // Route message based on type
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

/**
 * Handle text messages and route based on intent
 */
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

/**
 * Detect if message matches a subscription plan keyword
 */
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

/**
 * Send available plans - triggered by UPGRADE keyword
 */
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

/**
 * Handle subscription request - send plan details and payment link
 */
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

/**
 * Handle status check request
 */
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

/**
 * Handle renewal request
 */
const handleRenewalRequest = async (user: any): Promise<void> => {
  const subscription = await getUserLatestSubscription(user.id);
  
  if (subscription) {
    await handleSubscriptionRequest(user, subscription.planId);
  } else {
    await sendAvailablePlans(user.phoneNumber);
  }
};

/**
 * Send welcome message with interactive buttons
 */
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

/**
 * Send help menu
 */
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

/**
 * Handle interactive message responses (button/list clicks)
 */
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

/**
 * Handle button message responses
 */
const handleButtonMessage = async (user: any, message: IncomingMessage): Promise<void> => {
  const payload = message.button?.payload;
  
  if (payload?.startsWith('plan_')) {
    const planId = payload.replace('plan_', '');
    await handleSubscriptionRequest(user, planId);
  }
};

/**
 * Handle unsupported message types
 */
const handleUnsupportedMessage = async (phoneNumber: string): Promise<void> => {
  await sendTextMessage(
    phoneNumber,
    'Sorry, I can only process text messages. Please send a text message or reply with *HELP*.'
  );
};

/**
 * Log message to database
 */
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

/**
 * Update message status in database
 */
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
```

### Message Worker

**src/jobs/workers/message.worker.ts**
```typescript
import { Worker, Job } from 'bullmq';
import { processMessage } from '../../services/message';
import { redisConnection } from '../../config/redis';
import { logger } from '../../utils/logger';

export const messageWorker = new Worker(
  'messages',
  async (job: Job) => {
    const { message, contact } = job.data;
    
    logger.info('Processing message job', {
      jobId: job.id,
      messageId: message.id,
      from: message.from,
    });

    await processMessage({ message, contact });

    return { processed: true, messageId: message.id };
  },
  {
    connection: redisConnection,
    concurrency: 10,
  }
);

messageWorker.on('completed', (job) => {
  logger.debug('Message job completed', { jobId: job.id });
});

messageWorker.on('failed', (job, error) => {
  logger.error('Message job failed', {
    jobId: job?.id,
    error: error.message,
  });
});
```

---

## 6. Payment Flow

### Payment Service (Functional)

**src/services/payment.ts**
```typescript
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';
import { prisma } from '../config/database';
import { env } from '../config/env';
import { SUBSCRIPTION_PLANS, GRACE_PERIOD_DAYS } from '../config/constants';
import { sendActivationConfirmation } from './subscription';
import { logger } from '../utils/logger';

const paystackClient = axios.create({
  baseURL: 'https://api.paystack.co',
  headers: {
    Authorization: `Bearer ${env.PAYSTACK_SECRET_KEY}`,
    'Content-Type': 'application/json',
  },
});

interface InitializePaymentParams {
  userId: string;
  planId: string;
  amount: number;
  email: string;
}

interface InitializePaymentResult {
  reference: string;
  authorizationUrl: string;
  accessCode: string;
}

/**
 * Initialize a Paystack transaction
 */
export const initializePayment = async (
  params: InitializePaymentParams
): Promise<InitializePaymentResult> => {
  const { userId, planId, amount, email } = params;
  
  // Generate unique reference
  const reference = `SUB_${planId.toUpperCase()}_${uuidv4().slice(0, 8)}`;
  
  try {
    // Create pending payment record
    await prisma.payment.create({
      data: {
        userId,
        reference,
        amount,
        planId,
        status: 'PENDING',
      },
    });

    // Initialize Paystack transaction
    const response = await paystackClient.post('/transaction/initialize', {
      email,
      amount, // Amount in kobo
      reference,
      callback_url: `${env.API_BASE_URL}/payment/callback`,
      metadata: {
        userId,
        planId,
        custom_fields: [
          {
            display_name: 'Plan',
            variable_name: 'plan',
            value: planId,
          },
        ],
      },
    });

    logger.info('Payment initialized', { reference, userId, planId, amount });

    return {
      reference,
      authorizationUrl: response.data.data.authorization_url,
      accessCode: response.data.data.access_code,
    };
  } catch (error: any) {
    logger.error('Failed to initialize payment', {
      error: error.response?.data || error.message,
      userId,
      planId,
    });
    throw new Error('Failed to initialize payment');
  }
};

/**
 * Verify payment status directly with Paystack
 */
export const verifyPayment = async (reference: string): Promise<boolean> => {
  try {
    const response = await paystackClient.get(`/transaction/verify/${reference}`);
    const data = response.data.data;

    if (data.status === 'success') {
      await handleSuccessfulPayment(reference, data);
      return true;
    }

    return false;
  } catch (error: any) {
    logger.error('Payment verification failed', {
      reference,
      error: error.response?.data || error.message,
    });
    return false;
  }
};

/**
 * Process Paystack webhook event
 */
export const processWebhookEvent = async (event: any): Promise<void> => {
  const { reference, status } = event.data;

  logger.info('Processing Paystack webhook', {
    event: event.event,
    reference,
    status,
  });

  // Check for idempotency - payment already processed
  const existingPayment = await prisma.payment.findUnique({
    where: { reference },
  });

  if (!existingPayment) {
    logger.warn('Payment not found for webhook', { reference });
    return;
  }

  if (existingPayment.status === 'SUCCESS') {
    logger.info('Payment already processed, skipping', { reference });
    return;
  }

  switch (event.event) {
    case 'charge.success':
      await handleSuccessfulPayment(reference, event.data);
      break;

    case 'charge.failed':
      await handleFailedPayment(reference);
      break;

    default:
      logger.info('Unhandled Paystack event', { event: event.event });
  }
};

/**
 * Handle successful payment - update payment and activate subscription
 */
const handleSuccessfulPayment = async (reference: string, data: any): Promise<void> => {
  const payment = await prisma.payment.findUnique({
    where: { reference },
    include: { user: true },
  });

  if (!payment) {
    logger.error('Payment not found', { reference });
    return;
  }

  // Use transaction to ensure atomicity
  await prisma.$transaction(async (tx) => {
    // Update payment status
    await tx.payment.update({
      where: { reference },
      data: {
        status: 'SUCCESS',
        paidAt: new Date(data.paid_at || Date.now()),
        paystackData: data,
      },
    });

    // Get plan details
    const plan = SUBSCRIPTION_PLANS[payment.planId as keyof typeof SUBSCRIPTION_PLANS];
    if (!plan) {
      throw new Error(`Plan not found: ${payment.planId}`);
    }

    // Calculate subscription dates
    const startDate = new Date();
    const expiryDate = new Date();
    expiryDate.setDate(expiryDate.getDate() + plan.durationDays);

    const graceEndDate = new Date(expiryDate);
    graceEndDate.setDate(graceEndDate.getDate() + GRACE_PERIOD_DAYS);

    // Get group for this plan
    const group = await tx.group.findUnique({
      where: { planId: payment.planId },
    });

    // Create subscription
    const subscription = await tx.subscription.create({
      data: {
        userId: payment.userId,
        planId: payment.planId,
        status: 'ACTIVE',
        startDate,
        expiryDate,
        graceEndDate,
        groupInviteId: group?.id,
      },
    });

    // Link payment to subscription
    await tx.payment.update({
      where: { reference },
      data: { subscriptionId: subscription.id },
    });

    logger.info('Subscription activated', {
      subscriptionId: subscription.id,
      userId: payment.userId,
      planId: payment.planId,
      expiryDate,
    });
  });

  // Send confirmation message (outside transaction)
  await sendActivationConfirmation(payment.userId, payment.planId);
};

/**
 * Handle failed payment
 */
const handleFailedPayment = async (reference: string): Promise<void> => {
  await prisma.payment.update({
    where: { reference },
    data: { status: 'FAILED' },
  });

  logger.info('Payment marked as failed', { reference });
};

/**
 * Get payment by reference
 */
export const getPaymentByReference = async (reference: string) => {
  return prisma.payment.findUnique({
    where: { reference },
    include: {
      user: true,
      subscription: true,
    },
  });
};

/**
 * Get user payment history
 */
export const getUserPayments = async (userId: string) => {
  return prisma.payment.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
};
```

### Paystack Webhook Handler

**src/handlers/paystack.handler.ts**
```typescript
import { Request, Response } from 'express';
import crypto from 'crypto';
import { env } from '../config/env';
import { prisma } from '../config/database';
import { processWebhookEvent, verifyPayment } from '../services/payment';
import { logger } from '../utils/logger';

/**
 * POST /paystack/webhook - Handle Paystack webhook events
 */
export const handlePaystackWebhook = async (req: Request, res: Response): Promise<void> => {
  const signature = req.headers['x-paystack-signature'] as string;
  
  if (!verifySignature(req.body, signature)) {
    logger.error('Invalid Paystack webhook signature');
    res.status(401).json({ error: 'Invalid signature' });
    return;
  }

  // Respond quickly to acknowledge receipt
  res.status(200).send('OK');

  try {
    // Log webhook if enabled
    if (env.ENABLE_WEBHOOK_LOGGING) {
      await prisma.webhookLog.create({
        data: {
          source: 'paystack',
          eventType: req.body.event,
          payload: req.body,
          processed: false,
        },
      });
    }

    // Process the webhook event
    await processWebhookEvent(req.body);

    // Mark as processed
    if (env.ENABLE_WEBHOOK_LOGGING) {
      await prisma.webhookLog.updateMany({
        where: {
          source: 'paystack',
          payload: { equals: req.body },
        },
        data: { processed: true },
      });
    }
  } catch (error: any) {
    logger.error('Error processing Paystack webhook', {
      error: error.message,
      event: req.body.event,
    });

    if (env.ENABLE_WEBHOOK_LOGGING) {
      await prisma.webhookLog.updateMany({
        where: {
          source: 'paystack',
          payload: { equals: req.body },
        },
        data: { error: error.message },
      });
    }
  }
};

/**
 * GET /payment/verify/:reference - Manual payment verification
 */
export const handleVerifyPayment = async (req: Request, res: Response): Promise<void> => {
  const { reference } = req.params;

  try {
    const isValid = await verifyPayment(reference);

    if (isValid) {
      res.json({ success: true, message: 'Payment verified and subscription activated' });
    } else {
      res.json({ success: false, message: 'Payment not successful' });
    }
  } catch (error) {
    logger.error('Payment verification error', { reference, error });
    res.status(500).json({ error: 'Verification failed' });
  }
};

/**
 * Verify Paystack webhook signature
 */
const verifySignature = (body: any, signature: string): boolean => {
  if (!signature) return false;

  const hash = crypto
    .createHmac('sha512', env.PAYSTACK_SECRET_KEY)
    .update(JSON.stringify(body))
    .digest('hex');

  return hash === signature;
};
```

---

## 7. Subscription Engine

### Subscription Service (Functional)

**src/services/subscription.ts**
```typescript
import { prisma } from '../config/database';
import { SUBSCRIPTION_PLANS, GRACE_PERIOD_DAYS } from '../config/constants';
import { sendTextMessage } from './whatsapp';
import { logger } from '../utils/logger';

/**
 * Get user's active subscription
 */
export const getActiveSubscription = async (userId: string) => {
  return prisma.subscription.findFirst({
    where: {
      userId,
      status: { in: ['ACTIVE', 'GRACE'] },
    },
    orderBy: { createdAt: 'desc' },
    include: { group: true },
  });
};

/**
 * Get user's latest subscription (regardless of status)
 */
export const getUserLatestSubscription = async (userId: string) => {
  return prisma.subscription.findFirst({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
};

/**
 * Transition subscription to grace period
 */
export const moveToGracePeriod = async (subscriptionId: string): Promise<void> => {
  const subscription = await prisma.subscription.update({
    where: { id: subscriptionId },
    data: {
      status: 'GRACE',
      graceEndDate: new Date(Date.now() + GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000),
    },
    include: { user: true },
  });

  logger.info('Subscription moved to grace period', {
    subscriptionId,
    userId: subscription.userId,
  });

  await sendGracePeriodNotification(subscription.user.phoneNumber, subscription.planId);
};

/**
 * Mark subscription as expired
 */
export const expireSubscription = async (subscriptionId: string): Promise<void> => {
  const subscription = await prisma.subscription.update({
    where: { id: subscriptionId },
    data: { status: 'EXPIRED' },
    include: { user: true },
  });

  logger.info('Subscription expired', {
    subscriptionId,
    userId: subscription.userId,
  });

  await sendExpiryNotification(subscription.user.phoneNumber, subscription.planId);
};

/**
 * Get subscriptions expiring within N days
 */
export const getSubscriptionsExpiringWithin = async (days: number) => {
  const targetDate = new Date();
  targetDate.setDate(targetDate.getDate() + days);
  targetDate.setHours(23, 59, 59, 999);

  const startOfDay = new Date();
  startOfDay.setDate(startOfDay.getDate() + days);
  startOfDay.setHours(0, 0, 0, 0);

  return prisma.subscription.findMany({
    where: {
      status: 'ACTIVE',
      expiryDate: {
        gte: startOfDay,
        lte: targetDate,
      },
    },
    include: { user: true },
  });
};

/**
 * Get subscriptions that should move to grace period
 */
export const getExpiredSubscriptions = async () => {
  return prisma.subscription.findMany({
    where: {
      status: 'ACTIVE',
      expiryDate: { lte: new Date() },
    },
    include: { user: true },
  });
};

/**
 * Get subscriptions in grace period that have fully expired
 */
export const getGracePeriodExpired = async () => {
  return prisma.subscription.findMany({
    where: {
      status: 'GRACE',
      graceEndDate: { lte: new Date() },
    },
    include: { user: true },
  });
};

/**
 * Send activation confirmation with group link
 */
export const sendActivationConfirmation = async (
  userId: string,
  planId: string
): Promise<void> => {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) {
    logger.error('User not found for activation confirmation', { userId });
    return;
  }

  const plan = SUBSCRIPTION_PLANS[planId as keyof typeof SUBSCRIPTION_PLANS];
  const group = await prisma.group.findUnique({ where: { planId } });
  const subscription = await getActiveSubscription(userId);
  const expiryDate = subscription?.expiryDate.toLocaleDateString() || 'N/A';

  let message = `🎉 *Payment Successful!*\n\n` +
    `Your *${plan?.name}* subscription is now active!\n\n` +
    `📅 *Expires:* ${expiryDate}\n`;

  if (group?.inviteLink) {
    message += `\n🔗 *Join the group:*\n${group.inviteLink}\n\n` +
      `_This link is exclusive to subscribers. Do not share._`;
  }

  message += `\n\nReply *STATUS* anytime to check your subscription.`;

  await sendTextMessage(user.phoneNumber, message);
  logger.info('Activation confirmation sent', { userId, planId });
};

/**
 * Send grace period notification
 */
const sendGracePeriodNotification = async (
  phoneNumber: string,
  planId: string
): Promise<void> => {
  const plan = SUBSCRIPTION_PLANS[planId as keyof typeof SUBSCRIPTION_PLANS];

  const message = `⚠️ *Subscription Expired*\n\n` +
    `Your *${plan?.name}* subscription has expired.\n\n` +
    `You have a ${GRACE_PERIOD_DAYS}-day grace period to renew and maintain your access.\n\n` +
    `Reply *RENEW* to renew now.`;

  await sendTextMessage(phoneNumber, message);
};

/**
 * Send expiry notification (after grace period)
 */
const sendExpiryNotification = async (
  phoneNumber: string,
  planId: string
): Promise<void> => {
  const plan = SUBSCRIPTION_PLANS[planId as keyof typeof SUBSCRIPTION_PLANS];

  const message = `❌ *Access Revoked*\n\n` +
    `Your *${plan?.name}* subscription and grace period have ended.\n\n` +
    `You no longer have access to the exclusive group.\n\n` +
    `Reply *UPGRADE* to resubscribe anytime.`;

  await sendTextMessage(phoneNumber, message);
};

/**
 * Send expiry reminder
 */
export const sendExpiryReminder = async (
  phoneNumber: string,
  planId: string,
  daysRemaining: number
): Promise<void> => {
  const plan = SUBSCRIPTION_PLANS[planId as keyof typeof SUBSCRIPTION_PLANS];
  const emoji = daysRemaining === 1 ? '🚨' : daysRemaining <= 3 ? '⚠️' : '📢';

  const message = `${emoji} *Subscription Expiring Soon*\n\n` +
    `Your *${plan?.name}* subscription expires in ${daysRemaining} day${daysRemaining > 1 ? 's' : ''}.\n\n` +
    `Renew now to keep your access!\n\n` +
    `Reply *RENEW* to renew.`;

  await sendTextMessage(phoneNumber, message);
  logger.info('Expiry reminder sent', { phoneNumber, planId, daysRemaining });
};

/**
 * Get subscription statistics
 */
export const getSubscriptionStats = async () => {
  const [active, grace, expired, total] = await Promise.all([
    prisma.subscription.count({ where: { status: 'ACTIVE' } }),
    prisma.subscription.count({ where: { status: 'GRACE' } }),
    prisma.subscription.count({ where: { status: 'EXPIRED' } }),
    prisma.subscription.count(),
  ]);

  return { active, grace, expired, total };
};
```

### Subscription Status Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│                     SUBSCRIPTION STATUS TRANSITIONS                       │
└──────────────────────────────────────────────────────────────────────────┘

                            Payment Success
                                  │
                                  ▼
                          ┌──────────────┐
                          │    ACTIVE    │
                          │              │
                          │ - Full access│
                          │ - Group link │
                          └──────┬───────┘
                                 │
                   ┌─────────────┼─────────────┐
                   │             │             │
              [7 days]      [3 days]      [1 day]
              before        before        before
                   │             │             │
                   ▼             ▼             ▼
              Send           Send          Send
              Reminder       Reminder      Reminder
                                 │
                                 │ Expiry Date Reached
                                 ▼
                          ┌──────────────┐
                          │    GRACE     │
                          │              │
                          │ - 3 days to  │
                          │   renew      │
                          └──────┬───────┘
                                 │
                                 │ Grace Period Ends
                                 ▼
                          ┌──────────────┐
                          │   EXPIRED    │
                          │              │
                          │ - No access  │
                          └──────────────┘
                                 │
                                 │ User Resubscribes
                                 ▼
                          ┌──────────────┐
                          │    ACTIVE    │
                          │  (New Sub)   │
                          └──────────────┘
```

---

## 8. Scheduled Jobs

### Cron Scheduler

**src/jobs/cron/scheduler.ts**
```typescript
import cron from 'node-cron';
import { runExpiryReminderJob } from './expiry-reminder';
import { runGracePeriodJob } from './grace-period';
import { runSubscriptionExpiryJob } from './subscription-expiry';
import { logger } from '../../utils/logger';

export const initializeScheduler = (): void => {
  logger.info('Initializing cron scheduler');

  // Run expiry reminders every day at 9:00 AM
  cron.schedule('0 9 * * *', async () => {
    logger.info('Running expiry reminder job');
    try {
      await runExpiryReminderJob();
    } catch (error) {
      logger.error('Expiry reminder job failed', { error });
    }
  });

  // Run grace period transitions every day at 12:00 AM
  cron.schedule('0 0 * * *', async () => {
    logger.info('Running grace period job');
    try {
      await runGracePeriodJob();
    } catch (error) {
      logger.error('Grace period job failed', { error });
    }
  });

  // Run subscription expiry check every day at 12:05 AM
  cron.schedule('5 0 * * *', async () => {
    logger.info('Running subscription expiry job');
    try {
      await runSubscriptionExpiryJob();
    } catch (error) {
      logger.error('Subscription expiry job failed', { error });
    }
  });

  logger.info('Cron scheduler initialized');
};
```

**src/jobs/cron/expiry-reminder.ts**
```typescript
import {
  getSubscriptionsExpiringWithin,
  sendExpiryReminder,
} from '../../services/subscription';
import { logger } from '../../utils/logger';

export const runExpiryReminderJob = async (): Promise<void> => {
  const reminderDays = [7, 3, 1];

  for (const days of reminderDays) {
    try {
      const subscriptions = await getSubscriptionsExpiringWithin(days);
      logger.info(`Found ${subscriptions.length} subscriptions expiring in ${days} days`);

      for (const subscription of subscriptions) {
        try {
          await sendExpiryReminder(
            subscription.user.phoneNumber,
            subscription.planId,
            days
          );
          await delay(500); // Rate limiting
        } catch (error) {
          logger.error('Failed to send expiry reminder', {
            subscriptionId: subscription.id,
            error,
          });
        }
      }
    } catch (error) {
      logger.error(`Failed to process ${days}-day reminders`, { error });
    }
  }
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
```

**src/jobs/cron/grace-period.ts**
```typescript
import { getExpiredSubscriptions, moveToGracePeriod } from '../../services/subscription';
import { logger } from '../../utils/logger';

export const runGracePeriodJob = async (): Promise<void> => {
  try {
    const expiredSubscriptions = await getExpiredSubscriptions();
    logger.info(`Found ${expiredSubscriptions.length} subscriptions to move to grace period`);

    for (const subscription of expiredSubscriptions) {
      try {
        await moveToGracePeriod(subscription.id);
        await delay(500);
      } catch (error) {
        logger.error('Failed to move subscription to grace period', {
          subscriptionId: subscription.id,
          error,
        });
      }
    }
  } catch (error) {
    logger.error('Grace period job error', { error });
  }
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
```

**src/jobs/cron/subscription-expiry.ts**
```typescript
import { getGracePeriodExpired, expireSubscription } from '../../services/subscription';
import { logger } from '../../utils/logger';

export const runSubscriptionExpiryJob = async (): Promise<void> => {
  try {
    const expiredGraceSubscriptions = await getGracePeriodExpired();
    logger.info(`Found ${expiredGraceSubscriptions.length} subscriptions to mark as expired`);

    for (const subscription of expiredGraceSubscriptions) {
      try {
        await expireSubscription(subscription.id);
        await delay(500);
      } catch (error) {
        logger.error('Failed to expire subscription', {
          subscriptionId: subscription.id,
          error,
        });
      }
    }
  } catch (error) {
    logger.error('Subscription expiry job error', { error });
  }
};

const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
```

### Cron Schedule Reference

| Job | Schedule | Time | Description |
|-----|----------|------|-------------|
| Expiry Reminders | `0 9 * * *` | 9:00 AM daily | Send reminders 7, 3, 1 days before expiry |
| Grace Period Transition | `0 0 * * *` | 12:00 AM daily | Move expired subscriptions to grace |
| Subscription Expiry | `5 0 * * *` | 12:05 AM daily | Mark grace-ended subs as expired |

---

## 9. Notification System

### WhatsApp Service (Functional)

**src/services/whatsapp.ts**
```typescript
import axios, { AxiosError } from 'axios';
import { env } from '../config/env';
import { prisma } from '../config/database';
import { logger } from '../utils/logger';
import { SendMessagePayload, InteractiveButton } from '../types/whatsapp.types';

const whatsappClient = axios.create({
  baseURL: `https://graph.facebook.com/${env.WHATSAPP_API_VERSION}/${env.WHATSAPP_PHONE_NUMBER_ID}`,
  headers: {
    Authorization: `Bearer ${env.WHATSAPP_ACCESS_TOKEN}`,
    'Content-Type': 'application/json',
  },
});

/**
 * Send a text message
 */
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

/**
 * Send interactive buttons
 */
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

/**
 * Send interactive list
 */
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

/**
 * Send a template message (for messages outside 24h window)
 */
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

/**
 * Core message sending with retry logic
 */
const sendMessage = async (
  payload: SendMessagePayload,
  retries: number = 3
): Promise<string | null> => {
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await whatsappClient.post('/messages', payload);
      const messageId = response.data.messages?.[0]?.id;

      // Log outgoing message if enabled
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

/**
 * Mark message as read
 */
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
```

---

## 10. Admin Capabilities (Backend APIs)

### Admin Handler (Functional)

**src/handlers/admin.handler.ts**
```typescript
import { Request, Response } from 'express';
import { prisma } from '../config/database';
import { getActiveSubscription, getSubscriptionStats } from '../services/subscription';
import { sendTextMessage } from '../services/whatsapp';
import { logger } from '../utils/logger';

/**
 * GET /admin/users
 */
export const getUsers = async (req: Request, res: Response): Promise<void> => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const skip = (page - 1) * limit;

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: {
        subscriptions: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    }),
    prisma.user.count(),
  ]);

  res.json({
    data: users,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

/**
 * GET /admin/users/:id
 */
export const getUser = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const user = await prisma.user.findUnique({
    where: { id },
    include: {
      subscriptions: { orderBy: { createdAt: 'desc' }, include: { group: true } },
      payments: { orderBy: { createdAt: 'desc' } },
    },
  });

  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  res.json(user);
};

/**
 * GET /admin/subscriptions
 */
export const getSubscriptions = async (req: Request, res: Response): Promise<void> => {
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 20;
  const status = req.query.status as string;
  const planId = req.query.planId as string;
  const skip = (page - 1) * limit;

  const where: any = {};
  if (status) where.status = status;
  if (planId) where.planId = planId;

  const [subscriptions, total] = await Promise.all([
    prisma.subscription.findMany({
      where,
      skip,
      take: limit,
      orderBy: { createdAt: 'desc' },
      include: { user: true, group: true },
    }),
    prisma.subscription.count({ where }),
  ]);

  res.json({
    data: subscriptions,
    pagination: { page, limit, total, pages: Math.ceil(total / limit) },
  });
};

/**
 * GET /admin/stats
 */
export const getStats = async (req: Request, res: Response): Promise<void> => {
  const [subscriptionStats, userCount, paymentStats] = await Promise.all([
    getSubscriptionStats(),
    prisma.user.count(),
    prisma.payment.groupBy({
      by: ['status'],
      _count: true,
      _sum: { amount: true },
    }),
  ]);

  const totalRevenue = paymentStats
    .filter(p => p.status === 'SUCCESS')
    .reduce((sum, p) => sum + (p._sum.amount || 0), 0);

  res.json({
    users: { total: userCount },
    subscriptions: subscriptionStats,
    payments: {
      total: paymentStats.reduce((sum, p) => sum + p._count, 0),
      byStatus: paymentStats.reduce((acc, p) => {
        acc[p.status] = p._count;
        return acc;
      }, {} as Record<string, number>),
      totalRevenue: totalRevenue / 100,
    },
  });
};

/**
 * POST /admin/users/:id/resend-link
 */
export const resendGroupLink = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const subscription = await getActiveSubscription(id);
  if (!subscription) {
    res.status(400).json({ error: 'User has no active subscription' });
    return;
  }

  const group = await prisma.group.findUnique({
    where: { planId: subscription.planId },
  });

  if (!group) {
    res.status(400).json({ error: 'Group not found for this plan' });
    return;
  }

  await sendTextMessage(
    user.phoneNumber,
    `Here's your group invite link:\n\n${group.inviteLink}\n\n_This link is exclusive to subscribers._`
  );

  logger.info('Group link resent', { userId: id, adminAction: true });
  res.json({ success: true, message: 'Group link sent' });
};

/**
 * POST /admin/users/:id/send-message
 */
export const sendMessageToUser = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { message } = req.body;

  if (!message) {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  const user = await prisma.user.findUnique({ where: { id } });
  if (!user) {
    res.status(404).json({ error: 'User not found' });
    return;
  }

  const messageId = await sendTextMessage(user.phoneNumber, message);

  logger.info('Manual message sent', { userId: id, adminAction: true });
  res.json({ success: true, messageId });
};

/**
 * POST /admin/subscriptions/:id/extend
 */
export const extendSubscription = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { days } = req.body;

  if (!days || days < 1) {
    res.status(400).json({ error: 'Valid days value is required' });
    return;
  }

  const subscription = await prisma.subscription.findUnique({
    where: { id },
    include: { user: true },
  });

  if (!subscription) {
    res.status(404).json({ error: 'Subscription not found' });
    return;
  }

  const newExpiryDate = new Date(subscription.expiryDate);
  newExpiryDate.setDate(newExpiryDate.getDate() + days);

  await prisma.subscription.update({
    where: { id },
    data: { expiryDate: newExpiryDate, status: 'ACTIVE' },
  });

  await sendTextMessage(
    subscription.user.phoneNumber,
    `Good news! Your subscription has been extended by ${days} days.\n\nNew expiry date: ${newExpiryDate.toLocaleDateString()}`
  );

  logger.info('Subscription extended', { subscriptionId: id, days, adminAction: true });
  res.json({ success: true, newExpiryDate });
};

/**
 * POST /admin/broadcast
 */
export const broadcast = async (req: Request, res: Response): Promise<void> => {
  const { message, filter } = req.body;

  if (!message) {
    res.status(400).json({ error: 'Message is required' });
    return;
  }

  let users;
  
  switch (filter) {
    case 'active':
      const activeSubscriptions = await prisma.subscription.findMany({
        where: { status: 'ACTIVE' },
        include: { user: true },
      });
      users = activeSubscriptions.map(s => s.user);
      break;
    case 'expired':
      const expiredSubscriptions = await prisma.subscription.findMany({
        where: { status: 'EXPIRED' },
        include: { user: true },
      });
      users = expiredSubscriptions.map(s => s.user);
      break;
    default:
      users = await prisma.user.findMany();
  }

  const uniqueUsers = Array.from(new Map(users.map(u => [u.id, u])).values());

  let sent = 0;
  let failed = 0;

  for (const user of uniqueUsers) {
    try {
      await sendTextMessage(user.phoneNumber, message);
      sent++;
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      failed++;
      logger.error('Broadcast message failed', { userId: user.id, error });
    }
  }

  logger.info('Broadcast completed', { sent, failed, filter });
  res.json({ success: true, sent, failed, total: uniqueUsers.length });
};

/**
 * GET /admin/groups
 */
export const getGroups = async (req: Request, res: Response): Promise<void> => {
  const groups = await prisma.group.findMany({
    include: { _count: { select: { subscriptions: true } } },
  });
  res.json(groups);
};

/**
 * POST /admin/groups
 */
export const createGroup = async (req: Request, res: Response): Promise<void> => {
  const { planId, name, inviteLink } = req.body;

  if (!planId || !name || !inviteLink) {
    res.status(400).json({ error: 'planId, name, and inviteLink are required' });
    return;
  }

  const group = await prisma.group.create({
    data: { planId, name, inviteLink },
  });

  res.status(201).json(group);
};

/**
 * PUT /admin/groups/:id
 */
export const updateGroup = async (req: Request, res: Response): Promise<void> => {
  const { id } = req.params;
  const { name, inviteLink, isActive } = req.body;

  const group = await prisma.group.update({
    where: { id },
    data: {
      ...(name && { name }),
      ...(inviteLink && { inviteLink }),
      ...(typeof isActive === 'boolean' && { isActive }),
    },
  });

  res.json(group);
};
```

### Admin Routes

**src/routes/admin.routes.ts**
```typescript
import { Router } from 'express';
import * as adminHandler from '../handlers/admin.handler';
import { authMiddleware } from '../middleware/auth';

const router = Router();

router.use(authMiddleware);

// Users
router.get('/users', adminHandler.getUsers);
router.get('/users/:id', adminHandler.getUser);
router.post('/users/:id/resend-link', adminHandler.resendGroupLink);
router.post('/users/:id/send-message', adminHandler.sendMessageToUser);

// Subscriptions
router.get('/subscriptions', adminHandler.getSubscriptions);
router.post('/subscriptions/:id/extend', adminHandler.extendSubscription);

// Groups
router.get('/groups', adminHandler.getGroups);
router.post('/groups', adminHandler.createGroup);
router.put('/groups/:id', adminHandler.updateGroup);

// Stats & Broadcast
router.get('/stats', adminHandler.getStats);
router.post('/broadcast', adminHandler.broadcast);

export default router;
```

---

## 11. Security & Best Practices

### Authentication Middleware

**src/middleware/auth.ts**
```typescript
import { Request, Response, NextFunction } from 'express';
import { env } from '../config/env';
import { logger } from '../utils/logger';

export const authMiddleware = (
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  const apiKey = req.headers['x-api-key'] as string;

  if (!apiKey) {
    res.status(401).json({ error: 'API key required' });
    return;
  }

  if (apiKey !== env.ADMIN_API_KEY) {
    logger.warn('Invalid admin API key attempt', { ip: req.ip, path: req.path });
    res.status(403).json({ error: 'Invalid API key' });
    return;
  }

  next();
};
```

### Rate Limiting

**src/middleware/rate-limit.ts**
```typescript
import rateLimit from 'express-rate-limit';

export const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Too many requests, please try again later' },
  standardHeaders: true,
  legacyHeaders: false,
});

export const webhookRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 1000,
  message: { error: 'Rate limit exceeded' },
});

export const adminRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Admin rate limit exceeded' },
});
```

### Error Handling

**src/middleware/error.ts**
```typescript
import { Request, Response, NextFunction } from 'express';
import { logger } from '../utils/logger';

export class AppError extends Error {
  statusCode: number;
  isOperational: boolean;

  constructor(message: string, statusCode: number = 500) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
): void => {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  logger.error('Unexpected error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
  });

  res.status(500).json({ error: 'Internal server error' });
};
```

---

## 12. Scalability Considerations

### Queue System

**src/jobs/queue.ts**
```typescript
import { Queue, QueueEvents } from 'bullmq';
import { redisConnection } from '../config/redis';
import { logger } from '../utils/logger';

export const messageQueue = new Queue('messages', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: 'exponential', delay: 1000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

export const notificationQueue = new Queue('notifications', {
  connection: redisConnection,
  defaultJobOptions: {
    attempts: 5,
    backoff: { type: 'exponential', delay: 2000 },
    removeOnComplete: 1000,
    removeOnFail: 5000,
  },
});

const messageQueueEvents = new QueueEvents('messages', { connection: redisConnection });

messageQueueEvents.on('failed', ({ jobId, failedReason }) => {
  logger.error('Job failed', { queue: 'messages', jobId, reason: failedReason });
});

export const closeQueues = async (): Promise<void> => {
  await messageQueue.close();
  await notificationQueue.close();
  logger.info('All queues closed');
};
```

### Redis Configuration

**src/config/redis.ts**
```typescript
import IORedis from 'ioredis';
import { env } from './env';
import { logger } from '../utils/logger';

export const redisConnection = new IORedis(env.REDIS_URL, {
  maxRetriesPerRequest: null,
  enableReadyCheck: false,
  retryStrategy: (times: number) => {
    if (times > 10) {
      logger.error('Redis connection failed after 10 retries');
      return null;
    }
    return Math.min(times * 100, 3000);
  },
});

redisConnection.on('connect', () => logger.info('Redis connected'));
redisConnection.on('error', (error) => logger.error('Redis error', { error: error.message }));
```

---

## 13. Deployment Plan

### Docker Compose

**docker-compose.yml**
```yaml
version: '3.8'

services:
  app:
    build: .
    ports:
      - "3000:3000"
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgresql://postgres:password@db:5432/zuribot
      - REDIS_URL=redis://redis:6379
    depends_on:
      - db
      - redis
    restart: unless-stopped

  worker:
    build: .
    command: node dist/worker.js
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgresql://postgres:password@db:5432/zuribot
      - REDIS_URL=redis://redis:6379
    depends_on:
      - db
      - redis
    restart: unless-stopped

  db:
    image: postgres:15-alpine
    environment:
      - POSTGRES_DB=zuribot
      - POSTGRES_USER=postgres
      - POSTGRES_PASSWORD=password
    volumes:
      - postgres_data:/var/lib/postgresql/data
    restart: unless-stopped

  redis:
    image: redis:7-alpine
    volumes:
      - redis_data:/data
    restart: unless-stopped

volumes:
  postgres_data:
  redis_data:
```

### Webhook URL Configuration

**Meta (WhatsApp):**
1. Go to Meta Developer Console → WhatsApp → Configuration
2. Set Webhook URL: `https://your-domain.com/webhook`
3. Set Verify Token: (same as `WHATSAPP_VERIFY_TOKEN`)
4. Subscribe to: `messages`

**Paystack:**
1. Go to Paystack Dashboard → Settings → API Keys & Webhooks
2. Set Webhook URL: `https://your-domain.com/paystack/webhook`

---

## Implementation Checklist

- [ ] **Phase 1: Foundation**
  - [ ] Project setup with TypeScript
  - [ ] Database schema and migrations
  - [ ] Environment configuration

- [ ] **Phase 2: WhatsApp Integration**
  - [ ] Webhook verification endpoint
  - [ ] Message receiving endpoint
  - [ ] Message sending service

- [ ] **Phase 3: Bot Logic**
  - [ ] Keyword detection (including UPGRADE flow)
  - [ ] User management
  - [ ] Interactive message handling

- [ ] **Phase 4: Payment Integration**
  - [ ] Paystack transaction initialization
  - [ ] Webhook handler
  - [ ] Payment verification

- [ ] **Phase 5: Subscription Engine**
  - [ ] Subscription creation
  - [ ] Status management
  - [ ] Grace period logic

- [ ] **Phase 6: Scheduled Jobs**
  - [ ] Cron scheduler setup
  - [ ] Expiry reminder jobs
  - [ ] Status transition jobs

- [ ] **Phase 7: Admin API**
  - [ ] Authentication
  - [ ] User/subscription management
  - [ ] Statistics and reporting

- [ ] **Phase 8: Deployment**
  - [ ] Docker configuration
  - [ ] Webhook URL configuration
  - [ ] Monitoring setup

---

*This plan provides a complete blueprint for building the WhatsApp subscription system using functional programming patterns.*
