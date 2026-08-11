import winston from 'winston';
import { env } from '../config/env';
import { redactInfoInPlace } from './redact';

// Masks personal identifiers (emails, phone numbers, cardholder names) in log
// metadata. Applied centrally rather than at each call site so new logging can't
// reintroduce the leak.
const redactPii = winston.format((info) => redactInfoInPlace(info as any));

const logFormat = winston.format.combine(
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

// File transports require a writable filesystem, which serverless platforms
// like Vercel do not provide. Only enable them when running on a normal host.
if (!process.env.VERCEL) {
  transports.push(
    new winston.transports.File({
      filename: 'logs/error.log',
      level: 'error',
    }),
    new winston.transports.File({
      filename: 'logs/combined.log',
    })
  );
}

export const logger = winston.createLogger({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  format: logFormat,
  defaultMeta: { service: 'zuribot' },
  transports,
});