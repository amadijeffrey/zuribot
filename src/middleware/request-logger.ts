import { Request, Response, NextFunction } from 'express';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger';
import { runWithRequestContext } from '../utils/request-context';

// Polled by uptime monitors every minute, forever. Logged at debug so they stay
// visible locally without burying real traffic in production.
const QUIET_PATHS = new Set(['/health', '/ready']);

// Query parameters that must never reach a log line. `reference` is not secret,
// but the rest identify or authenticate someone.
const REDACTED_QUERY_KEYS = new Set(['token', 'password', 'email', 'phone', 'secret']);

const safeQuery = (query: Request['query']): Record<string, unknown> | undefined => {
  const keys = Object.keys(query);
  if (keys.length === 0) return undefined;

  const out: Record<string, unknown> = {};
  for (const key of keys) {
    out[key] = REDACTED_QUERY_KEYS.has(key.toLowerCase()) ? '[REDACTED]' : query[key];
  }
  return out;
};

// Opens a logging context for the request and records how it ended.
//
// Two lines per request rather than one: the completion line carries status and
// duration, but it only exists if the request actually completed. A request that
// hangs, is killed by a platform timeout, or dies with the process leaves only
// the start line — and that line is the whole evidence that it was ever tried.
export const requestLogger = (req: Request, res: Response, next: NextFunction): void => {
  // Honour an inbound id so a trace begun at the proxy or the frontend survives
  // into these logs; generate one otherwise.
  const requestId = (req.headers['x-request-id'] as string) || randomUUID();
  req.id = requestId;

  // Echoed back so a failing response can be tied to a log line without the
  // caller needing access to the logs to ask about it.
  res.setHeader('X-Request-Id', requestId);

  const startedAt = process.hrtime.bigint();
  const quiet = QUIET_PATHS.has(req.path);

  runWithRequestContext({ requestId, method: req.method, path: req.path }, () => {
    logger[quiet ? 'debug' : 'info']('Request started', {
      method: req.method,
      path: req.path,
      ip: req.ip,
      query: safeQuery(req.query),
    });

    // 'finish' fires once the response is flushed. 'close' also covers the
    // client hanging up first — a case 'finish' never reports, and the one that
    // matters when diagnosing requests that appear to vanish.
    let settled = false;
    const complete = (aborted: boolean) => {
      if (settled) return;
      settled = true;

      const durationMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      const status = res.statusCode;

      const level = aborted || status >= 500 ? 'error' : status >= 400 ? 'warn' : quiet ? 'debug' : 'info';

      logger[level](aborted ? 'Request aborted by client' : 'Request completed', {
        method: req.method,
        path: req.path,
        status,
        durationMs: Math.round(durationMs * 100) / 100,
      });
    };

    res.once('finish', () => complete(false));
    res.once('close', () => complete(!res.writableEnded));

    next();
  });
};
