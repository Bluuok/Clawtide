/**
 * Environment-bound configuration, zod-validated at the process boundary.
 *
 * Resolution priority (per spec §3/§7): persisted web settings (Loop 1, stored
 * in the `settings` table) > environment variables > code defaults. Only the
 * env/default half lives here; `settings.get()` layers persisted values on top
 * at call sites that need overridable knobs.
 *
 * Time convention (spec §7.7): all timestamps stored or logged are UTC ISO
 * strings; durations in this file are in seconds unless named otherwise.
 */
import { resolve as pathResolve } from 'node:path';
import { z } from 'zod';

const booleanish = z
  .union([z.boolean(), z.string()])
  .transform((v) =>
    typeof v === 'boolean' ? v : ['1', 'true', 'yes', 'on'].includes(v.toLowerCase()),
  );

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /** SQLite file. Tests point this at a temp path; never the real data dir. */
  DATA_DIR: z.string().min(1).default('data'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('127.0.0.1'),
  /**
   * Trust X-Forwarded-For for client IP extraction. Default false: only the
   * socket address is trusted unless the operator explicitly sits behind a
   * proxy (spec §6.1 item 7; CLAUDE.md §9 of the reference).
   */
  TRUST_PROXY: booleanish.default(false),
  /** Comma-separated CORS allowlist; empty = same-origin only. */
  CORS_ALLOWED_ORIGINS: z.string().default(''),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  /** Session lifetime in days (spec §6.1 item 2: 30 days). */
  SESSION_TTL_DAYS: z.coerce.number().int().min(1).max(365).default(30),
  /** Login rate-limit: failed attempts per (username, ip) inside the window. */
  AUTH_MAX_ATTEMPTS: z.coerce.number().int().min(1).default(5),
  /** First-layer lockout window in minutes (runtime-overridable later). */
  AUTH_LOCKOUT_MINUTES: z.coerce.number().int().min(1).default(15),
});

export type EnvConfig = z.infer<typeof envSchema>;

export interface AppConfig extends EnvConfig {
  /** Derived: parsed CORS origin list, normalized (no trailing slash). */
  corsOrigins: string[];
  /** Derived: absolute path of the data directory. */
  dataDir: string;
  isTest: boolean;
  isProd: boolean;
}

export class ConfigValidationError extends Error {
  constructor(public readonly issues: string[]) {
    super(`Invalid environment configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigValidationError';
  }
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    throw new ConfigValidationError(
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    );
  }
  const dataDir = pathResolve(parsed.data.DATA_DIR);
  return {
    ...parsed.data,
    dataDir,
    corsOrigins: parsed.data.CORS_ALLOWED_ORIGINS.split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    isTest: parsed.data.NODE_ENV === 'test',
    isProd: parsed.data.NODE_ENV === 'production',
  };
}
