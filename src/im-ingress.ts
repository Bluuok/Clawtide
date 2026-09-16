/**
 * IM admission chain (spec §4 data-flow): adapter.onMessage → admission
 * (Owner Gate / audience_mode) → mount resolution → agent turn on the same
 * runtime path as web/scheduler → outbound reply through the originating
 * adapter. One module so the whole chain is reviewable in one place.
 *
 * Owner Gate semantics: a mismatched sender is refused WITHOUT any reply —
 * no receipt, no error — so the gate cannot be probed. owner_im_id lives on
 * the channel account (cross-channel identity is deliberately NOT unified).
 */
import type { AppDb } from './db.js';
import type { Logger } from 'pino';
import { ImManager, type SessionAllocator } from './im-manager.js';
import { checkOwnerGate, type AudienceMode } from './owner-gate.js';
import type { AgentRuntime } from './agent-runtime.js';
import type { AgentSessionRow } from './stores/agent-sessions.js';
import { buildSystemPrompt } from './prompt-plan.js';
import { toStreamEventEnvelope } from './agent-runtime.js';
import type { WsHub } from './ws.js';
import { canAccessGroup, type WorkspaceResource } from './rbac.js';
import type { AgentProfileStore } from './stores/agent-profiles.js';

interface ChannelAccountRow {
  id: string;
  user_id: string;
  channel: string;
  owner_im_id: string | null;
  default_workspace_id: string | null;
}

export interface ImIngressDeps {
  db: AppDb;
  logger: Logger;
  manager: ImManager;
  runtime: AgentRuntime;
  profileStore: AgentProfileStore;
  workspaceStore: {
    byId(id: string): WorkspaceResource | undefined;
  };
  wsHub: WsHub;
  /** Resolves a conversation's audience mode; default = everyone. */
  audienceMode?: (account: ChannelAccountRow) => AudienceMode;
}

export class ImIngress {
  constructor(private readonly deps: ImIngressDeps) {}

