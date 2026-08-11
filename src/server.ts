import app from './app';
import { env } from './config/env';
import { prisma } from './config/database';
import { logger } from './utils/logger';

// A brief network blip on the way up should not kill the process. Prisma
// connects lazily anyway, so this is a readiness probe rather than a hard
// requirement — retrying briefly avoids a single dropped packet taking the
// server down and, on a scheduled host, triggering a restart loop.
const connectWithRetry = async (attempts = 5): Promise<void> => {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await prisma.$connect();
      logger.info('Database connected', { attempt });
      return;
    } catch (error: any) {
      if (attempt === attempts) throw error;
      const delayMs = Math.min(500 * 2 ** (attempt - 1), 5000);
      logger.warn('Database not reachable, retrying', {
        attempt,
        nextRetryMs: delayMs,
        code: error?.errorCode ?? error?.code,
      });
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
};

const startServer = async () => {
  try {
    await connectWithRetry();

    // Start server
    const server = app.listen(env.PORT, () => {
      logger.info(`Server started on port ${env.PORT}`, {
        environment: env.NODE_ENV,
        port: env.PORT,
      });
    });

    // Graceful shutdown
    const shutdown = async (signal: string) => {
      logger.info(`${signal} received, shutting down gracefully`);

      server.close(async () => {
        logger.info('HTTP server closed');

        try {
          await prisma.$disconnect();
          logger.info('All connections closed');
          process.exit(0);
        } catch (error) {
          logger.error('Error during shutdown', { error });
          process.exit(1);
        }
      });

      // Force shutdown after 30 seconds
      setTimeout(() => {
        logger.error('Forced shutdown after timeout');
        process.exit(1);
      }, 30000);
    };

    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));

  } catch (error) {
    logger.error('Failed to start server', { error });
    process.exit(1);
  }
};

startServer();