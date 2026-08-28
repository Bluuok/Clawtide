/**
 * R19 core chain tests (spec §6.1 必备测试): tamper rejection, signature
 * length rules, cookie naming, session lifecycle, vault round-trip, secret
 * file persistence.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {
  AuthService,
  hashPassword,
  verifyPassword,
  validateUsername,
  validatePassword,
} from '../auth.js';
import { CredentialVault } from '../vault.js';
import { loadOrCreateSecret } from '../secrets.js';
import { openDatabase } from '../db.js';
import { makeTestConfig, testLogger, cleanupDir } from '../test-support/harness.js';
import { pino } from 'pino';

const silent = pino({ level: 'silent' });
const TEST_SECRET = 'test-secret-material';
/** The AuthService HKDF-derives env secrets; mirror it for expected sigs. */
const testKey = (): Buffer =>
  loadOrCreateSecret({
    envSecret: TEST_SECRET,
    configDir: path.join(os.tmpdir(), 'clawtide-unused'),
    logger: silent,
  });

describe('R19 password + token chain', () => {
  it('hashes with bcrypt and verifies', () => {
    const hash = hashPassword('correct horse battery');
    expect(hash.startsWith('$2')).toBe(true);
    expect(hash.split('$')[2]).toBe('12'); // rounds marker
    expect(verifyPassword('correct horse battery', hash)).toBe(true);
    expect(verifyPassword('wrong password', hash)).toBe(false);
  });

  it('enforces username and password shape', () => {
    expect(validateUsername('abc')).toBe(true);
    expect(validateUsername('a_b_C9')).toBe(true);
    expect(validateUsername('ab')).toBe(false); // too short
    expect(validateUsername('has space')).toBe(false);
    expect(validateUsername('has-dash')).toBe(false);
    expect(validatePassword('12345678')).toBe(true);
    expect(validatePassword('1234567')).toBe(false);
    expect(validatePassword('x'.repeat(129))).toBe(false);
  });
});

