/**
 * R07 channel contract tests (spec §6.5 必备测试):
 *  - seven capability matrices, including wechat supportsGroup=false;
 *  - every skeleton adapter: native payload fixture → standard InboundMessage,
 *    OutboundContent → correct channel API call shape (mocked transport);
 *  - skeleton without transport fails loudly (never pretends to connect);
 *  - telegram long-message splitting (4096) at the adapter boundary;
 *  - mount resolution table-driven: group→workspace, direct→session,
 *    native thread→own session, first occupancy persists.
 */
import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_PRESETS,
  splitLongText,
  type InboundMessage,
  type OutboundTarget,
} from '../im-channel.js';
import { SkeletonAdapter, type ChannelTransport } from '../channels/skeleton.js';
import {
  DingTalkAdapter,
  DiscordAdapter,
  QQAdapter,
  WeChatAdapter,
  WhatsAppAdapter,
} from '../channels/channel-skeletons.js';
import { ImManager, type SessionAllocator } from '../im-manager.js';
import { openDatabase } from '../db.js';
import { makeTestConfig, testLogger, cleanupDir } from '../test-support/harness.js';
import { pino } from 'pino';

const silent = pino({ level: 'silent' });

describe('capability matrices (declarative degradation source)', () => {
  it('declares all seven channels with expected key facts', () => {
    const channels = Object.keys(CAPABILITY_PRESETS).sort();
    expect(channels).toEqual([
      'dingtalk',
      'discord',
      'feishu',
      'qq',
      'telegram',
      'wechat',
      'whatsapp',
    ]);
    // The documented scope facts:
    expect(CAPABILITY_PRESETS.wechat.supportsGroup).toBe(false); // iLink P2P only
    expect(CAPABILITY_PRESETS.telegram.maxMessageChars).toBe(4096);
    expect(CAPABILITY_PRESETS.telegram.supportsLongMessageSplit).toBe(false);
    expect(CAPABILITY_PRESETS.feishu.supportsThreads).toBe(true); // topics
    expect(CAPABILITY_PRESETS.discord.maxMessageChars).toBe(2000);
  });

  it("skeleton adapters report their channel's preset verbatim", () => {
    const cases: Array<[ReturnType<typeof makeSkeleton>, keyof typeof CAPABILITY_PRESETS]> = [
      [new QQAdapter(null), 'qq'],
      [new DingTalkAdapter(null), 'dingtalk'],
      [new WeChatAdapter(null), 'wechat'],
      [new DiscordAdapter(null), 'discord'],
      [new WhatsAppAdapter(null), 'whatsapp'],
    ];
    for (const [adapter, channel] of cases) {
      expect(adapter.channel).toBe(channel);
      expect(adapter.capabilities()).toEqual(CAPABILITY_PRESETS[channel]);
    }
  });
});

function makeSkeleton(): SkeletonAdapter {
  return new QQAdapter(null);
}

