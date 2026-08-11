import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { env } from './config/env';
import routes from './routes';
import { errorHandler } from './middleware/error';
import { apiRateLimiter } from './middleware/rate-limit';
import { logger } from './utils/logger';

const app = express();

// Security headers
app.use(helmet());

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
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));


app.use(express.json({
  limit: '10kb',
  verify: (req, _res, buf) => {
    req.rawBody = buf;
  },
}));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Request logging
app.use((req, _res, next) => {
  logger.info('Incoming request', {
    method: req.method,
    path: req.path,
    ip: req.ip,
  });
  next();
});

// API rate limiter (applied to non-webhook routes)
app.use('/admin', apiRateLimiter);

// Mount routes
app.use('/', routes);

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use(errorHandler);

export default app;
