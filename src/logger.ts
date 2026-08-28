/**
 * Structured logging (pino). Every log line carries requestId / channel /
 * taskId / userId when available. Secret-bearing keys are redacted at the
 * transport layer so a stray credential in a logged object never reaches disk.
 */
import { pino } from 'pino';
import type { Logger } from 'pino';
import type { AppConfig } from './config.js';

/** Keys whose values must never appear in logs (spec §7.4). */
const REDACT_PATHS = [
  'password',
  'password_hash',
  'passwordHash',
  'token',
  'sessionToken',
  'secret',
  'sessionSecret',
  'credentials',
  'credentials_enc',
  'credentialsEnc',
  'encryption_key',
  'masterKey',
  'apiKey',
  'authorization',
  'cookie',
  'confirmation_phrase',
  'confirmationPhrase',
  '*.password',
  '*.token',
  '*.secret',
  '*.credentials',
];

export interface LoggerDeps {
  config: AppConfig;
}

export function createLogger({ config }: LoggerDeps): Logger {
  return pino({
    level: config.isTest ? 'silent' : config.LOG_LEVEL,
    redact: {
      paths: REDACT_PATHS,
      censor: '[redacted]',
    },
    base: undefined,
    ...(config.isProd ? {} : { transport: { target: 'pino-pretty' } }),
  });
}