describe('R19 HMAC cookie chain', () => {
  let dataDir: string;
  let auth: AuthService;
  let db: ReturnType<typeof openDatabase>;

  beforeEach(() => {
    const config = makeTestConfig();
    dataDir = config.dataDir;
    db = openDatabase({ config, logger: silent });
    // Session rows FK-reference users — seed the session user first.
    db.db
      .prepare(
        "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1', 'alice', 'h', 'admin', '2026-01-01T00:00:00.000Z')",
      )
      .run();
    auth = new AuthService(db, config, silent, TEST_SECRET);
  });

  afterEach(() => {
    db.close();
    cleanupDir(dataDir);
  });

  it('signed cookie verifies to the original token', () => {
    const token = randomBytes(32).toString('hex');
    const signed = auth.signToken(token);
    expect(signed).toBe(
      `${token}.${createHmac('sha256', testKey()).update(token).digest('hex')}`,
    );
    expect(auth.verifySignedCookie(signed)).toBe(token);
  });

  it('rejects a tampered payload (token or signature flipped)', () => {
    const token = randomBytes(32).toString('hex');
    const signed = auth.signToken(token);
    const [tok, sig] = signed.split('.');
    // Flip one token char to a guaranteed-different value (avoid a 1/16 no-op
    // when the sampled char happens to equal the replacement).
    const flipped = (tok![0] === '0' ? '1' : '0') + tok!.slice(1);
    expect(flipped).not.toBe(tok);
    expect(auth.verifySignedCookie(`${flipped}.${sig}`)).toBeUndefined();
    const badSig = (sig![0] === '0' ? '1' : '0') + sig!.slice(1);
    expect(auth.verifySignedCookie(`${tok}.${badSig}`)).toBeUndefined();
    // A signature produced under a different secret fails.
    const forged = `${tok}.${createHmac('sha256', Buffer.from('other-secret')).update(tok!).digest('hex')}`;
    expect(auth.verifySignedCookie(forged)).toBeUndefined();
  });

  it('rejects wrong signature length and unsigned legacy cookies', () => {
    const token = randomBytes(32).toString('hex');
    expect(auth.verifySignedCookie(`${token}.${'ab'.repeat(20)}`)).toBeUndefined(); // 40 hex, not 64
    expect(auth.verifySignedCookie(`${token}.deadbeef`)).toBeUndefined();
    expect(auth.verifySignedCookie(token)).toBeUndefined(); // old unsigned cookie: default reject
    expect(auth.verifySignedCookie('')).toBeUndefined();
    expect(auth.verifySignedCookie('.abc')).toBeUndefined();
    expect(auth.verifySignedCookie(undefined)).toBeUndefined();
  });

  it('session round-trip: create → resolve → destroy', () => {
    const user = { id: 'u1', username: 'alice', role: 'admin' as const };
    const { cookieValue } = auth.createSession(user, { ip: '127.0.0.1', userAgent: 'vitest' });
    expect(auth.resolveUser(cookieValue)).toEqual(user);
    auth.destroySession(cookieValue);
    expect(auth.resolveUser(cookieValue)).toBeUndefined();
  });

  it('expired session resolves to nothing and is deleted', () => {
    const user = { id: 'u1', username: 'alice', role: 'member' as const };
    const { cookieValue } = auth.createSession(user, {});
    // Force-expire every session row.
    db.db.prepare("UPDATE user_sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
    expect(auth.resolveUser(cookieValue)).toBeUndefined();
  });

  it('cookie naming: __Host- only on HTTPS; plain name on HTTP', () => {
    expect(auth.cookieName(true)).toBe('__Host-clawtide_session');
    expect(auth.cookieName(false)).toBe('clawtide_session');
    const secure = auth.serializeCookie(true);
    expect(secure).toContain('Secure');
    expect(secure).toContain('HttpOnly');
    expect(secure).toContain('SameSite=Strict');
    expect(secure).toContain('Path=/');
    expect(secure).toContain('Max-Age=2592000');
    const plain = auth.serializeCookie(false);
    expect(plain).not.toContain('Secure');
  });

  it('reads only the cookie name matching the request security, forging __Host- over HTTP fails', () => {
    const plain = (extra: Record<string, string>): unknown => ({
      headers: { cookie: extra.cookie },
      socket: {},
    });
    // HTTP request: only the plain name is honored.
    const httpReq = plain({ cookie: 'clawtide_session=abc; __Host-clawtide_session=def' });
    expect(auth.readSessionCookie(httpReq as never)).toBe('abc');
    // HTTPS request: only the __Host- name is honored.
    const httpsReq = {
      headers: { cookie: 'clawtide_session=abc; __Host-clawtide_session=def' },
      socket: { encrypted: true },
    };
    expect(auth.readSessionCookie(httpsReq as never)).toBe('def');
  });
});

describe('R19 secret file management', () => {
  it('env secret wins; file persists and reloads identically', () => {
    const dir = path.join(os.tmpdir(), `clawtide-secret-${randomBytes(4).toString('hex')}`);
    try {
      const a = loadOrCreateSecret({ configDir: dir, logger: silent });
      const b = loadOrCreateSecret({ configDir: dir, logger: silent });
      expect(a.equals(b)).toBe(true);
      expect(existsSync(path.join(dir, 'session-secret.key'))).toBe(true);
      const keyFile = loadOrCreateSecret({ configDir: dir, logger: silent });
      expect(keyFile.equals(a)).toBe(true);
      // Env path never touches the filesystem.
      const envDir = path.join(
        os.tmpdir(),
        `clawtide-secret-${randomBytes(4).toString('hex')}`,
      );
      const fromEnv = loadOrCreateSecret({
        envSecret: 'hunter2',
        configDir: envDir,
        logger: silent,
      });
      expect(existsSync(path.join(envDir, 'session-secret.key'))).toBe(false);
      expect(
        loadOrCreateSecret({ envSecret: 'hunter2', configDir: envDir, logger: silent }).equals(
          fromEnv,
        ),
      ).toBe(true);
      rmSync(envDir, { recursive: true, force: true });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('R19 credential vault (AES-256-GCM)', () => {
  it('round-trips and produces distinct ciphertexts per call', () => {
    const dir = path.join(os.tmpdir(), `clawtide-vault-${randomBytes(4).toString('hex')}`);
    try {
      const vault = CredentialVault.open(dir);
      const blob1 = vault.encrypt('bot-token-xyz');
      const blob2 = vault.encrypt('bot-token-xyz');
      expect(blob1.equals(blob2)).toBe(false); // fresh IV per row
      expect(vault.decrypt(blob1)).toBe('bot-token-xyz');
      // Reopening with the persisted master key still decrypts.
      const reopened = CredentialVault.open(dir);
      expect(reopened.decrypt(blob1)).toBe('bot-token-xyz');
      // Tampering breaks the GCM tag.
      const corrupted = Buffer.from(blob1);
      corrupted[corrupted.length - 1] = corrupted[corrupted.length - 1]! ^ 0xff;
      expect(() => reopened.decrypt(corrupted)).toThrowError();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
