# ZuriBot - WhatsApp Subscription System

A WhatsApp-based subscription system with Paystack payment integration.

## Features

- WhatsApp Cloud API integration for messaging
- Paystack payment gateway integration
- Subscription management with grace periods
- Admin API for user/subscription management
- Scheduled jobs for expiry reminders
- Message queue for async processing (BullMQ + Redis)

## Quick Start

### Prerequisites

- Node.js 18+
- PostgreSQL 15+
- Redis 7+

### Installation

1. Clone and install dependencies:
```bash
npm install
```

2. Copy environment file:
```bash
cp .env.example .env
```

3. Configure your `.env` file with your credentials.

4. Generate Prisma client:
```bash
npm run db:generate
```

5. Run database migrations:
```bash
npm run db:migrate
```

6. Seed the database:
```bash
npm run db:seed
```

7. Start the server:
```bash
npm run dev
```

8. Start the worker (in separate terminal):
```bash
npm run worker
```

## Docker Deployment

```bash
docker-compose up -d
```

## API Endpoints

### Webhooks
- `GET /webhook` - WhatsApp webhook verification
- `POST /webhook` - WhatsApp incoming messages
- `POST /paystack/webhook` - Paystack payment events

### Admin API (requires `X-API-Key` header)
- `GET /admin/users` - List users
- `GET /admin/users/:id` - Get user details
- `POST /admin/users/:id/resend-link` - Resend group link
- `POST /admin/users/:id/send-message` - Send message
- `GET /admin/subscriptions` - List subscriptions
- `POST /admin/subscriptions/:id/extend` - Extend subscription
- `GET /admin/payments` - List payments
- `GET /admin/groups` - List groups
- `POST /admin/groups` - Create group
- `PUT /admin/groups/:id` - Update group
- `GET /admin/stats` - Get statistics
- `POST /admin/broadcast` - Send broadcast message

### Bot Commands
- `UPGRADE` / `PLANS` - View available plans
- `JOIN WEALTH` - Subscribe to Wealth Plan
- `JOIN BOOST` - Subscribe to Boost Plan
- `PREMIUM` - Subscribe to Premium Plan
- `STATUS` - Check subscription status
- `RENEW` - Renew subscription
- `HELP` - Show help menu

## Environment Variables

See `.env.example` for all required variables.

## License

MIT