  /**
   * The single entry wired into every adapter's onInbound. Order is the spec's
   * admission chain: account lookup → Owner Gate → mount → RBAC → turn → reply.
   */
  async handleInbound(msg: Parameters<ImManager['handleInbound']>[0]): Promise<void> {
    const { db, logger, manager, runtime } = this.deps;
    const log = logger.child({ component: 'im-ingress', channel: msg.channel });

    const account = db.db
      .prepare('SELECT * FROM channel_accounts WHERE id = ?')
      .get(msg.accountId) as ChannelAccountRow | undefined;
    if (account === undefined) {
      log.warn({ accountId: msg.accountId }, 'unknown channel account; dropped');
      return;
    }
    if (account.channel !== msg.channel) {
      log.warn(
        { accountId: msg.accountId, accountChannel: account.channel },
        'channel mismatch; dropped',
      );
      return;
    }

    // Owner Gate before anything else: destructive commands always require the
    // owner; regular traffic depends on the audience mode. Silent drop — no
    // reply, no error surface.
    const mode = this.deps.audienceMode?.(account) ?? 'everyone';
    const command = msg.text;
    const verdict = checkOwnerGate({
      senderId: msg.senderId,
      ownerImId: account.owner_im_id,
      audienceMode: mode,
      ...(command !== undefined ? { command } : {}),
    });
    if (verdict.action === 'silent_drop') {
      log.debug({ reason: verdict.reason, senderId: msg.senderId }, 'owner gate dropped');
      return;
    }

    // Inspect the persisted mount before session allocation so invalid or
    // foreign bindings cannot create a runtime session as a side effect.
    const mounted = manager.mountForMessage(msg);
    if (mounted === undefined) {
      log.warn({ accountId: msg.accountId }, 'conversation not mounted; dropped');
      return;
    }
    const workspaceId = mounted.target_workspace_id;
    if (workspaceId === null) {
      log.warn({ mountId: mounted.id }, 'mount without workspace; dropped');
      return;
    }
    const wsRow = this.deps.workspaceStore.byId(workspaceId);
    if (wsRow === undefined) {
      log.warn({ workspaceId }, 'mount target workspace missing; dropped');
      return;
    }
    // The account's owning user acts through this workspace only if RBAC
    // allows; a foreign binding executes nothing (same gate as web surface).
    const actor = db.db
      .prepare('SELECT id, username, role FROM users WHERE id = ?')
      .get(account.user_id) as { id: string; role: 'admin' | 'member' } | undefined;
    if (
      actor === undefined ||
      canAccessGroup(actor, wsRow, resolveSiblingHome(db, wsRow.folder)) !== 'allow'
    ) {
      log.debug({ userId: account.user_id, workspaceId }, 'workspace RBAC denied; silent');
      return;
    }

    const resolution = await manager.handleInbound(msg);
    if (resolution === undefined || resolution.workspaceId !== workspaceId) return;

    // Session: direct/thread mounts carry a persisted one; group mounts use
    // the workspace's most recent session, creating one when none exists
    // (same convention as scheduled group runs).
    const session = this.resolveSession(resolution.sessionId, workspaceId);
    if (session === undefined) {
      log.error({ workspaceId }, 'session resolution failed; dropped');
      return;
    }

    const profile =
      session.profile_id !== null
        ? this.deps.profileStore.byIdFor(account.user_id, session.profile_id)
        : undefined;
    if (session.profile_id !== null && profile === undefined) {
      log.debug({ sessionId: session.id }, 'session profile denied; dropped');
      return;
    }
    const systemPrompt =
      profile !== undefined
        ? buildSystemPrompt({ ...profile, prompt_mode: profile.prompt_mode })
        : undefined;

    let finalText = '';
    await runtime.sendMessage(
      session,
      msg.text ?? '',
      (event) => {
        if (event.type === 'assistant_text') finalText += event.text;
        if (event.type === 'error') finalText += `\n[error] ${event.message}`;
        // Mirror the web surface: stream the turn to the account owner's console.
        this.deps.wsHub.broadcastToUser(account.user_id, toStreamEventEnvelope(event));
      },
      { ...(systemPrompt !== undefined ? { systemPrompt } : {}) },
    );

    // Outbound delivery back through the originating adapter. Group mounts
    // bound to an IM workspace reply into the inbound conversation (the
    // workspace jid for IM groups IS the conversation jid); web-bound groups
    // and direct chats reply where the message came from.
    const replyJid =
      resolution.kind === 'group' && !wsRow.jid.startsWith('web:')
        ? wsRow.jid
        : msg.conversation.jid;
    if (finalText.trim().length > 0) {
      try {
        await manager.send(
          msg.channel,
          msg.accountId,
          {
            conversation: {
              kind: msg.conversation.kind,
              jid: replyJid,
              ...(msg.conversation.threadId !== undefined
                ? { threadId: msg.conversation.threadId }
                : {}),
            },
          },
          { kind: 'text', text: finalText },
        );
      } catch (err) {
        log.error(
          { err, channel: msg.channel, accountId: msg.accountId },
          'outbound reply failed',
        );
      }
    }
  }

  /** Direct/thread mounts carry a session id; group mounts reuse-or-create. */
  private resolveSession(
    sessionId: string | null,
    workspaceId: string,
  ): AgentSessionRow | undefined {
    const { runtime } = this.deps;
    if (sessionId !== null) {
      const session = runtime.sessionById(sessionId);
      return session?.workspace_id === workspaceId ? session : undefined;
    }
    const existing = runtime.sessionsForWorkspace(workspaceId).at(-1);
    return existing ?? runtime.createSession({ workspaceId });
  }
}

function resolveSiblingHome(db: AppDb, folder: string): (f: string) => string | null {
  return (f: string) => {
    const row = db.db
      .prepare(
        'SELECT created_by FROM workspaces WHERE folder = ? AND is_home = 1 AND created_by IS NOT NULL LIMIT 1',
      )
      .get(f) as { created_by: string } | undefined;
    return row?.created_by ?? null;
  };
}

/** SessionAllocator backed by the runtime (first-occupancy persistence). */
export function runtimeSessionAllocator(runtime: AgentRuntime): SessionAllocator {
  return {
    createSession: (workspaceId: string) => runtime.createSession({ workspaceId }),
    sessionById: (sessionId: string) => runtime.sessionById(sessionId),
  };
}
