/**
 * R19 audit trail (spec §6.1 item 8): every login outcome lands in
 * auth_audit_log with its event and ip. This is the "登录审计日志" evidence.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../server.js';
import { makeTestConfig, testLogger, cleanupDir } from '../test-support/harness.js';

describe('audit trail', () => {
  let server: RunningServer;

  beforeAll(async () => {
    const config = makeTestConfig({ AUTH_MAX_ATTEMPTS: 2 });
    server = await startServer({ config, logger: testLogger() });
  });

  afterAll(async () => {
    await server.stop();
    cleanupDir(server.config.dataDir);
  });

  function auditRows() {
    return server.db.db
      .prepare('SELECT username, ip, event, detail FROM auth_audit_log ORDER BY id')
      .all() as Array<{ username: string; ip: string; event: string; detail: string | null }>;
  }

  async function json(path: string, init?: RequestInit) {
    const res = await fetch(`http://127.0.0.1:${server.port}${path}`, init);
    return res;
  }

  it('records login_success, login_fail, rate_limited and logout', async () => {
    const setup = await json('/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'password123' }),
    });
    const setupCookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    expect(setup.status).toBe(201);

    // Two failures (max=2) then a block.
    await json('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'wrong-pass' }),
    });
    await json('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'wrong-pass' }),
    });
    const blocked = await json('/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'alice', password: 'wrong-pass' }),
    });
    expect(blocked.status).toBe(429);

    const rows = auditRows();
    const events = rows.map((r) => r.event);
    expect(events).toContain('login_success');
    expect(events).toContain('login_fail');
    expect(events).toContain('rate_limited');
    for (const r of rows) {
      expect(r.ip.length).toBeGreaterThan(0);
      expect(r.username).toBe('alice');
    }

    // Logout adds a row too — reuse the setup session cookie (the user is
    // rate-limited now, so no fresh login is possible, which is expected).
    await json('/auth/logout', { method: 'POST', headers: { cookie: setupCookie } });
    const afterLogout = auditRows();
    expect(afterLogout.map((r) => r.event)).toContain('logout');
  });

  it('client IP respects TRUST_PROXY=off: socket address, not X-Forwarded-For', async () => {
    // Fresh username so the limiter does not interfere.
    const res = await json('/auth/login', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '8.8.8.8, 1.1.1.1',
      },
      body: JSON.stringify({ username: 'xforward', password: 'wrong-pass' }),
    });
    expect(res.status).toBe(401);
    const row = auditRows()
      .filter((r) => r.username === 'xforward')
      .at(-1);
    expect(row?.event).toBe('login_fail');
    // TRUST_PROXY is false: the socket address wins, the header is ignored.
    expect(row?.ip).not.toBe('8.8.8.8');
  });
});
