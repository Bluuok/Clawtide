/**
 * R19 — authentication & session management, whole chain owned here:
 *
 *   bcrypt(12) password → random 64-hex opaque token (stored in user_sessions)
 *   → HMAC-SHA256 signature over the token → `${token}.${sig}` cookie value
 *   → constant-time signature comparison on the way back in.
 *
 * Narrative anchor (interview-critical): the HMAC layer is tamper-evidence for
 * the cookie, NOT a parallel "token scheme" — the database token remains the
 * source of truth, and the constant-time comparison happens at the HMAC
 * signature check, not at the session lookup.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import bcrypt from 'bcryptjs';
import type { Logger } from 'pino';
import type { AppDb } from './db.js';
import type { AppConfig } from './config.js';
import { nowIso } from './time.js';
import { loadOrCreateSecret } from './secrets.js';

export const BCRYPT_ROUNDS = 12;
const TOKEN_HEX_LENGTH = 64;
const SIGNATURE_HEX_LENGTH = 64;
/** Crawler-facing name for HTTPS (__Host- forces Secure by browser rule). */
const COOKIE_NAME_HTTPS = '__Host-clawtide_session';
/** Plain name for local HTTP development, where __Host- is not allowed. */
const COOKIE_NAME_HTTP = 'clawtide_session';
export const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

export const USERNAME_PATTERN = /^[a-zA-Z0-9_]{3,32}$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;

export interface SessionUser {
  id: string;
  username: string;
  role: 'admin' | 'member';
}

// ---------------------------------------------------------------------------
// Passwords and tokens
// ---------------------------------------------------------------------------

export function hashPassword(plain: string): string {
  return bcrypt.hashSync(plain, BCRYPT_ROUNDS);
}

export function verifyPassword(plain: string, hash: string): boolean {
  return bcrypt.compareSync(plain, hash);
}

export function validateUsername(username: string): boolean {
  return USERNAME_PATTERN.test(username);
}

export function validatePassword(password: string): boolean {
  return password.length >= PASSWORD_MIN && password.length <= PASSWORD_MAX;
}

function generateToken(): string {
  return randomBytes(32).toString('hex');
}

// ---------------------------------------------------------------------------
// Cookie signing and verification
// ---------------------------------------------------------------------------

export class AuthService {
  private readonly secret: Buffer;

  constructor(
    private readonly db: AppDb,
    private readonly config: AppConfig,
    private readonly logger: Logger,
    envSecret?: string,
  ) {
    this.secret = loadOrCreateSecret({
      envSecret,
      configDir: joinConfigDir(config),
      logger,
    });
  }

  /** `${token}.${sig}` — sig = HMAC-SHA256(secret, token) hex. */
  signToken(token: string): string {
    const sig = createHmac('sha256', this.secret).update(token).digest('hex');
    return `${token}.${sig}`;
  }

  /**
   * Split and verify the cookie value. Returns the opaque token or undefined.
   * The timing-safe comparison happens HERE (signature check), by design.
   */
  verifySignedCookie(value: string | undefined): string | undefined {
    if (value === undefined) return undefined;
    const idx = value.lastIndexOf('.');
    if (idx <= 0) return undefined;
    const token = value.slice(0, idx);
    const sig = value.slice(idx + 1);
    if (token.length !== TOKEN_HEX_LENGTH || sig.length !== SIGNATURE_HEX_LENGTH) {
      return undefined;
    }
    const expected = createHmac('sha256', this.secret).update(token).digest('hex');
    const a = Buffer.from(sig, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length) return undefined;
    if (!timingSafeEqual(a, b)) return undefined;
    return token;
  }

  /**
   * Create a session row and the signed cookie value. Expiry = now + TTL
   * (SESSION_TTL_DAYS, default 30).
   */
  createSession(
    user: SessionUser,
    meta: { ip?: string; userAgent?: string },
  ): { cookieValue: string; expiresAt: string; token: string } {
    const token = generateToken();
    const expires = new Date(Date.now() + this.config.SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);
    const expiresAt = expires.toISOString();
    this.db.db
      .prepare(
        `INSERT INTO user_sessions (id, user_id, token, ip_address, user_agent, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        randomBytes(16).toString('hex'),
        user.id,
        token,
        meta.ip ?? null,
        meta.userAgent ?? null,
        expiresAt,
        nowIso(),
      );
    return { cookieValue: this.signToken(token), expiresAt, token };
  }

  /** Resolve a signed cookie value to the live user, or undefined. */
  resolveUser(cookieValue: string | undefined): SessionUser | undefined {
    const token = this.verifySignedCookie(cookieValue);
    if (token === undefined) return undefined;
    const row = this.db.db
      .prepare(
        `SELECT u.id, u.username, u.role, s.expires_at
         FROM user_sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ?`,
      )
      .get(token) as
      | { id: string; username: string; role: 'admin' | 'member'; expires_at: string }
      | undefined;
    if (row === undefined) return undefined;
    if (row.expires_at <= nowIso()) {
      this.db.db.prepare('DELETE FROM user_sessions WHERE token = ?').run(token);
      return undefined;
    }
    return { id: row.id, username: row.username, role: row.role };
  }

  destroySession(cookieValue: string | undefined): void {
    const token = this.verifySignedCookie(cookieValue);
    if (token === undefined) return;
    this.db.db.prepare('DELETE FROM user_sessions WHERE token = ?').run(token);
  }

  /** Rotation companion: wipe every session (all users re-login). */
  destroyAllSessions(): void {
    this.db.db.exec('DELETE FROM user_sessions');
  }

  cookieName(secureRequest: boolean): string {
    return secureRequest ? COOKIE_NAME_HTTPS : COOKIE_NAME_HTTP;
  }

  serializeCookie(secureRequest: boolean): string {
    // __Host- prefix REQUIRES Secure; the plain name is for local HTTP only.
    const parts = [
      'HttpOnly',
      'SameSite=Strict',
      `Path=/`,
      `Max-Age=${COOKIE_MAX_AGE_SECONDS}`,
    ];
    if (secureRequest) parts.unshift('Secure');
    return `${parts.join('; ')}`;
  }

  readSessionCookie(req: IncomingMessage): string | undefined {
    const header = req.headers.cookie;
    if (header === undefined) return undefined;
    const secure = isSecureRequest(req);
    const name = this.cookieName(secure);
    for (const pair of header.split(';')) {
      const eq = pair.indexOf('=');
      if (eq === -1) continue;
      const k = pair.slice(0, eq).trim();
      if (k === name) return decodeURIComponent(pair.slice(eq + 1).trim());
    }
    // A forged __Host- cookie over plain HTTP must not authenticate: only the
    // plain name is read on non-HTTPS requests (and vice versa).
    return undefined;
  }
}

/** HTTPS detection for cookie naming: X-Forwarded-Proto only when TRUST_PROXY. */
export function isSecureRequest(req: IncomingMessage): boolean {
  const socket = req.socket;
  if ((socket as { encrypted?: boolean }).encrypted === true) return true;
  return false;
}

export function joinConfigDir(config: AppConfig): string {
  return path.join(config.dataDir, 'config');
}
