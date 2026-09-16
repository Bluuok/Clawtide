/**
 * ImManager — the adapter registry + mount resolution (spec §6.5 items 1, 5).
 *
 * The core never sees channel SDKs: inbound arrives as InboundMessage, the
 * manager resolves it to a workspace/session through channel_mounts, and
 * outbound goes back through the originating adapter. Conversation binding
 * rules (CLAUDE.md §6.2/§6.3 as mirrored by the spec):
 *   group chat  → Workspace (several groups may bind the same workspace)
 *   direct chat → a dedicated Runtime Session
 *   native thread (feishu topic / telegram forum) → its own Session
 * First occupancy persists the session id; later replies reuse that context.
 */
import type { AppDb } from './db.js';
import type { Logger } from 'pino';
import { randomBytes } from 'node:crypto';
import type {
  ChannelId,
  ImChannelAdapter,
  InboundMessage,
  OutboundContent,
  OutboundTarget,
  SendReceipt,
} from './im-channel.js';

export interface ChannelMountRow {
  id: string;
  account_id: string;
  conversation_jid: string;
  kind: 'group' | 'direct';
  target_workspace_id: string | null;
  target_session_id: string | null;
}

export interface MountResolution {
  kind: 'group' | 'direct';
  workspaceId: string | null;
  /** Direct chats and native threads resolve to a stable session id. */
  sessionId: string | null;
  mountId: string;
}

export interface SessionAllocator {
  createSession(workspaceId: string): { id: string; workspace_id?: string };
  sessionById(sessionId: string): { id: string; workspace_id: string } | undefined;
}

export class ImManager {
  private readonly adapters = new Map<string, ImChannelAdapter>();

  constructor(
    private readonly db: AppDb,
    private readonly logger: Logger,
    private readonly sessions: SessionAllocator,
  ) {}

  register(accountId: string, adapter: ImChannelAdapter): void {
    this.adapters.set(this.adapterKey(adapter.channel, accountId), adapter);
  }

  adapter(channel: ChannelId, accountId: string): ImChannelAdapter | undefined {
    return this.adapters.get(this.adapterKey(channel, accountId));
  }

  /** Registered adapters (smoke/diagnostic iteration over the registry). */
  adaptersSnapshot(): Array<[ChannelId, string, ImChannelAdapter]> {
    return [...this.adapters.entries()].map(([key, adapter]) => [
      adapter.channel,
      key.slice(adapter.channel.length + 1),
      adapter,
    ]);
  }

  registeredChannels(): ChannelId[] {
    return [...this.adapters.values()].map((adapter) => adapter.channel);
  }

  /** Start every registered adapter; inbound flows into handleInbound. */
  async startAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.start(async (msg) => {
        await this.handleInbound(msg);
      });
    }
  }

  async stopAll(): Promise<void> {
    for (const adapter of this.adapters.values()) {
      await adapter.stop();
    }
  }

  /** Mount a conversation to a target. Group → workspace; direct → session. */
  mount(params: {
    accountId: string;
    conversationJid: string;
    kind: 'group' | 'direct';
    workspaceId?: string;
    sessionId?: string;
  }): ChannelMountRow {
    const id = randomBytes(16).toString('hex');
    this.db.db
      .prepare(
        `INSERT INTO channel_mounts (id, account_id, conversation_jid, kind, target_workspace_id, target_session_id)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, conversation_jid) DO UPDATE SET
           kind = excluded.kind,
           target_workspace_id = excluded.target_workspace_id,
           target_session_id = excluded.target_session_id`,
      )
      .run(
        id,
        params.accountId,
        params.conversationJid,
        params.kind,
        params.workspaceId ?? null,
        params.sessionId ?? null,
      );
    return this.mountByAccountAndJid(params.accountId, params.conversationJid)!;
  }

  mountByAccountAndJid(accountId: string, jid: string): ChannelMountRow | undefined {
    return this.db.db
      .prepare('SELECT * FROM channel_mounts WHERE account_id = ? AND conversation_jid = ?')
      .get(accountId, jid) as ChannelMountRow | undefined;
  }

  /**
   * Mount resolution + first-occupancy persistence. An unbound conversation
   * is dropped with a warning (admission chain decides; nothing auto-binds).
   */
  resolveMount(msg: InboundMessage): MountResolution | undefined {
    const account = this.db.db
      .prepare('SELECT id, user_id, channel FROM channel_accounts WHERE id = ?')
      .get(msg.accountId) as { id: string; user_id: string; channel: string } | undefined;
    if (account === undefined || account.channel !== msg.channel) {
      this.logger.warn(
        { channel: msg.channel, accountId: msg.accountId },
        'unknown channel account',
      );
      return undefined;
    }
    const jid = this.conversationKey(msg);
    const existing = this.mountByAccountAndJid(msg.accountId, jid);
    if (existing === undefined) {
      this.logger.warn({ channel: msg.channel, jid }, 'conversation not mounted; dropped');
      return undefined;
    }
    if (existing.kind === 'group') {
      return {
        kind: 'group',
        workspaceId: existing.target_workspace_id,
        sessionId: null,
        mountId: existing.id,
      };
    }
    // Direct (or thread) conversation: resolve-or-create the session once,
    // then persist it so later messages reuse the same runtime context.
    let sessionId = existing.target_session_id;
    if (sessionId !== null) {
      const session = this.sessions.sessionById(sessionId);
      if (
        session === undefined ||
        existing.target_workspace_id === null ||
        session.workspace_id !== existing.target_workspace_id
      ) {
        this.logger.warn(
          { mountId: existing.id, sessionId },
          'mounted session mismatch; dropped',
        );
        return undefined;
      }
    } else {
      const workspaceId = existing.target_workspace_id;
      if (workspaceId === null) {
        this.logger.warn({ mountId: existing.id }, 'direct mount without workspace; dropped');
        return undefined;
      }
      sessionId = this.sessions.createSession(workspaceId).id;
      this.db.db
        .prepare('UPDATE channel_mounts SET target_session_id = ? WHERE id = ?')
        .run(sessionId, existing.id);
    }
    return {
      kind: 'direct',
      workspaceId: existing.target_workspace_id,
      sessionId,
      mountId: existing.id,
    };
  }

  /** Read a mount without allocating a session (used before RBAC admission). */
  mountForMessage(msg: InboundMessage): ChannelMountRow | undefined {
    return this.mountByAccountAndJid(msg.accountId, this.conversationKey(msg));
  }

  /** Entry point wired into every adapter's start(). */
  async handleInbound(msg: InboundMessage): Promise<MountResolution | undefined> {
    const resolution = this.resolveMount(msg);
    return resolution;
  }

  async send(
    channel: ChannelId,
    accountId: string,
    target: OutboundTarget,
    content: OutboundContent,
  ): Promise<SendReceipt> {
    const adapter = this.adapter(channel, accountId);
    if (adapter === undefined) {
      throw new Error(`channel ${channel} account ${accountId} not registered`);
    }
    return adapter.send(target, content);
  }

  private adapterKey(channel: ChannelId, accountId: string): string {
    return `${channel}:${accountId}`;
  }

  private conversationKey(msg: InboundMessage): string {
    return msg.conversation.threadId !== undefined
      ? `${msg.conversation.jid}#${msg.conversation.threadId}`
      : msg.conversation.jid;
  }
}
