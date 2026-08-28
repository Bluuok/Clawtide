/**
 * Auth route family: /auth/setup (first user = admin, open exactly once),
 * /auth/login (two-layer rate limit + audit), /auth/logout, /auth/me,
 * /auth/users (admin-only user management). Registration model: first user
 * becomes admin via setup; further users are created by an admin — open
 * sign-up is a documented evolution direction, not shipped.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { WebError } from '../errors.js';
import { hashPassword, validatePassword, validateUsername, verifyPassword } from '../auth.js';
import type { AuthService, SessionUser } from '../auth.js';
import { LoginRateLimiter, clientIp } from '../rate-limit.js';
import type { UserStore } from '../stores/users.js';
import type { WorkspaceStore } from '../stores/workspaces.js';
import {
  setSessionCookie,
  clearSessionCookie,
  requireUser,
  requireAdmin,
} from '../auth-context.js';
import type { Context } from 'hono';
import type { AppEnv } from '../web.js';

const credentialsSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
});

const createUserSchema = z.object({
  username: z.string().min(1).max(64),
  password: z.string().min(1).max(128),
  role: z.enum(['admin', 'member']).default('member'),
});

export interface AuthRoutesDeps {
  authService: AuthService;
  userStore: UserStore;
  workspaceStore: WorkspaceStore;
  rateLimiter: LoginRateLimiter;
}

export function registerAuthRoutes(app: Hono<AppEnv>, deps: AuthRoutesDeps): void {
  const { authService, userStore, workspaceStore, rateLimiter } = deps;

  // Home workspace exists before any session-dependent logic runs.
  const ensureHomeFor = (user: SessionUser): void => {
    workspaceStore.ensureHome(user.username, user.id);
  };

  app.post('/auth/setup', async (c) => {
    const body = credentialsSchema.parse(await c.req.json().catch(() => undefined));
    const user = createFirstUser(
      userStore,
      authService,
      body.username,
      body.password,
      c,
      workspaceStore,
    );
    userStore.audit(
      'login_success',
      body.username,
      clientIp(c.get('incoming'), c.get('config').TRUST_PROXY),
      'via-setup',
    );
    return c.json({ user: publicUser(user) }, 201);
  });

  app.post('/auth/login', async (c) => {
    const body = credentialsSchema.parse(await c.req.json().catch(() => undefined));
    const ip = clientIp(c.get('incoming'), c.get('config').TRUST_PROXY);
    const nowMs = Date.now();

    const gate = rateLimiter.check(body.username, ip, nowMs);
    if (!gate.allowed) {
      userStore.audit('rate_limited', body.username, ip, `layer=${gate.layer}`);
      throw new WebError('rate_limited', 'too many failed attempts; try again later');
    }

    const row = userStore.byName(body.username);
    const ok = row !== undefined && verifyPassword(body.password, row.password_hash);
    if (!ok) {
      rateLimiter.failure(body.username, ip, nowMs);
      userStore.audit('login_fail', body.username, ip);
      // Uniform failure: no user-existence oracle.
      throw new WebError('unauthorized', 'invalid username or password');
    }

    rateLimiter.success(body.username, ip);
    const user = userStore.toSessionUser(row!);
    ensureHomeFor(user);
    const { cookieValue } = authService.createSession(user, {
      ip,
      userAgent: c.req.header('user-agent'),
    });
    userStore.audit('login_success', body.username, ip);
    setSessionCookie(c, authService, cookieValue);
    return c.json({ user: publicUser(user) });
  });

  app.post('/auth/logout', async (c) => {
    const cookie = authService.readSessionCookie(c.get('incoming'));
    authService.destroySession(cookie);
    const user = c.get('user');
    if (user !== undefined) {
      userStore.audit(
        'logout',
        user.username,
        clientIp(c.get('incoming'), c.get('config').TRUST_PROXY),
      );
    }
    clearSessionCookie(c, authService);
    return c.json({ ok: true });
  });

  app.get('/auth/me', async (c) => {
    const user = requireUser(c);
    return c.json({ user: publicUser(user) });
  });

  app.get('/auth/users', async (c) => {
    requireAdmin(c);
    return c.json({ users: userStore.list() });
  });

  app.post('/auth/users', async (c) => {
    requireAdmin(c);
    const body = createUserSchema.parse(await c.req.json().catch(() => undefined));
    if (!validateUsername(body.username)) {
      throw new WebError('validation_failed', 'username must match ^[a-zA-Z0-9_]{3,32}$');
    }
    if (!validatePassword(body.password)) {
      throw new WebError('validation_failed', 'password must be 8-128 characters');
    }
    if (userStore.byName(body.username) !== undefined) {
      throw new WebError('conflict', 'username already exists');
    }
    const created = userStore.create(body.username, hashPassword(body.password), body.role);
    return c.json({ user: publicUser(created) }, 201);
  });

  app.delete('/auth/users/:id', async (c) => {
    const admin = requireAdmin(c);
    const id = c.req.param('id');
    if (id === admin.id) {
      throw new WebError('bad_request', 'cannot delete your own account');
    }
    if (userStore.byId(id) === undefined) {
      throw new WebError('not_found', 'user not found');
    }
    userStore.deleteById(id);
    return c.json({ ok: true });
  });
}

function publicUser(user: SessionUser): { id: string; username: string; role: string } {
  return { id: user.id, username: user.username, role: user.role };
}

function createFirstUser(
  userStore: UserStore,
  authService: AuthService,
  username: string,
  password: string,
  c: Context<AppEnv>,
  workspaceStore: WorkspaceStore,
): SessionUser {
  if (!validateUsername(username)) {
    throw new WebError('validation_failed', 'username must match ^[a-zA-Z0-9_]{3,32}$');
  }
  if (!validatePassword(password)) {
    throw new WebError('validation_failed', 'password must be 8-128 characters');
  }
  if (userStore.count() > 0) {
    throw new WebError('forbidden', 'setup already completed');
  }
  const row = userStore.create(username, hashPassword(password), 'admin');
  const user = userStore.toSessionUser(row);
  workspaceStore.ensureHome(user.username, user.id);
  const { cookieValue } = authService.createSession(user, {
    ip: clientIp(c.get('incoming'), c.get('config').TRUST_PROXY),
    userAgent: c.req.header('user-agent'),
  });
  setSessionCookie(c, authService, cookieValue);
  return user;
}