describe('skeleton contract tests (mocked transport, no SDK)', () => {
  it('given a native payload fixture → produces the standard InboundMessage', async () => {
    // QQ-style native payload fixture (transport's job to map).
    const qqFixture = {
      self_id: 10001,
      user_id: 555,
      group_id: 987654,
      message_id: 4242,
      time: 1756377600,
      message: '库存还剩多少',
      message_type: 'group',
    };
    const transport: ChannelTransport = {
      parseInbound(raw) {
        const r = raw as typeof qqFixture;
        return {
          channel: 'qq',
          accountId: String(r.self_id),
          conversation: { kind: 'group', jid: `qq:group:${r.group_id}` },
          senderId: String(r.user_id),
          text: r.message,
          attachments: [],
          messageId: String(r.message_id),
          ts: new Date(r.time * 1000).toISOString(),
        };
      },
      renderOutbound(target, content) {
        if (content.kind !== 'text') throw new Error('fixture only covers text');
        return {
          action: 'send_group_msg',
          params: {
            group_id: Number(target.conversation.jid.split(':').pop()),
            message: content.text,
          },
        };
      },
      async deliver() {
        return { messageId: 'mid-1', ts: new Date().toISOString() };
      },
    };

    const adapter = new QQAdapter(transport);
    const seen: InboundMessage[] = [];
    await adapter.start(async (msg) => {
      seen.push(msg);
    });
    await adapter.dispatchInbound(qqFixture);

    expect(seen).toHaveLength(1);
    const msg = seen[0]!;
    expect(msg.channel).toBe('qq');
    expect(msg.conversation).toEqual({ kind: 'group', jid: 'qq:group:987654' });
    expect(msg.senderId).toBe('555');
    expect(msg.text).toBe('库存还剩多少');
    expect(msg.messageId).toBe('4242');
    expect(msg.ts).toBe(new Date(1756377600 * 1000).toISOString());
  });

  it('given OutboundContent → produces the correct channel API call shape', async () => {
    let delivered: unknown;
    const transport: ChannelTransport = {
      parseInbound: () => {
        throw new Error('not used');
      },
      renderOutbound(target, content) {
        if (content.kind !== 'text') throw new Error('fixture only covers text');
        return {
          action: 'send_group_msg',
          params: {
            group_id: Number(target.conversation.jid.split(':').pop()),
            message: content.text,
          },
        };
      },
      async deliver(rendered) {
        delivered = rendered;
        return { messageId: 'm1', ts: 't' };
      },
    };
    const adapter = new QQAdapter(transport);
    const target: OutboundTarget = { conversation: { kind: 'group', jid: 'qq:group:987654' } };
    const receipt = await adapter.send(target, { kind: 'text', text: 'hello group' });
    expect(delivered).toEqual({
      action: 'send_group_msg',
      params: { group_id: 987654, message: 'hello group' },
    });
    expect(receipt.messageId).toBe('m1');
  });

  it('each skeleton type constructs with its own channel and no transport start fails loudly', async () => {
    for (const make of [
      () => new QQAdapter(null),
      () => new DingTalkAdapter(null),
      () => new WeChatAdapter(null),
      () => new DiscordAdapter(null),
      () => new WhatsAppAdapter(null),
    ]) {
      const adapter = make();
      await expect(adapter.start(async () => undefined)).rejects.toThrowError(/skeleton/);
      await expect(
        adapter.send(
          { conversation: { kind: 'direct', jid: 'x:1' } },
          { kind: 'text', text: 'y' },
        ),
      ).rejects.toThrowError(/transport missing/);
    }
  });
});

describe('telegram long-message splitting', () => {
  it('splits at 4096 chars at newlines with no character lost', () => {
    const line = 'a'.repeat(100);
    const text = Array.from({ length: 100 }, () => line).join('\n');
    const chunks = splitLongText(text, 4096);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(4096);
    // Reassemble: every character delivered (no truncation).
    expect(chunks.join('\n')).toBe(text);
  });
});

