/**
 * Chat route family: session management (create/resume/list) + transcript +
 * an HTTP fallback turn endpoint that streams to the caller's open WS
 * connections. The WebSocket `/ws` chat frame is the primary streaming path
 * (same handler wired by server.ts); this family covers the non-streaming
 * management surface and the equivalent HTTP turn for non-WS clients.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { WebError } from '../errors.js';
import type { AgentRuntime } from '../agent-runtime.js';
import type { AgentSessionRow } from '../stores/agent-sessions.js';
import type { AgentProfileStore } from '../stores/agent-profiles.js';
import type { WorkspaceStore } from '../stores/workspaces.js';
import { canAccessGroup } from '../rbac.js';
import { requireUser } from '../auth-context.js';
import { toStreamEventEnvelope } from '../agent-runtime.js';
import { buildSystemPrompt } from '../prompt-plan.js';
import type { WsHub } from '../ws.js';
import type { AppEnv } from '../web.js';
import type { Logger } from 'pino';

const createSessionSchema = z.object({
  workspaceId: z.string().min(1),
  profileId: z.string().min(1).optional(),
});
const turnSchema = z.object({ content: z.string().min(1).max(100_000) });

export interface ChatRoutesDeps {
  runtime: AgentRuntime;
  workspaceStore: WorkspaceStore;
  profileStore: AgentProfileStore;
  wsHub: WsHub;
  logger: Logger;
  /** Re-reads the layered provider config before each turn (settings chain). */
  refreshProvider?: () => void;
}

export function registerChatRoutes(app: Hono<AppEnv>, deps: ChatRoutesDeps): void {
  const { runtime, workspaceStore, profileStore, wsHub, logger, refreshProvider } = deps;

  const requireAccessibleWorkspace = (
    user: { id: string; role: 'admin' | 'member' },
    workspaceId: string,
  ) => {
    const ws = workspaceStore.byId(workspaceId);
    if (
      ws === undefined ||
      canAccessGroup(user, ws, workspaceStore.resolveSiblingHome) !== 'allow'
    ) {
      throw new WebError('not_found', 'workspace not found');
    }
    return ws;
  };

  const requireOwnSession = (
    user: { id: string; role: 'admin' | 'member' },
    sessionId: string,
  ) => {
    const session = runtime.sessionById(sessionId);
    if (session === undefined) throw new WebError('not_found', 'session not found');
    requireAccessibleWorkspace(user, session.workspace_id);
    return session;
  };

  app.post('/chat/sessions', async (c) => {
    const user = requireUser(c);
    const body = createSessionSchema.parse(await c.req.json());
    const ws = requireAccessibleWorkspace(user, body.workspaceId);
    // Profile defaults to the user's active default profile when not given.
    const profileId = body.profileId ?? profileStore.defaultFor(user.id)?.id;
    if (profileId !== undefined && profileStore.byIdFor(user.id, profileId) === undefined) {
      throw new WebError('not_found', 'profile not found');
    }
    const session = runtime.createSession({ workspaceId: ws.id, profileId });
    return c.json({ session: toSessionApi(session) }, 201);
  });

  app.get('/chat/sessions', (c) => {
    const user = requireUser(c);
    const sessions = [];
    for (const ws of workspaceStore.list()) {
      if (canAccessGroup(user, ws, workspaceStore.resolveSiblingHome) !== 'allow') continue;
      for (const session of runtime.sessionsForWorkspace(ws.id)) {
        sessions.push(toSessionApi(session));
      }
    }
    return c.json({ sessions });
  });

  app.get('/chat/sessions/:id/messages', (c) => {
    const user = requireUser(c);
    const session = requireOwnSession(user, c.req.param('id'));
    return c.json({
      session: toSessionApi(session),
      messages: runtime.messages(session.thread_id),
    });
  });

  /** HTTP turn: runs and streams to the caller's open WS connections. */
  app.post('/chat/sessions/:id/messages', async (c) => {
    const user = requireUser(c);
    const session = requireOwnSession(user, c.req.param('id'));
    const body = turnSchema.parse(await c.req.json());
    refreshProvider?.();
    const profile = session.profile_id
      ? profileStore.byIdFor(user.id, session.profile_id)
      : profileStore.defaultFor(user.id);
    if (session.profile_id !== null && profile === undefined) {
      throw new WebError('not_found', 'profile not found');
    }
    const opts = {
      systemPrompt: profile !== undefined ? buildSystemPrompt(profile) : undefined,
    };
    void runtime
      .sendMessage(
        session,
        body.content,
        (event) => {
          wsHub.broadcastToUser(user.id, toStreamEventEnvelope(event));
        },
        opts,
      )
      .catch((err) => {
        logger.error({ err, userId: user.id, sessionId: session.id }, 'http chat turn failed');
        const ts = new Date().toISOString();
        wsHub.broadcastToUser(
          user.id,
          toStreamEventEnvelope({
            type: 'error',
            sessionId: session.id,
            message: 'agent turn failed',
            ts,
          }),
        );
      });
    return c.json({ enqueued: true, sessionId: session.id });
  });
}

function toSessionApi(session: AgentSessionRow) {
  return {
    id: session.id,
    workspaceId: session.workspace_id,
    sdkSessionId: session.sdk_session_id,
    threadId: session.thread_id,
    profileId: session.profile_id,
    createdAt: session.created_at,
    updatedAt: session.updated_at,
  };
}
