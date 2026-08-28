/**
 * Server assembly: open DB (migrations run here) → build Hono app → listen →
 * attach WS hub. Returns a handle so tests and index.ts share one boot path;
 * src/index.ts is only env wiring around this module.
 */
import type { Server } from 'node:http';
import { serve, type ServerType } from '@hono/node-server';
import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import { createLogger } from './logger.js';
import { openDatabase, AppDb } from './db.js';
import { createApp, type ServerDeps } from './web.js';
import { WsHub, type WsAuthenticator } from './ws.js';

export interface StartOptions {
  config: AppConfig;
  /** Test seam: inject an open database (skips migration on this path). */
  db?: AppDb;
  logger?: Logger;
  wsAuthenticator?: WsAuthenticator;
}

export interface RunningServer {
  config: AppConfig;
  db: AppDb;
  logger: Logger;
  app: ReturnType<typeof createApp>;
  ws: WsHub;
  port: number;
  /** Graceful shutdown: WS close → HTTP close → DB close. Idempotent. */
  stop(): Promise<void>;
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const { config } = opts;
  const logger = opts.logger ?? createLogger({ config });
  const db = opts.db ?? openDatabase({ config, logger });

  const deps: ServerDeps = { config, db, logger };
  const app = createApp(deps);

  // serve() creates the underlying node server; its returned handle IS that
  // server (ServerType extends Server), so the WS hub attaches to it directly.
  const server: ServerType = serve({
    fetch: app.fetch,
    hostname: config.HOST,
    port: config.PORT,
  });

  const ws = new WsHub(
    { config, logger, authenticator: opts.wsAuthenticator },
    logger.child({ component: 'ws' }),
  );
  ws.attach(server);

  await onceListening(server as unknown as Server);

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.PORT;
  logger.info({ host: config.HOST, port }, 'server listening');

  let stopping = false;
  return {
    config,
    db,
    logger,
    app,
    ws,
    port,
    stop: async () => {
      if (stopping) return;
      stopping = true;
      await ws.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Undici keep-alive sockets in tests would hold close() open forever.
        (server as unknown as Server).closeAllConnections();
      });
      db.close();
      logger.info('server stopped');
    },
  };
}

function onceListening(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onListening = () => {
      cleanup();
      resolve();
    };
    const cleanup = () => {
      server.off('error', onError);
      server.off('listening', onListening);
    };
    server.once('error', onError);
    server.once('listening', onListening);
  });
}

/** Signal handling lives in index.ts, not here: tests start servers without installing handlers. */
export function installSignalHandlers(
  getServer: () => Promise<RunningServer> | RunningServer,
  logger: Logger,
): void {
  let running: RunningServer | undefined;
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    try {
      running = await getServer();
      await running.stop();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}
