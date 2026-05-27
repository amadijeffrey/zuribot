import app from './app';
import { env } from './config/env';
import { prisma } from './config/database';
import { redisConnection } from './config/redis';
import { closeQueues } from './jobs/queue';
import { messageWorker, closeMessageWorker } from './jobs/workers/message.worker';
import { logger } from './utils/logger';

const startServer = async () => {
  try {
    // Test database connection
    await prisma.$connect();
    logger.info('Database connected');

    // Test Redis connection
    await redisConnection.ping();
    logger.info('Redis connected');

    // BullMQ workers run in-process alongside the HTTP server. Importing the
    // modules above instantiates them; log here so it's visible in startup.
    logger.info('Workers started', {
      message: messageWorker.isRunning(),
  
    });

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
          await closeMessageWorker();
      
          await closeQueues();
          await prisma.$disconnect();
          await redisConnection.quit();
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