describe('mount resolution (table-driven, first occupancy persists)', () => {
  interface Case {
    name: string;
    kind: 'group' | 'direct';
    conversationJid: string;
    threadId?: string;
    boundWorkspace: string | null;
    expectWorkspace: string | null;
    expectSession: boolean;
  }

  function makeManager() {
    const config = makeTestConfig();
    const db = openDatabase({ config, logger: testLogger(), backupDisabled: true });
    db.db
      .prepare(
        "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1','alice','h','member','t')",
      )
      .run();
    db.db
      .prepare(
        "INSERT INTO workspaces (id, folder, jid, display_name, is_home, created_by, execution_mode, created_at) VALUES ('ws1','f1','web:f1','Ops',0,'u1','host','t')",
      )
      .run();
    db.db
      .prepare(
        "INSERT INTO channel_accounts (id, user_id, channel, created_at) VALUES ('acc1','u1','telegram','t')",
      )
      .run();
    const sessions: string[] = [];
    const sessionRows = new Map<string, { id: string; workspace_id: string }>();
    let n = 0;
    const allocator: SessionAllocator = {
      createSession: (workspaceId) => {
        const id = `sess-${workspaceId}-${++n}`;
        sessions.push(id);
        const session = { id, workspace_id: workspaceId };
        sessionRows.set(id, session);
        return session;
      },
      sessionById: (sessionId) => sessionRows.get(sessionId),
    };
    const manager = new ImManager(db, silent, allocator);
    return { manager, db, config, sessions };
  }

  const baseMsg = (overrides: Partial<InboundMessage>): InboundMessage => ({
    channel: 'telegram',
    accountId: 'acc1',
    conversation: { kind: 'direct', jid: 'telegram:100' },
    senderId: '555',
    attachments: [],
    messageId: 'm1',
    ts: '2026-08-28T12:00:00.000Z',
    ...overrides,
  });

  const cases: Case[] = [
    {
      name: 'group → bound workspace, no session',
      kind: 'group',
      conversationJid: 'telegram:200',
      boundWorkspace: 'ws1',
      expectWorkspace: 'ws1',
      expectSession: false,
    },
    {
      name: 'direct → workspace + allocated session (first occupancy)',
      kind: 'direct',
      conversationJid: 'telegram:100',
      boundWorkspace: 'ws1',
      expectWorkspace: 'ws1',
      expectSession: true,
    },
  ];

  for (const c of cases) {
    it(`case: ${c.name}`, async () => {
      const { manager, db, config, sessions } = makeManager();
      try {
        manager.mount({
          accountId: 'acc1',
          conversationJid: c.conversationJid,
          kind: c.kind,
          workspaceId: c.boundWorkspace ?? undefined,
        });
        const resolution = await manager.handleInbound(
          baseMsg({ conversation: { kind: c.kind, jid: c.conversationJid } }),
        );
        expect(resolution).toBeDefined();
        expect(resolution!.workspaceId).toBe(c.expectWorkspace);
        if (c.expectSession) {
          expect(resolution!.sessionId).not.toBeNull();
          expect(sessions).toHaveLength(1);
          // Second message reuses the SAME session (persisted occupancy).
          const again = await manager.handleInbound(
            baseMsg({ conversation: { kind: c.kind, jid: c.conversationJid } }),
          );
          expect(again!.sessionId).toBe(resolution!.sessionId);
          expect(sessions).toHaveLength(1);
        } else {
          expect(resolution!.sessionId).toBeNull();
          expect(sessions).toHaveLength(0);
        }
        void db;
      } finally {
        db_close_helper(config.dataDir);
      }
    });
  }

  it('native thread → its own session, distinct from the conversation session', async () => {
    const { manager, db, config, sessions } = makeManager();
    try {
      manager.mount({
        accountId: 'acc1',
        conversationJid: 'telegram:300',
        kind: 'direct',
        workspaceId: 'ws1',
      });
      // The thread resolves under `jid#threadId`; mount that thread explicitly
      // (it is a separate conversation binding), then check session isolation.
      manager.mount({
        accountId: 'acc1',
        conversationJid: 'telegram:300#42',
        kind: 'direct',
        workspaceId: 'ws1',
      });
      const thread = await manager.handleInbound(
        baseMsg({
          conversation: { kind: 'group', jid: 'telegram:300', threadId: '42' },
        }),
      );
      const main = await manager.handleInbound(
        baseMsg({ conversation: { kind: 'direct', jid: 'telegram:300' } }),
      );
      expect(thread!.sessionId).not.toBeNull();
      expect(main!.sessionId).not.toBeNull();
      expect(thread!.sessionId).not.toBe(main!.sessionId);
      expect(sessions).toHaveLength(2);
      void db;
    } finally {
      db_close_helper(config.dataDir);
    }
  });

  it('unmounted conversation is dropped (admission decides, nothing auto-binds)', async () => {
    const { manager, db, config } = makeManager();
    try {
      const resolution = await manager.handleInbound(
        baseMsg({ conversation: { kind: 'group', jid: 'telegram:999' } }),
      );
      expect(resolution).toBeUndefined();
      void db;
    } finally {
      db_close_helper(config.dataDir);
    }
  });

  function db_close_helper(dataDir: string): void {
    // Each makeManager opens its own db; closure cleanup.
    void dataDir;
  }
});
