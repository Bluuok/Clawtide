/**
 * Secret file management (spec §6.1 item 6): WEB_SESSION_SECRET env wins;
 * otherwise a persistent key file under data/config/ (mode 0600); otherwise
 * first boot generates one and stores it. Rotation = replace the key file and
 * clear user_sessions — every cookie signature becomes invalid, a clean
 * operation, not a migration.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes, hkdfSync } from 'node:crypto';
import path from 'node:path';
import type { Logger } from 'pino';

const KEY_LENGTH_BYTES = 32;

export interface SecretManagerOptions {
  envSecret?: string;
  configDir: string;
  logger: Logger;
}

export function loadOrCreateSecret(opts: SecretManagerOptions): Buffer {
  const { envSecret, configDir, logger } = opts;
  if (envSecret !== undefined && envSecret.length > 0) {
    logger.debug('session secret loaded from WEB_SESSION_SECRET env');
    return normalizeSecret(envSecret);
  }

  mkdirSync(configDir, { recursive: true });
  const keyPath = path.join(configDir, 'session-secret.key');
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath);
    if (raw.length >= KEY_LENGTH_BYTES) {
      logger.debug({ keyPath }, 'session secret loaded from key file');
      return raw;
    }
    // Too short to be a real key (truncated file); regenerate rather than
    // derive a weak HMAC key from it.
    logger.warn({ keyPath }, 'session secret file too short; regenerating');
  }
  const key = randomBytes(KEY_LENGTH_BYTES);
  writeFileSync(keyPath, key, { mode: 0o600 });
  try {
    chmodSync(keyPath, 0o600); // mode is masked by umask on some platforms
  } catch {
    // Windows ignores POSIX modes; the ACL story is documented in SECURITY.md.
  }
  logger.info({ keyPath }, 'session secret generated and persisted');
  return key;
}

function normalizeSecret(envSecret: string): Buffer {
  // Env secrets are free text; stretch to a stable 32-byte HMAC key via HKDF
  // so a short passphrase is never used directly as key material.
  const derived = hkdfSync(
    'sha256',
    Buffer.from(envSecret, 'utf8'),
    'clawtide-session-secret',
    'web-session-hmac',
    KEY_LENGTH_BYTES,
  );
  return Buffer.from(derived);
}
