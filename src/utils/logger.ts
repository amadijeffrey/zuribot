import winston from 'winston';
import fs from 'fs';
import path from 'path';
import { env } from '../config/env';
import { redactInfoInPlace } from './redact';
import { getRequestContext } from './request-context';

// Masks personal identifiers (emails, phone numbers, cardholder names) in log
// metadata. Applied centrally rather than at each call site so new logging can't
// reintroduce the leak.
const redactPii = winston.format((info) => redactInfoInPlace(info as any));

// Stamps the current request's id onto every line logged while handling it —
// including lines from services that know nothing about HTTP. Applied centrally
// for the same reason as redaction: correlation that depends on each call site
// remembering to pass an id is correlation you do not have.
const withRequestContext = winston.format((info) => {
  const context = getRequestContext();
  if (context) {
    info.requestId = context.requestId;
    if (context.actor) info.actor = context.actor;
  }
  return info;
});

const logFormat = winston.format.combine(
  withRequestContext(),
  redactPii(),
  winston.format.timestamp(),
  winston.format.errors({ stack: true }),
  winston.format.json()
);

const transports: winston.transport[] = [
  new winston.transports.Console({
    format: winston.format.combine(
      winston.format.colorize(),
      winston.format.simple()
    ),
  }),
];

// On-disk logs are opt-in, and off unless LOG_FILE_DIR is set.
//
// stdout is the primary sink on every target this app runs on: Vercel captures
// it natively, and on the VM Docker's json-file driver captures *and* rotates it
// (50 MB x 5, configured by scripts/setup.sh). Writing the same lines to a file
// as well duplicated every request — and with no size bound that second copy
// grew without limit inside the container's writable layer, where Docker's
// rotation cannot see it and nothing ever reclaimed it.
//
// Kept as an option for a host where stdout is not collected. Bounded here so
// enabling it can never reproduce the original problem: each file caps at 20 MB
// and keeps 5 generations, so the worst case is a predictable 200 MB.
if (env.LOG_FILE_DIR) {
  const dir = env.LOG_FILE_DIR;

  // Winston creates the file but not its parent directory, and a missing one
  // throws asynchronously from inside the transport where it is easy to miss.
  fs.mkdirSync(dir, { recursive: true });

  const rotation = { maxsize: 20 * 1024 * 1024, maxFiles: 5, tailable: true };

  transports.push(
    new winston.transports.File({
      filename: path.join(dir, 'error.log'),
      level: 'error',
      ...rotation,
    }),
    new winston.transports.File({
      filename: path.join(dir, 'combined.log'),
      ...rotation,
    })
  );
}

export const logger = winston.createLogger({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: logFormat,
  defaultMeta: { service: 'zuribot' },
  transports,
});