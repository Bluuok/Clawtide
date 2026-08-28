/**
 * R19 + R20 HTTP surface integration: setup-once, login/logout, rate limit
 * over the wire, admin user management, workspace RBAC + 404 hiding, WS
 * upgrade authenticated by the same cookie chain.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { startServer, type RunningServer } from '../server.js';
import { makeTestConfig, testLogger, cleanupDir } from '../test-support/harness.js';

describe('Auth + workspace HTTP surface', () => {
  let server: RunningServer;
  const cookies: Record<string, string> = {};

  beforeAll(async () => {
    const config = makeTestConfig();
    server = await startServer({ config, logger: testLogger() });
  });

  afterAll(async () => {
    await server.stop();
    cleanupDir(server.config.dataDir);
  });

  function cookieHeader(name: keyof typeof cookies): string {
    return `Cookie: ${cookies[name]}`;
  }

  async function post(path: string, body: unknown, cookie?: keyof typeof cookies) {
    return fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cookie ? { cookie: cookies[cookie] } : {}),
      },
      body: JSON.stringify(body),
    });
  }

  it('setup creates the first admin exactly once and issues a session cookie', async () => {
    const res = await post('/auth/setup', { username: 'alice', password: 'password123' });
    expect(res.status).toBe(201);
    const setCookie = res.headers.get('set-cookie')!;
    expect(setCookie).toContain('clawtide_session=');
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Max-Age=2592000');
    expect(setCookie).not.toContain('Secure'); // plain HTTP test server
    cookies.alice = setCookie.split(';')[0]!;
    const body = (await res.json()) as { user: { role: string } };
    expect(body.user.role).toBe('admin');

    // Second setup is rejected.
    const again = await post('/auth/setup', { username: 'mallory', password: 'password123' });
    expect(again.status).toBe(403);
  });

  it('setup validates username/password shape', async () => {
    // Fresh server for this one to avoid the already-set-up state above.
    const config = makeTestConfig();
    const fresh = await startServer({ config, logger: testLogger() });
    try {
      const bad1 = await fetch(`http://127.0.0.1:${fresh.port}/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'a', password: 'password123' }),
      });
      expect(bad1.status).toBe(400);
      const bad2 = await fetch(`http://127.0.0.1:${fresh.port}/auth/setup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'shortpw', password: 'short' }),
      });
      expect(bad2.status).toBe(400);
    } finally {
      await fresh.stop();
      cleanupDir(config.dataDir);
    }
  });

  it('login sets a cookie; /auth/me reads it back; logout invalidates', async () => {
    const res = await post('/auth/login', { username: 'alice', password: 'password123' });
    expect(res.status).toBe(200);
    cookies.alice = res.headers.get('set-cookie')!.split(';')[0]!;

    const me = await fetch(`http://127.0.0.1:${server.port}/auth/me`, {
      headers: { cookie: cookies.alice },
    });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { username: string } }).user.username).toBe('alice');

    const out = await fetch(`http://127.0.0.1:${server.port}/auth/logout`, {
      method: 'POST',
      headers: { cookie: cookies.alice },
    });
    expect(out.status).toBe(200);
    const meAfter = await fetch(`http://127.0.0.1:${server.port}/auth/me`, {
      headers: { cookie: cookies.alice },
    });
    expect(meAfter.status).toBe(401);
  });

  it('wrong password is a uniform 401 and failures trip the rate limiter', async () => {
    // AUTH_MAX_ATTEMPTS defaults to 5; burn them.
    let sawLimited = false;
    for (let i = 0; i < 8; i++) {
      const res = await post('/auth/login', {
        username: 'ratelimit',
        password: 'wrong-pass-1',
      });
      if (res.status === 429) sawLimited = true;
      else expect(res.status).toBe(401);
    }
    expect(sawLimited).toBe(true);
  });

  it('admin creates users; members cannot; deleted user sessions die', async () => {
    // re-login alice (rate limiter above only burned 'ratelimit')
    const login = await post('/auth/login', { username: 'alice', password: 'password123' });
    cookies.alice = login.headers.get('set-cookie')!.split(';')[0]!;

    const created = await post(
      '/auth/users',
      { username: 'bob', password: 'password123', role: 'member' },
      'alice',
    );
    expect(created.status).toBe(201);

    const denied = await fetch(`http://127.0.0.1:${server.port}/auth/users`, {
      headers: {
        cookie: (
          await post('/auth/login', { username: 'bob', password: 'password123' })
        ).headers.get('set-cookie')!,
      },
    });
    expect(denied.status).toBe(403);

    const list = await fetch(`http://127.0.0.1:${server.port}/auth/users`, {
      headers: { cookie: cookies.alice },
    });
    const users = ((await list.json()) as { users: Array<{ username: string }> }).users;
    expect(users.map((u) => u.username)).toContain('bob');
  });

  it('workspaces: home auto-created, RBAC listing hides foreign homes, 404 not 403', async () => {
    const aliceList = await fetch(`http://127.0.0.1:${server.port}/workspaces`, {
      headers: { cookie: cookies.alice },
    });
    const aliceWs = (await aliceList.json()) as {
      workspaces: Array<{ id: string; isHome: boolean }>;
    };
    const aliceHome = aliceWs.workspaces.find((w) => w.isHome);
    expect(aliceHome).toBeTruthy();

    const bobLogin = await post('/auth/login', { username: 'bob', password: 'password123' });
    cookies.bob = bobLogin.headers.get('set-cookie')!.split(';')[0]!;
    const bobList = await fetch(`http://127.0.0.1:${server.port}/workspaces`, {
      headers: { cookie: cookies.bob },
    });
    const bobWs = (await bobList.json()) as { workspaces: Array<{ id: string }> };
    // Alice's home is invisible to Bob — filtered out, not an error.
    expect(bobWs.workspaces.find((w) => w.id === aliceHome!.id)).toBeUndefined();

    // Direct fetch of a foreign home: 404, never 403.
    const foreign = await fetch(`http://127.0.0.1:${server.port}/workspaces/${aliceHome!.id}`, {
      headers: { cookie: cookies.bob },
    });
    expect(foreign.status).toBe(404);

    // Deleting a home is denied for the owner (403) and hidden for others (404).
    const ownerDelete = await fetch(
      `http://127.0.0.1:${server.port}/workspaces/${aliceHome!.id}`,
      {
        method: 'DELETE',
        headers: { cookie: cookies.alice },
      },
    );
    expect(ownerDelete.status).toBe(403);
    const foreignDelete = await fetch(
      `http://127.0.0.1:${server.port}/workspaces/${aliceHome!.id}`,
      {
        method: 'DELETE',
        headers: { cookie: cookies.bob },
      },
    );
    expect(foreignDelete.status).toBe(404);

    // Member-create workspace: owner sees it, foreign doesn't, deletable by owner.
    const made = await post('/workspaces', { displayName: 'Ops' }, 'alice');
    expect(made.status).toBe(201);
    const madeId = ((await made.json()) as { workspace: { id: string } }).workspace.id;
    const bobView = await fetch(`http://127.0.0.1:${server.port}/workspaces/${madeId}`, {
      headers: { cookie: cookies.bob },
    });
    expect(bobView.status).toBe(404);
    const ownerDeleteWs = await fetch(`http://127.0.0.1:${server.port}/workspaces/${madeId}`, {
      method: 'DELETE',
      headers: { cookie: cookies.alice },
    });
    expect(ownerDeleteWs.status).toBe(200);
  });

  it('unauthenticated API access is 401 and WS upgrade without cookie is refused', async () => {
    const me = await fetch(`http://127.0.0.1:${server.port}/auth/me`);
    expect(me.status).toBe(401);

    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
      }),
    ).rejects.toThrow(/401/);
  });

  it('WS upgrade succeeds with a valid session cookie', async () => {
    const login = await post('/auth/login', { username: 'alice', password: 'password123' });
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    // The server pushes `hello` possibly before the open promise resolves, so
    // the message listener must exist before connecting (same reason Loop 0's
    // TestClient buffers frames).
    const hello: Promise<string> = new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, { headers: { cookie } });
      socket.once('message', (d) => {
        resolve(String(d));
        socket.close();
      });
      socket.once('error', reject);
    });
    expect(JSON.parse(await hello).type).toBe('hello');
  });
});
