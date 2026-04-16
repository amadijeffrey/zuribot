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

// CORS configuration
app.use(cors({
  origin: env.NODE_ENV === 'production'
    ? ['https://your-admin-domain.com']
    : '*',
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-API-Key'],
}));

// Body parsing
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: true, limit: '10kb' }));

// Request logging
app.use((req, res, next) => {
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
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// Error handler
app.use(errorHandler);

export default app;