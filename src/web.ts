/**
 * Hono application assembly: middleware stack + route mounting. Transport
 * (listening socket, WS upgrade) lives in server.ts so tests can drive the
 * app directly.
 *
 * `env.incoming` carries the raw node request so auth code can read cookies /
 * socket state outside Hono's abstraction (the WS authenticator shares it).
 */
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import type { IncomingMessage } from 'node:http';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import { ZodError } from 'zod';
import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import type { AppDb } from './db.js';
import { WebError, apiErrorBody } from './errors.js';
import { appVersion } from './version.js';
import type { HealthPayload } from '../shared/protocol.js';
import type { SessionUser, AuthService } from './auth.js';
import type { LoginRateLimiter } from './rate-limit.js';
import type { UserStore } from './stores/users.js';
import type { WorkspaceStore } from './stores/workspaces.js';
import type { AgentProfileStore } from './stores/agent-profiles.js';
import type { AgentRuntime } from './agent-runtime.js';
import type { WsHub } from './ws.js';
import { sessionMiddleware } from './auth-context.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerWorkspaceRoutes } from './routes/workspaces.js';
import { registerProfileRoutes } from './routes/profiles.js';
import { registerChatRoutes } from './routes/chat.js';
import { registerTaskRoutes } from './routes/tasks.js';
import { registerSettingsRoutes } from './routes/settings.js';
import { registerChannelRoutes } from './routes/channels.js';
import type { CredentialVault } from './vault.js';
import type { TaskStore } from './stores/tasks.js';
import type { TaskScheduler } from './task-scheduler.js';
import type { ImManager } from './im-manager.js';

export interface AppServices {
  authService: AuthService;
  userStore: UserStore;
  workspaceStore: WorkspaceStore;
  rateLimiter: LoginRateLimiter;
  profileStore: AgentProfileStore;
  runtime: AgentRuntime;
  wsHub: WsHub;
  taskStore: TaskStore;
  scheduler: TaskScheduler;
  /** IM adapter registry + mount resolution (R07). */
  imManager?: ImManager;
  /** Re-applies the provider settings chain to the runtime deps. */
  refreshProvider?: () => void;
}

export interface ServerDeps {
  config: AppConfig;
  db: AppDb;
  logger: Logger;
  /** Auth services; absent in Loop-0-style tests that only need /healthz. */
  services?: AppServices;
  /** Credential vault for the channel route family (present with services). */
  vault?: CredentialVault;
}

type AppEnv = {
  Variables: {
    requestId: string;
    logger: Logger;
    user: SessionUser | undefined;
    incoming: IncomingMessage;
    config: AppConfig;
  };
};

export function createApp(deps: ServerDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  // Security headers first: a later middleware mutating the response after
  // next() drops headers set by an earlier one on the node-server wire path.
  app.use(
    '*',
    secureHeaders({
      // The console is same-origin only; framing is never needed.
      crossOriginResourcePolicy: 'same-origin',
      contentSecurityPolicy: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameAncestors: ["'none'"],
      },
    }),
  );

  if (deps.config.corsOrigins.length > 0) {
    app.use(
      '*',
      cors({
        origin: deps.config.corsOrigins,
        allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
        allowHeaders: ['Content-Type'],
        credentials: true,
        maxAge: 86400,
      }),
    );
  }

  // Request id first so the error handler and access log can both use it.
  app.use('*', async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set('requestId', requestId);
    c.set('logger', deps.logger.child({ requestId }));
    c.set('config', deps.config);
    // incoming: the raw node request, attached by the node-server adapter via
    // a per-request property. In app.request()-style tests the property is
    // absent, so routes that never touch cookies still receive an empty object.
    c.set(
      'incoming',
      (c.env as { incoming?: IncomingMessage } | undefined)?.incoming ??
        ({ headers: {}, socket: {} } as unknown as IncomingMessage),
    );
    await next();
    c.header('X-Request-Id', requestId);
  });

  // Access log: one structured line per request.
  app.use('*', async (c, next) => {
    const start = performance.now();
    const { method } = c.req;
    const path = c.req.path;
    await next();
    const ms = Math.round((performance.now() - start) * 100) / 100;
    const log = c.get('logger');
    if (path === '/healthz') {
      log.debug({ method, path, status: c.res.status, ms }, 'http');
    } else {
      log.info({ method, path, status: c.res.status, ms }, 'http');
    }
  });

  // --- Public routes -------------------------------------------------------

  app.get('/healthz', (c) => {
    const body: HealthPayload = {
      ok: true,
      version: appVersion(),
      uptimeSeconds: Math.floor(process.uptime()),
    };
    return c.json(body);
  });

  // --- Route families: auth (R19) + workspaces (R20) + profiles (R15) + chat -
  if (deps.services !== undefined) {
    const svc = deps.services;
    const auth = sessionMiddleware(svc.authService);
    for (const prefix of [
      '/auth/*',
      '/workspaces',
      '/workspaces/*',
      '/profiles/*',
      '/drafts/*',
      '/chat/*',
      '/tasks',
      '/tasks/*',
      '/settings/*',
      '/channels',
      '/channels/*',
    ]) {
      app.use(prefix, auth);
    }
    registerAuthRoutes(app, {
      authService: svc.authService,
      userStore: svc.userStore,
      workspaceStore: svc.workspaceStore,
      rateLimiter: svc.rateLimiter,
    });
    registerWorkspaceRoutes(app, { workspaceStore: svc.workspaceStore });
    registerProfileRoutes(app, { profileStore: svc.profileStore });
    registerChatRoutes(app, {
      runtime: svc.runtime,
      workspaceStore: svc.workspaceStore,
      profileStore: svc.profileStore,
      wsHub: svc.wsHub,
      refreshProvider: svc.refreshProvider,
    });
    registerTaskRoutes(app, {
      taskStore: svc.taskStore,
      workspaceStore: svc.workspaceStore,
      scheduler: svc.scheduler,
    });
    registerSettingsRoutes(app, { db: deps.db });
    if (deps.vault !== undefined) {
      registerChannelRoutes(app, { db: deps.db, vault: deps.vault });
    }
  }
  // --- Error mapping -------------------------------------------------------

  app.notFound((c) => {
    const requestId = c.get('requestId');
    return c.json(apiErrorBody('not_found', 'resource not found', requestId), 404);
  });

  app.onError((err, c) => {
    const requestId = c.get('requestId');
    if (err instanceof ZodError) {
      return c.json(
        apiErrorBody(
          'validation_failed',
          err.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
          requestId,
        ),
        400,
      );
    }
    if (err instanceof WebError) {
      if (err.status >= 500) {
        c.get('logger').error({ err }, 'request failed');
      }
      return c.json(
        apiErrorBody(err.code, err.expose ? err.message : 'internal error', requestId),
        err.status as ContentfulStatusCode,
      );
    }
    c.get('logger').error({ err }, 'unhandled request failure');
    return c.json(apiErrorBody('internal_error', 'internal error', requestId), 500);
  });

  return app;
}

export type { AppEnv };
export { WebError };
