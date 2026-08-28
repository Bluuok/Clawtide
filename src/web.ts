/**
 * Hono application assembly: middleware stack + route mounting. Transport
 * (listening socket, WS upgrade) lives in server.ts so tests can drive the
 * app directly.
 */
import { Hono } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { cors } from 'hono/cors';
import { secureHeaders } from 'hono/secure-headers';
import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import type { AppDb } from './db.js';
import { WebError, apiErrorBody } from './errors.js';
import { appVersion } from './version.js';
import type { HealthPayload } from '../shared/protocol.js';

export interface ServerDeps {
  config: AppConfig;
  db: AppDb;
  logger: Logger;
}

type AppEnv = {
  Variables: {
    requestId: string;
    logger: Logger;
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

  // --- Error mapping -------------------------------------------------------

  app.notFound((c) => {
    const requestId = c.get('requestId');
    return c.json(apiErrorBody('not_found', 'resource not found', requestId), 404);
  });

  app.onError((err, c) => {
    const requestId = c.get('requestId');
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
