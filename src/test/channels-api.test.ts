/**
 * Channel account route surface (Loop 6): register/list/patch/delete with
 * AES-256-GCM-encrypted credentials that are write-only (GET reports
 * `configured`, never ciphertext), per-owner 404 hiding, one account per
 * (user, channel). IM ingress is exercised end-to-end in the smoke script.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../server.js';
import { makeTestConfig, testLogger, cleanupDir } from '../test-support/harness.js';

describe('channels API', () => {
  let server: RunningServer;
  let adminCookie: string;

  beforeAll(async () => {
    server = await startServer({
      config: makeTestConfig(),
      logger: testLogger(),
      schedulerAutoStart: false,
      imAutoStart: false,
    });
    const setup = await fetch(`http://127.0.0.1:${server.port}/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'password123' }),
    });
    adminCookie = setup.headers.get('set-cookie')!.split(';')[0]!;
  });

  afterAll(async () => {
    await server.stop();
    cleanupDir(server.config.dataDir);
  });

  async function post(path: string, body?: unknown, method = 'POST') {
    return fetch(`http://127.0.0.1:${server.port}${path}`, {
      method,
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  }

  it('register → list reports configured without echoing the token; one per channel', async () => {
    const created = await post('/channels', {
      channel: 'telegram',
      credentials: { botToken: '123:abc-secret' },
      ownerImId: '81111',
    });
    expect(created.status).toBe(201);
    const body = (await created.json()) as {
      channel: { id: string; configured: boolean; ownerImId: string };
    };
    expect(body.channel.configured).toBe(true);
    expect(body.channel.ownerImId).toBe('81111');

    // GET must never echo the token.
    const list = await fetch(`http://127.0.0.1:${server.port}/channels`, {
      headers: { cookie: adminCookie },
    });
    const text = await list.text();
    expect(text).not.toContain('abc-secret');
    const parsed = JSON.parse(text) as { channels: Array<{ channel: string }> };
    expect(parsed.channels.map((c) => c.channel)).toEqual(['telegram']);

    // Second telegram account for the same user → conflict.
    const dup = await post('/channels', {
      channel: 'telegram',
      credentials: { botToken: 'x' },
    });
    expect(dup.status).toBe(409);
  });

  it('telegram without botToken / feishu without appSecret → 400', async () => {
    const t = await post('/channels', { channel: 'telegram', credentials: { x: 'y' } });
    expect(t.status).toBe(400);
    const f = await post('/channels', { channel: 'feishu', credentials: { appId: 'a' } });
    expect(f.status).toBe(400);
  });

  it('patch rotates credentials; ownerImId update; delete removes', async () => {
    const created = await post('/channels', {
      channel: 'feishu',
      credentials: { appId: 'old', appSecret: 'old-secret' },
    });
    const id = ((await created.json()) as { channel: { id: string } }).channel.id;

    const patched = await post(
      `/channels/${id}`,
      { credentials: { appId: 'new', appSecret: 'new-secret' }, ownerImId: 'ou_123' },
      'PATCH',
    );
    expect(patched.status).toBe(200);
    const patchedBody = (await patched.json()) as {
      channel: { configured: boolean; ownerImId: string | null };
    };
    expect(patchedBody.channel.configured).toBe(true);
    expect(patchedBody.channel.ownerImId).toBe('ou_123');

    const gone = await post(`/channels/${id}`, undefined, 'DELETE');
    expect(gone.status).toBe(200);
    const list = await fetch(`http://127.0.0.1:${server.port}/channels`, {
      headers: { cookie: adminCookie },
    });
    const channels = ((await list.json()) as { channels: Array<{ id: string }> }).channels;
    expect(channels.find((c) => c.id === id)).toBeUndefined();
  });

  it('foreign account 404 (per-owner hiding)', async () => {
    await post('/auth/users', { username: 'bob', password: 'password123' });
    const bobLogin = await post('/auth/login', { username: 'bob', password: 'password123' });
    const bobCookie = bobLogin.headers.get('set-cookie')!.split(';')[0]!;
    const created = await post('/channels', {
      channel: 'discord',
      credentials: { token: 'x' },
    });
    const id = ((await created.json()) as { channel: { id: string } }).channel.id;
    const foreign = await fetch(`http://127.0.0.1:${server.port}/channels/${id}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', cookie: bobCookie },
      body: JSON.stringify({ ownerImId: 'hijack' }),
    });
    expect(foreign.status).toBe(404);
  });
});
