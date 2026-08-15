import { Request, Response, NextFunction, RequestHandler } from 'express';
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
  _next: NextFunction
): void => {
  if (err instanceof AppError) {
    logger.warn('Operational error', {
      message: err.message,
      statusCode: err.statusCode,
      path: req.path,
    });
    res.status(err.statusCode).json({ error: err.message });
    return;
  }

  logger.error('Unexpected error', {
    error: err.message,
    stack: err.stack,
    path: req.path,
    method: req.method,
  });

  // The id is returned so a caller reporting "it failed" can quote something
  // that finds the exact stack trace in the logs. It identifies a log line, not
  // a user, and grants no access on its own.
  res.status(500).json({ error: 'Internal server error', requestId: req.id });
};

type AsyncRequestHandler = (
  req: Request,
  res: Response,
  next: NextFunction,
) => Promise<unknown>;

// Express 4 catches a *synchronous* throw inside a handler and routes it here,
// but it cannot see a rejected promise — the rejection goes unhandled and Node
// terminates the process. Every async handler and async middleware must be
// wrapped in this, or one transient database error takes the server down.
export const asyncHandler =
  (fn: AsyncRequestHandler): RequestHandler =>
  (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };