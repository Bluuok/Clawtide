import { afterEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startServer, type RunningServer } from '../server.js';
import { ImManager } from '../im-manager.js';
import { ImIngress, runtimeSessionAllocator } from '../im-ingress.js';
import { AgentRuntime } from '../agent-runtime.js';
import { AgentProfileStore } from '../stores/agent-profiles.js';
import { WorkspaceStore } from '../stores/workspaces.js';
import type { WsHub } from '../ws.js';
import type {
  ChannelCapabilities,
  ImChannelAdapter,
  InboundMessage,
  OutboundContent,
  OutboundTarget,
  SendReceipt,
} from '../im-channel.js';
import { CAPABILITY_PRESETS } from '../im-channel.js';
import { openDatabase } from '../db.js';
import { cleanupDir, makeTestConfig, testLogger } from '../test-support/harness.js';

describe('PR security regressions', () => {
  const servers: RunningServer[] = [];
  afterEach(async () => {
    for (const server of servers.splice(0)) {
      await server.stop();
      cleanupDir(server.config.dataDir);
    }
  });

  it('rejects malformed WS frames and isolates sync/async handler failures', async () => {
    const calls: string[] = [];
    const server = await startServer({
      config: makeTestConfig(),
      logger: testLogger(),
      schedulerAutoStart: false,
      imAutoStart: false,
      wsAuthenticator: () => ({ ok: true, userId: 'u1', connectionId: 'security-ws' }),
      wsOnChat: (_userId, payload) => {
        calls.push(payload.content);
        if (payload.content === 'throw') throw new Error('sync failure');
        if (payload.content === 'reject') return Promise.reject(new Error('async failure'));
      },
    });
    servers.push(server);
    const client = await connect(server.port);
    await client.next();

    for (const bad of [
      null,
      [],
      { type: 'chat', content: 'missing session' },
      { type: 'chat', sessionId: 's1', content: 42 },
      { type: 'chat', sessionId: 's1', content: '' },
      { type: 'chat', sessionId: 's1', content: 'x', extra: true },
      { type: 'chat', sessionId: 's1', content: 'x'.repeat(100_001) },
      { type: 'ping', extra: true },
    ])
      client.ws.send(JSON.stringify(bad));

    client.ws.send(JSON.stringify({ type: 'ping' }));
    expect((await client.next()).type).toBe('pong');
    expect(calls).toEqual([]);

    client.ws.send(JSON.stringify({ type: 'chat', sessionId: 's1', content: 'throw' }));
    client.ws.send(JSON.stringify({ type: 'chat', sessionId: 's1', content: 'reject' }));
    await new Promise((resolve) => setTimeout(resolve, 25));
    client.ws.send(JSON.stringify({ type: 'ping' }));
    expect((await client.next()).type).toBe('pong');
    expect(calls).toEqual(['throw', 'reject']);
    client.ws.close();
  });

  it('keeps same-channel adapters isolated by account and never falls back', async () => {
    const config = makeTestConfig();
    const db = openDatabase({ config, logger: testLogger(), backupDisabled: true });
    const sent: string[] = [];
    const manager = new ImManager(db, testLogger(), {
      createSession: (workspaceId) => ({ id: 'new', workspace_id: workspaceId }),
      sessionById: () => undefined,
    });
    try {
      manager.register('account-b', fakeAdapter('b', sent));
      manager.register('account-a', fakeAdapter('a', sent));
      await manager.send(
        'telegram',
        'account-a',
        { conversation: { kind: 'direct', jid: 'chat-a' } },
        { kind: 'text', text: 'one' },
      );
      await manager.send(
        'telegram',
        'account-b',
        { conversation: { kind: 'direct', jid: 'chat-b' } },
        { kind: 'text', text: 'two' },
      );
      expect(sent).toEqual(['a:chat-a:one', 'b:chat-b:two']);
      await expect(
        manager.send(
          'telegram',
          'missing',
          { conversation: { kind: 'direct', jid: 'chat-x' } },
          { kind: 'text', text: 'no fallback' },
        ),
      ).rejects.toThrow(/account missing not registered/);
    } finally {
      db.close();
      cleanupDir(config.dataDir);
    }
  });

  it('runs owner text through the correct account and blocks management commands', async () => {
    const config = makeTestConfig();
    const db = openDatabase({ config, logger: testLogger(), backupDisabled: true });
    const sent: string[] = [];
    const prompts: string[] = [];
    try {
      db.db
        .prepare(
          "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1','alice','h','member','t'), ('u2','bob','h','member','t')",
        )
        .run();
      db.db
        .prepare(
          "INSERT INTO workspaces (id, folder, jid, display_name, is_home, created_by, execution_mode, created_at) VALUES ('ws-a','fa','web:a','A',0,'u1','host','t'), ('ws-b','fb','web:b','B',0,'u2','host','t')",
        )
        .run();
      db.db
        .prepare(
          "INSERT INTO channel_accounts (id, user_id, channel, owner_im_id, created_at) VALUES ('acc-a','u1','telegram','owner-a','t'), ('acc-b','u2','telegram','owner-b','t')",
        )
        .run();
      const runtime = new AgentRuntime({
        db,
        logger: testLogger(),
        apiKey: 'test-key',
        executeTurn: async function* ({ prompt }) {
          prompts.push(prompt);
          yield {
            type: 'assistant',
            message: { content: [{ type: 'text', text: 'reply:' + prompt }] },
          } as never;
          yield { type: 'result', subtype: 'success' } as never;
        },
      });
      const manager = new ImManager(db, testLogger(), runtimeSessionAllocator(runtime));
      manager.register('acc-b', fakeAdapter('b', sent));
      manager.register('acc-a', fakeAdapter('a', sent));
      manager.mount({
        accountId: 'acc-a',
        conversationJid: 'chat-a',
        kind: 'direct',
        workspaceId: 'ws-a',
      });
      manager.mount({
        accountId: 'acc-b',
        conversationJid: 'chat-b',
        kind: 'direct',
        workspaceId: 'ws-b',
      });
      const ingress = new ImIngress({
        db,
        logger: testLogger(),
        manager,
        runtime,
        profileStore: new AgentProfileStore(db),
        workspaceStore: new WorkspaceStore(db),
        wsHub: { broadcastToUser() {} } as unknown as WsHub,
      });

      await ingress.handleInbound(
        inbound('acc-a', 'chat-a', 'intruder', ' /bind@ClawtideBot ws-a'),
      );
      await ingress.handleInbound(inbound('acc-b', 'chat-b', 'intruder', '\n/unbind'));
      await ingress.handleInbound(inbound('acc-a', 'chat-a', 'owner-a', ' /bind ws-a'));
      await ingress.handleInbound(inbound('acc-b', 'chat-b', 'owner-b', '\n/unbind'));
      expect(prompts).toEqual([]);
      expect(sent).toEqual([]);
      expect(countDb(db.db, 'agent_sessions')).toBe(0);
      expect(countDb(db.db, 'chat_messages')).toBe(0);

      await ingress.handleInbound(inbound('acc-a', 'chat-a', 'owner-a', 'hello-a'));
      await ingress.handleInbound(inbound('acc-b', 'chat-b', 'owner-b', 'hello-b'));
      expect(prompts).toEqual(['hello-a', 'hello-b']);
      expect(sent).toEqual(['a:chat-a:reply:hello-a', 'b:chat-b:reply:hello-b']);
    } finally {
      db.close();
      cleanupDir(config.dataDir);
    }
  });

  it('drops invalid IM bindings with zero execution or delivery side effects', async () => {
    const config = makeTestConfig();
    const db = openDatabase({ config, logger: testLogger(), backupDisabled: true });
    const sent: string[] = [];
    const prompts: string[] = [];
    try {
      db.db
        .prepare(
          "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1','alice','h','member','t'), ('u2','bob','h','member','t')",
        )
        .run();
      db.db
        .prepare(
          "INSERT INTO workspaces (id, folder, jid, display_name, is_home, created_by, execution_mode, created_at) VALUES ('ws-a','fa','web:a','A',0,'u1','host','t'), ('ws-b','fb','web:b','B',0,'u2','host','t')",
        )
        .run();
      db.db
        .prepare(
          "INSERT INTO channel_accounts (id, user_id, channel, owner_im_id, created_at) VALUES ('acc-a','u1','telegram','owner-a','t')",
        )
        .run();
      const profileStore = new AgentProfileStore(db);
      const segments = {
        identity_prompt: '',
        soul_prompt: '',
        agents_prompt: '',
        tools_prompt: '',
      };
      const foreignProfile = profileStore.create('u2', {
        name: 'foreign',
        segments,
        prompt_mode: 'append',
      });
      const deletedProfile = profileStore.create('u1', {
        name: 'deleted',
        segments,
        prompt_mode: 'append',
      });
      db.db
        .prepare("UPDATE agent_profiles SET status = 'deleted' WHERE id = ?")
        .run(deletedProfile.id);

      const runtime = new AgentRuntime({
        db,
        logger: testLogger(),
        apiKey: 'test-key',
        executeTurn: async function* ({ prompt }) {
          prompts.push(prompt);
          yield { type: 'result', subtype: 'success' } as never;
        },
      });
      const manager = new ImManager(db, testLogger(), runtimeSessionAllocator(runtime));
      manager.register('acc-a', fakeAdapter('a', sent));
      const ingress = new ImIngress({
        db,
        logger: testLogger(),
        manager,
        runtime,
        profileStore,
        workspaceStore: new WorkspaceStore(db),
        wsHub: { broadcastToUser() {} } as unknown as WsHub,
      });
      const expectBlocked = async (msg: InboundMessage): Promise<void> => {
        const before = {
          sessions: countDb(db.db, 'agent_sessions'),
          messages: countDb(db.db, 'chat_messages'),
          prompts: prompts.length,
          sent: sent.length,
        };
        await ingress.handleInbound(msg);
        expect(countDb(db.db, 'agent_sessions')).toBe(before.sessions);
        expect(countDb(db.db, 'chat_messages')).toBe(before.messages);
        expect(prompts).toHaveLength(before.prompts);
        expect(sent).toHaveLength(before.sent);
      };

      manager.mount({
        accountId: 'acc-a',
        conversationJid: 'foreign-workspace',
        kind: 'direct',
        workspaceId: 'ws-b',
      });
      await expectBlocked(inbound('acc-a', 'foreign-workspace', 'owner-a', 'foreign'));

      manager.mount({
        accountId: 'acc-a',
        conversationJid: 'channel-mismatch',
        kind: 'direct',
        workspaceId: 'ws-a',
      });
      await expectBlocked({
        ...inbound('acc-a', 'channel-mismatch', 'owner-a', 'mismatch'),
        channel: 'feishu',
      });

      const otherWorkspaceSession = runtime.createSession({ workspaceId: 'ws-b' });
      manager.mount({
        accountId: 'acc-a',
        conversationJid: 'cross-session',
        kind: 'direct',
        workspaceId: 'ws-a',
        sessionId: otherWorkspaceSession.id,
      });
      await expectBlocked(inbound('acc-a', 'cross-session', 'owner-a', 'cross'));

      const foreignProfileSession = runtime.createSession({
        workspaceId: 'ws-a',
        profileId: foreignProfile.id,
      });
      manager.mount({
        accountId: 'acc-a',
        conversationJid: 'foreign-profile',
        kind: 'direct',
        workspaceId: 'ws-a',
        sessionId: foreignProfileSession.id,
      });
      await expectBlocked(inbound('acc-a', 'foreign-profile', 'owner-a', 'profile'));

      const deletedProfileSession = runtime.createSession({
        workspaceId: 'ws-a',
        profileId: deletedProfile.id,
      });
      manager.mount({
        accountId: 'acc-a',
        conversationJid: 'deleted-profile',
        kind: 'direct',
        workspaceId: 'ws-a',
        sessionId: deletedProfileSession.id,
      });
      await expectBlocked(inbound('acc-a', 'deleted-profile', 'owner-a', 'deleted'));
    } finally {
      db.close();
      cleanupDir(config.dataDir);
    }
  });
  it('hides foreign profiles before session creation and rejects legacy bindings', async () => {
    const server = await startServer({
      config: makeTestConfig(),
      logger: testLogger(),
      schedulerAutoStart: false,
      imAutoStart: false,
    });
    servers.push(server);
    const alice = await setup(server, 'alice');
    await api(server, '/auth/users', alice, { username: 'bob', password: 'password123' });
    const bobLogin = await fetch('http://127.0.0.1:' + server.port + '/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'password123' }),
    });
    const bob = bobLogin.headers.get('set-cookie')!.split(';')[0]!;
    const bobProfileRes = await api(server, '/profiles', bob, {
      name: 'Bob profile',
      segments: { identity: 'bob', soul: '', agents: '', tools: '' },
      promptMode: 'append',
    });
    const bobProfile = ((await bobProfileRes.json()) as { profile: { id: string } }).profile.id;
    const workspaceRes = await api(server, '/workspaces', alice, { displayName: 'Alice ops' });
    const workspaceId = ((await workspaceRes.json()) as { workspace: { id: string } }).workspace
      .id;

    const before = count(server, 'agent_sessions');
    const foreignCreate = await api(server, '/chat/sessions', alice, {
      workspaceId,
      profileId: bobProfile,
    });
    expect(foreignCreate.status).toBe(404);
    expect(count(server, 'agent_sessions')).toBe(before);

    const ownProfileRes = await api(server, '/profiles', alice, {
      name: 'Alice profile',
      segments: { identity: 'alice', soul: '', agents: '', tools: '' },
      promptMode: 'append',
    });
    const ownProfile = ((await ownProfileRes.json()) as { profile: { id: string } }).profile.id;
    const sessionRes = await api(server, '/chat/sessions', alice, {
      workspaceId,
      profileId: ownProfile,
    });
    const sessionId = ((await sessionRes.json()) as { session: { id: string } }).session.id;
    server.db.db
      .prepare('UPDATE agent_sessions SET profile_id = ? WHERE id = ?')
      .run(bobProfile, sessionId);

    const foreignTurn = await api(server, '/chat/sessions/' + sessionId + '/messages', alice, {
      content: 'must not execute',
    });
    expect(foreignTurn.status).toBe(404);
    expect(count(server, 'chat_messages')).toBe(0);

    const client = await connect(server.port, alice);
    await client.next();
    client.ws.send(
      JSON.stringify({ type: 'chat', sessionId, content: 'must not execute via ws' }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(count(server, 'chat_messages')).toBe(0);
    client.ws.close();

    server.db.db
      .prepare("UPDATE agent_profiles SET status = 'deleted' WHERE id = ?")
      .run(bobProfile);
    const deletedTurn = await api(server, '/chat/sessions/' + sessionId + '/messages', alice, {
      content: 'deleted must not execute',
    });
    expect(deletedTurn.status).toBe(404);
    expect(count(server, 'chat_messages')).toBe(0);

    server.db.db
      .prepare('UPDATE agent_sessions SET profile_id = ? WHERE id = ?')
      .run(ownProfile, sessionId);
    server.db.db
      .prepare("UPDATE agent_profiles SET status = 'deleted' WHERE id = ?")
      .run(ownProfile);
    const ownDeletedTurn = await api(
      server,
      '/chat/sessions/' + sessionId + '/messages',
      alice,
      { content: 'own deleted must not execute' },
    );
    expect(ownDeletedTurn.status).toBe(404);
    expect(count(server, 'chat_messages')).toBe(0);
  });
});

function inbound(
  accountId: string,
  jid: string,
  senderId: string,
  text: string,
): InboundMessage {
  return {
    channel: 'telegram',
    accountId,
    conversation: { kind: 'direct', jid },
    senderId,
    text,
    attachments: [],
    messageId: accountId + '-message',
    ts: '2026-01-01T00:00:00.000Z',
  };
}
function countDb(db: { prepare(sql: string): { get(): unknown } }, table: string): number {
  return (db.prepare('SELECT COUNT(*) AS n FROM ' + table).get() as { n: number }).n;
}

function fakeAdapter(label: string, sent: string[]): ImChannelAdapter {
  return {
    channel: 'telegram',
    capabilities(): ChannelCapabilities {
      return CAPABILITY_PRESETS.telegram;
    },
    async start(_onInbound: (msg: InboundMessage) => Promise<void>): Promise<void> {},
    async stop(): Promise<void> {},
    async send(target: OutboundTarget, content: OutboundContent): Promise<SendReceipt> {
      if (content.kind !== 'text') throw new Error('text only');
      sent.push(label + ':' + target.conversation.jid + ':' + content.text);
      return { messageId: label, ts: '2026-01-01T00:00:00.000Z' };
    },
  };
}

async function setup(server: RunningServer, username: string): Promise<string> {
  const response = await fetch('http://127.0.0.1:' + server.port + '/auth/setup', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'password123' }),
  });
  return response.headers.get('set-cookie')!.split(';')[0]!;
}
function api(
  server: RunningServer,
  path: string,
  cookie: string,
  body: unknown,
): Promise<Response> {
  return fetch('http://127.0.0.1:' + server.port + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify(body),
  });
}
function count(server: RunningServer, table: 'agent_sessions' | 'chat_messages'): number {
  return (server.db.db.prepare('SELECT COUNT(*) AS n FROM ' + table).get() as { n: number }).n;
}
interface QueuedSocket {
  ws: WebSocket;
  next(): Promise<{ type: string }>;
}
function connect(port: number, cookie?: string): Promise<QueuedSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      'ws://127.0.0.1:' + port + '/ws',
      cookie ? { headers: { cookie } } : {},
    );
    const frames: Array<{ type: string }> = [];
    const waiters: Array<(frame: { type: string }) => void> = [];
    ws.on('message', (data) => {
      const frame = JSON.parse(String(data)) as { type: string };
      const waiter = waiters.shift();
      if (waiter) waiter(frame);
      else frames.push(frame);
    });
    ws.once('open', () =>
      resolve({
        ws,
        next: () => {
          const frame = frames.shift();
          return frame ? Promise.resolve(frame) : new Promise((next) => waiters.push(next));
        },
      }),
    );
    ws.once('error', reject);
  });
}
