/**
 * Test support: temp data dirs and pino loggers wired to throw on error.
 * Not shipped in build output (excluded by tsconfig.build.json).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pino } from 'pino';
import type { AppConfig } from '../config.js';

export function makeTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), 'clawtide-test-'));
  return {
    NODE_ENV: 'test',
    DATA_DIR: dataDir,
    PORT: 0,
    HOST: '127.0.0.1',
    TRUST_PROXY: false,
    CORS_ALLOWED_ORIGINS: '',
    LOG_LEVEL: 'error',
    SESSION_TTL_DAYS: 30,
    AUTH_MAX_ATTEMPTS: 5,
    AUTH_LOCKOUT_MINUTES: 15,
    corsOrigins: [],
    dataDir,
    isTest: true,
    isProd: false,
    ...overrides,
  };
}

export function testLogger() {
  return pino({ level: 'silent' });
}

export function cleanupDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
