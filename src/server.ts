/**
 * Server assembly: open DB (migrations run here) → build service graph →
 * construct WS hub → build Hono app (routes use the services) → listen →
 * attach hub + WS chat wiring. Returns a handle shared by tests and index.ts.
 */
import type { Server } from 'node:http';
import { serve, type ServerType } from '@hono/node-server';
import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import { createLogger } from './logger.js';
import { openDatabase, AppDb } from './db.js';
import { createApp, type ServerDeps, type AppServices } from './web.js';
import { WsHub, type WsAuthenticator } from './ws.js';
import { AuthService } from './auth.js';
import { LoginRateLimiter } from './rate-limit.js';
import { UserStore } from './stores/users.js';
import { WorkspaceStore } from './stores/workspaces.js';
import { AgentProfileStore } from './stores/agent-profiles.js';
import { AgentRuntime, toStreamEventEnvelope, type TurnExecutor } from './agent-runtime.js';
import { buildSystemPrompt } from './prompt-plan.js';
import { TaskStore } from './stores/tasks.js';
import { TaskScheduler } from './task-scheduler.js';
import { wsSessionAuthenticator } from './auth-context.js';
import { canAccessGroup } from './rbac.js';

export interface StartOptions {
  config: AppConfig;
  /** Test seam: inject an open database (skips migration on this path). */
  db?: AppDb;
  logger?: Logger;
  /** Test seam: override the WS upgrade authenticator. */
  wsAuthenticator?: WsAuthenticator;
  /** Test seam: replace the SDK turn executor while assembling the runtime. */
  executeTurn?: TurnExecutor;
  /** Test seam: replace the task-run executor (defaults to the runtime). */
  taskExecutor?: (
    run: Parameters<TaskScheduler['runClaimed']>[0],
    task: unknown,
  ) => Promise<string>;
  /** Test seam: don't auto-start the scheduler pump loop (tests drive pumps manually). */
  schedulerAutoStart?: boolean;
}

export interface RunningServer {
  config: AppConfig;
  db: AppDb;
  logger: Logger;
  app: ReturnType<typeof createApp>;
  ws: WsHub;
  services: AppServices;
  port: number;
  /** Graceful shutdown: WS close → HTTP close → DB close. Idempotent. */
  stop(): Promise<void>;
}

export async function startServer(opts: StartOptions): Promise<RunningServer> {
  const { config } = opts;
  const logger = opts.logger ?? createLogger({ config });
  const db = opts.db ?? openDatabase({ config, logger });

  // ---- service graph ------------------------------------------------------
  const authService = new AuthService(db, config, logger.child({ component: 'auth' }));
  const userStore = new UserStore(db);
  const workspaceStore = new WorkspaceStore(db);
  const profileStore = new AgentProfileStore(db);
  const rateLimiter = new LoginRateLimiter(
    config.AUTH_MAX_ATTEMPTS,
    config.AUTH_LOCKOUT_MINUTES * 60_000,
  );
  const runtime = new AgentRuntime({
    db,
    logger: logger.child({ component: 'agent-runtime' }),
    apiKey: process.env.ANTHROPIC_API_KEY,
    executeTurn: opts.executeTurn,
  });

  // ---- R14 scheduler -------------------------------------------------------
  // Task execution lands on the same runtime path as chat turns: an isolated
  // context gets a fresh session, a group context reuses the workspace's most
  // recent session. Without an API key the turn fails loudly (error event) —
  // the run row then records the failure, never a fake success.
  const taskStore = new TaskStore(db);
  const scheduler = new TaskScheduler({
    db,
    logger: logger.child({ component: 'task-scheduler' }),
    executeRun: opts.taskExecutor
      ? async (run, task) => opts.taskExecutor!(run, task)
      : async (run, task) => {
          const session =
            task.context_mode === 'group'
              ? (runtime.sessionsForWorkspace(task.workspace_id).at(-1) ??
                runtime.createSession({ workspaceId: task.workspace_id }))
              : runtime.createSession({ workspaceId: task.workspace_id });
          let finalText = '';
          await runtime.sendMessage(session, task.prompt, (event) => {
            if (event.type === 'assistant_text') finalText += event.text;
          });
          return finalText;
        },
  });

  // The WS hub exists before the app so the chat frame handler can reach the
  // runtime; routes hold the same hub for stream fan-out.
  const wsHub = new WsHub(
    {
      config,
      logger,
      authenticator: opts.wsAuthenticator ?? wsSessionAuthenticator(authService),
      onChat: (userId, { sessionId, content }) => {
        const session = runtime.sessionById(sessionId);
        if (session === undefined) {
          logger.warn({ userId, sessionId }, 'chat frame for unknown session dropped');
          return;
        }
        const wsRow = workspaceStore.byId(session.workspace_id);
        if (wsRow === undefined) return;
        const actor = userStore.byId(userId);
        if (actor === undefined) return;
        // Same ownership gate as the HTTP surface: a foreign workspace's
        // session executes nothing (R20), and no reply leaks the refusal.
        if (
          canAccessGroup(
            { id: actor.id, role: actor.role },
            wsRow,
            workspaceStore.resolveSiblingHome,
          ) !== 'allow'
        ) {
          logger.debug({ userId, sessionId }, 'chat frame denied by RBAC');
          return;
        }
        const profile = session.profile_id
          ? profileStore.byId(session.profile_id)
          : profileStore.defaultFor(actor.id);
        const opts = {
          systemPrompt: profile !== undefined ? buildSystemPrompt(profile) : undefined,
        };
        void runtime.sendMessage(
          session,
          content,
          (event) => {
            wsHub.broadcastToUser(userId, toStreamEventEnvelope(event));
          },
          opts,
        );
      },
    },
    logger.child({ component: 'ws' }),
  );

  const services: AppServices = {
    authService,
    userStore,
    workspaceStore,
    profileStore,
    rateLimiter,
    runtime,
    wsHub,
    taskStore,
    scheduler,
  };

  const deps: ServerDeps = { config, db, logger, services };
  const app = createApp(deps);

  // serve() creates the underlying node server; its returned handle IS that
  // server (ServerType extends Server), so the WS hub attaches to it directly.
  const server: ServerType = serve({
    fetch: app.fetch,
    hostname: config.HOST,
    port: config.PORT,
  });
  wsHub.attach(server);

  await onceListening(server as unknown as Server);

  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.PORT;
  logger.info({ host: config.HOST, port }, 'server listening');

  // Startup recovery + pump loop. Tests that drive pumps manually disable the
  // auto-start; recovery (releasing dead claims) is unconditional.
  scheduler.recoverOnStart();
  if (opts.schedulerAutoStart !== false) scheduler.start();

  let stopping = false;
  return {
    config,
    db,
    logger,
    app,
    ws: wsHub,
    services,
    port,
    stop: async () => {
      if (stopping) return;
      stopping = true;
      scheduler.stop();
      await wsHub.close();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        // Undici keep-alive sockets in tests would hold close() open forever.
        (server as unknown as Server).closeAllConnections();
      });
      services.rateLimiter.stop();
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
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutting down');
    try {
      const running = await getServer();
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
