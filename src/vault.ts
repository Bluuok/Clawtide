/**
 * Channel-credential vault (spec §6.1 item 8): AES-256-GCM over a per-row
 * random IV, keyed by a master key persisted under data/config/ (0600, auto-
 * generated on first use). The API layer only ever reports "configured or
 * not" — plaintext never round-trips through a response, and the master key
 * is redacted from logs by the logger's path rules.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import path from 'node:path';

const KEY_BYTES = 32;
const IV_BYTES = 12;
const MASTER_KEY_FILE = 'vault-master.key';

export class CredentialVault {
  private constructor(private readonly masterKey: Buffer) {}

  static open(configDir: string): CredentialVault {
    mkdirSync(configDir, { recursive: true });
    const keyPath = path.join(configDir, MASTER_KEY_FILE);
    let key: Buffer;
    if (existsSync(keyPath)) {
      key = readFileSync(keyPath);
      if (key.length !== KEY_BYTES) {
        throw new Error(
          `vault master key at ${keyPath} is ${key.length} bytes; expected ${KEY_BYTES}. ` +
            'Refusing to derive a weak key — restore the file or delete it to re-encrypt credentials.',
        );
      }
    } else {
      key = randomBytes(KEY_BYTES);
      writeFileSync(keyPath, key, { mode: 0o600 });
      try {
        chmodSync(keyPath, 0o600);
      } catch {
        // POSIX modes are best-effort on Windows.
      }
    }
    return new CredentialVault(key);
  }

  encrypt(plaintext: string): Buffer {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    // Layout: iv(12) | authTag(16) | ciphertext
    return Buffer.concat([iv, cipher.getAuthTag(), enc]);
  }

  decrypt(blob: Buffer): string {
    if (blob.length < IV_BYTES + 16) {
      throw new Error('credential blob too short to decrypt');
    }
    const iv = blob.subarray(0, IV_BYTES);
    const tag = blob.subarray(IV_BYTES, IV_BYTES + 16);
    const ciphertext = blob.subarray(IV_BYTES + 16);
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  }
}
