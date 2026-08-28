/**
 * Session-cookie plumbing shared between routes and the WS authenticator:
 * set/clear helpers, requireUser/requireAdmin guards, and the Hono middleware
 * that resolves the session before routing.
 */
import type { Context, MiddlewareHandler } from 'hono';
import { getCookie, setCookie, deleteCookie } from 'hono/cookie';
import type { SessionUser, AuthService } from './auth.js';
import { isSecureRequest } from './auth.js';
import { WebError } from './errors.js';
import type { AppEnv } from './web.js';

export { getCookie };
export function setSessionCookie(
  c: Context<AppEnv>,
  authService: AuthService,
  cookieValue: string,
): void {
  const secure = isSecureRequest(c.get('incoming'));
  setCookie(c, authService.cookieName(secure), cookieValue, {
    httpOnly: true,
    sameSite: 'Strict',
    path: '/',
    maxAge: 30 * 24 * 60 * 60,
    ...(secure ? { secure: true } : {}),
  });
}

export function clearSessionCookie(c: Context<AppEnv>, authService: AuthService): void {
  const secure = isSecureRequest(c.get('incoming'));
  deleteCookie(c, authService.cookieName(secure), { path: '/' });
}

export function requireUser(c: Context<AppEnv>): SessionUser {
  const user = c.get('user');
  if (user === undefined) {
    throw new WebError('unauthorized', 'authentication required');
  }
  return user;
}

export function requireAdmin(c: Context<AppEnv>): SessionUser {
  const user = requireUser(c);
  if (user.role !== 'admin') {
    // System-config / user-management gate: this is the independent role gate,
    // separate from ownership (R20). Non-admins get 403, not 404 — the admin
    // surface itself is not a foreign resource.
    throw new WebError('forbidden', 'admin role required');
  }
  return user;
}

/** Cookie-session middleware: resolves the user before every matched route. */
export function sessionMiddleware(authService: AuthService): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const cookie = authService.readSessionCookie(c.get('incoming'));
    const user = authService.resolveUser(cookie);
    if (user !== undefined) c.set('user', user);
    await next();
  };
}

/** WS upgrade authenticator: same cookie chain, applied to the raw request. */
export function wsSessionAuthenticator(
  authService: AuthService,
): (req: unknown) => { ok: boolean; userId?: string; reason?: string } {
  return (req) => {
    const cookie = authService.readSessionCookie(
      req as Parameters<AuthService['readSessionCookie']>[0],
    );
    const user = authService.resolveUser(cookie);
    if (user === undefined) {
      return { ok: false, reason: 'no valid session cookie' };
    }
    return { ok: true, userId: user.id };
  };
}
