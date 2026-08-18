import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env';
import routes from './routes';
import { AppError, errorHandler } from './middleware/error';
import { requestLogger } from './middleware/request-logger';
import { logger } from './utils/logger';

const app = express();

// Caddy terminates TLS and proxies to this process over the Docker network, so
// the socket address of every request is Caddy's container IP. Without this,
// `req.ip` is that same value for all traffic and every IP-keyed rate limiter
// collapses into a single global bucket — ten failed logins from anyone would
// lock out everyone, and registrations would cap at five per hour platform-wide.
//
// The value is a hop count: 1 == trust exactly the last proxy (Caddy), and read
// the client from the final entry of X-Forwarded-For. Raise it only if another
// proxy is added in front (an ALB or Cloudflare would make it 2) — setting it
// higher than the real number of proxies lets clients forge their own IP by
// sending an X-Forwarded-For header.
//
// Safe here because the `app` service publishes no host port in production
// (see docker-compose.yml): nothing outside the Docker network can reach this
// process without passing through Caddy first.
app.set('trust proxy', 1);

// Security headers
app.use(helmet());

// Mounted ahead of CORS and body parsing so requests rejected by those — a
// blocked origin, a payload over the size limit — are logged too. Those are
// exactly the failures that otherwise leave no trace on the server at all.
app.use(requestLogger);

const allowedOrigins = env.ALLOWED_ORIGINS
  ? env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean)
  : [];

if (allowedOrigins.length === 0) {
  logger.warn('ALLOWED_ORIGINS is empty — all browser origins will be rejected');
}

app.use(cors({
   origin: (origin, callback) => {
    if (!origin) {
      return callback(null, true)
    }

    if (allowedOrigins.includes(origin)) {
      callback(null, true)
    } else {
      logger.warn('Blocked by CORS', { origin });
      // AppError, not a bare Error: the handler treats a bare one as an unexpected
      // fault and answers 500 with a stack trace. A disallowed origin is a client
      // problem, so 403 is the honest status — and it keeps a single stale browser
      // tab from filling the log with error-level stacks.
      callback(new AppError('Not allowed by CORS', 403));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));


app.use(express.json({
  limit: '10kb',
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// No app-wide rate limiter by design. Each router applies one sized to its own
// traffic — adminRateLimiter, memberRead/memberAction, webhookRateLimiter, and
// the stricter login/register limiters — because a single global limit can only
// be set loose enough for the busiest endpoint, which makes it useless for the
// rest. /health and /ready are deliberately unlimited so an uptime monitor
// polling every minute can never be throttled.
//
// (A limiter previously sat on '/admin' here, which never matched: the admin
// router mounts at '/api/admin'. It was dead middleware, not extra protection.)

// Mount routes
app.use('/', routes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use(errorHandler);

export default app;
