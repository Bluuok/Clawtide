/**
 * Settings route surface (Loop 5): admin-gated provider config. The API key
 * is write-only — GET reports `configured`, never the value; PUT with an
 * empty baseUrl/key clears that field. A member gets 403 (role gate, not a
 * foreign resource).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../server.js';
import { makeTestConfig, testLogger, cleanupDir } from '../test-support/harness.js';

describe('settings API (provider config)', () => {
  let server: RunningServer;
  let adminCookie: string;
  let memberCookie: string;

  beforeAll(async () => {
    server = await startServer({ config: makeTestConfig(), logger: testLogger() });
    const setup = await fetch(`http://127.0.0.1:${server.port}/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'password123' }),
    });
    adminCookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    await fetch(`http://127.0.0.1:${server.port}/auth/users`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ username: 'bob', password: 'password123' }),
    });
    const login = await fetch(`http://127.0.0.1:${server.port}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'bob', password: 'password123' }),
    });
    memberCookie = login.headers.get('set-cookie')!.split(';')[0]!;
  });

  afterAll(async () => {
    await server.stop();
    cleanupDir(server.config.dataDir);
  });

  it('starts unconfigured; GET never echoes a stored key', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/settings/provider`, {
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    const { provider } = (await res.json()) as { provider: { configured: boolean } };
    expect(provider.configured).toBe(false);

    await fetch(`http://127.0.0.1:${server.port}/settings/provider`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ baseUrl: 'https://api.anthropic.com', apiKey: 'sk-secret-123' }),
    });
    const after = await fetch(`http://127.0.0.1:${server.port}/settings/provider`, {
      headers: { cookie: adminCookie },
    });
    const text = await after.text();
    expect(text).not.toContain('sk-secret-123');
    const body = JSON.parse(text) as { provider: { configured: boolean; baseUrl: string } };
    expect(body.provider.configured).toBe(true);
    expect(body.provider.baseUrl).toBe('https://api.anthropic.com');
  });

  it('member is 403 (role gate); unauthenticated is 401; invalid URL is 400', async () => {
    const member = await fetch(`http://127.0.0.1:${server.port}/settings/provider`, {
      headers: { cookie: memberCookie },
    });
    expect(member.status).toBe(403);

    const anon = await fetch(`http://127.0.0.1:${server.port}/settings/provider`);
    expect(anon.status).toBe(401);

    const bad = await fetch(`http://127.0.0.1:${server.port}/settings/provider`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ baseUrl: 'not-a-url' }),
    });
    expect(bad.status).toBe(400);
  });

  it('persisted baseUrl reaches the runtime deps (settings > env chain)', () => {
    // The server assembly re-reads the setting on each turn; here we verify
    // the stored value is visible to the same settings store.
    expect(server.db.settings.get('provider.baseUrl')).toBe('https://api.anthropic.com');
  });
});
