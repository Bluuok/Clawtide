import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../server.js';
import { makeTestConfig, testLogger, cleanupDir } from '../test-support/harness.js';
import { WebError } from '../errors.js';

describe('HTTP server', () => {
  let server: RunningServer;

  beforeAll(async () => {
    const config = makeTestConfig();
    server = await startServer({ config, logger: testLogger() });
  });

  afterAll(async () => {
    await server.stop();
    cleanupDir(server.config.dataDir);
  });

  it('serves /healthz with version and uptime, no auth required', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; version: string; uptimeSeconds: number };
    expect(body.ok).toBe(true);
    expect(body.version).toBe('0.1.0');
    expect(body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });

  it('returns a structured 404 body with requestId header echoed', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/nope`);
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string; requestId?: string } };
    expect(body.error.code).toBe('not_found');
    expect(body.error.requestId).toBeTruthy();
    expect(res.headers.get('x-request-id')).toBe(body.error.requestId);
  });

  it('applies security headers and keeps 500 messages out of error bodies', async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/healthz`);
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('x-frame-options')).toBe('SAMEORIGIN');
    expect(res.headers.get('content-security-policy')).toContain("default-src 'self'");
    expect(new WebError('not_found', 'x').status).toBe(404);
    const internal = new WebError('internal_error', 'secret stack detail');
    expect(internal.expose).toBe(false);
    expect(new WebError('not_found', 'safe').expose).toBe(true);
  });

  it('rejects WS upgrades with 401 while no authenticator is configured', async () => {
    const { default: WebSocket } = await import('ws');
    await expect(
      new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
        ws.once('open', () => resolve(ws));
        ws.once('error', reject);
      }),
    ).rejects.toThrow(/401/);
  });

  it('stop() is idempotent', async () => {
    await server.stop();
    await server.stop(); // must not throw
  });
});
