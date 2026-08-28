import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { once } from 'node:events';
import WebSocket from 'ws';
import { startServer, type RunningServer } from '../server.js';
import { makeTestConfig, testLogger, cleanupDir } from '../test-support/harness.js';
import type { WsAuthResult } from '../ws.js';
import type { WsEnvelope, WsHelloPayload } from '../../shared/protocol.js';

/**
 * Queue-wrapped client: the server may push `hello` before the test binds a
 * listener, so frames are buffered from construction time and consumed in order.
 */
class TestClient {
  private readonly frames: string[] = [];
  private readonly waiters: Array<{
    resolve: (v: string) => void;
    reject: (e: Error) => void;
  }> = [];
  private closed = false;
  private closeErr: Error | undefined;

  private constructor(public readonly ws: WebSocket) {
    this.ws.on('message', (data) => {
      const frame = String(data);
      const waiter = this.waiters.shift();
      if (waiter) waiter.resolve(frame);
      else this.frames.push(frame);
    });
    this.ws.on('close', () => {
      this.closed = true;
      const err = this.closeErr ?? new Error('connection closed');
      for (const w of this.waiters.splice(0)) w.reject(err);
    });
    this.ws.on('error', (err) => {
      this.closeErr = err;
    });
  }

  static connect(port: number): Promise<TestClient> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
      ws.once('open', () => resolve(new TestClient(ws)));
      ws.once('error', reject);
    });
  }

  async next(): Promise<string> {
    const buffered = this.frames.shift();
    if (buffered !== undefined) return buffered;
    if (this.closed) throw new Error('connection closed');
    return new Promise<string>((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  async nextEnvelope<T = unknown>(): Promise<WsEnvelope<T>> {
    return JSON.parse(await this.next()) as WsEnvelope<T>;
  }

  send(payload: unknown): void {
    this.ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload));
  }

  close(): Promise<void> {
    // The `ws` client API takes (code, reason), not a callback — wait on the
    // close event instead of the browser-style cb signature.
    return new Promise((resolve, reject) => {
      if (this.ws.readyState === this.ws.CLOSED) return resolve();
      this.ws.once('close', () => resolve());
      this.ws.once('error', (e) => reject(e));
      this.ws.close();
    });
  }
}

describe('WS hub', () => {
  let server: RunningServer;
  let authentications: number;
  const clients: TestClient[] = [];

  beforeAll(async () => {
    const config = makeTestConfig();
    authentications = 0;
    server = await startServer({
      config,
      logger: testLogger(),
      wsAuthenticator: (): WsAuthResult => {
        authentications++;
        return { ok: true, connectionId: `test-${authentications}`, userId: 'u1' };
      },
    });
  });

  afterAll(async () => {
    for (const c of clients.splice(0)) await c.close().catch(() => undefined);
    await server.stop();
    cleanupDir(server.config.dataDir);
  });

  async function connect(): Promise<TestClient> {
    const c = await TestClient.connect(server.port);
    clients.push(c);
    return c;
  }

  it('greets authenticated connections and answers application-level ping', async () => {
    const client = await connect();
    const hello = await client.nextEnvelope<WsHelloPayload>();
    expect(hello.type).toBe('hello');
    expect(hello.payload.serverVersion).toBe('0.1.0');
    expect(hello.payload.serverTime).toBeTruthy();

    client.send({ type: 'ping' });
    const pong = await client.nextEnvelope();
    expect(pong.type).toBe('pong');
  });

  it('ignores non-JSON frames without closing the connection', async () => {
    const client = await connect();
    await client.nextEnvelope(); // hello
    client.send('not json at all');
    // Connection still usable: ping→pong round-trip proves liveness.
    client.send({ type: 'ping' });
    const pong = await client.nextEnvelope();
    expect(pong.type).toBe('pong');
  });

  it('tracks connection count until close', async () => {
    const before = server.ws.connectionCount();
    const client = await connect();
    await client.nextEnvelope(); // hello
    expect(server.ws.connectionCount()).toBe(before + 1);

    server.ws.broadcast({ type: 'notice', payload: { n: 1 }, ts: '2026-01-01T00:00:00Z' });
    const pushed = await client.nextEnvelope<{ n: number }>();
    expect(pushed.type).toBe('notice');
    expect(pushed.payload).toEqual({ n: 1 });

    await client.close();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.ws.connectionCount()).toBe(before);
  });

  it('rejects upgrades when the authenticator denies', async () => {
    const config = makeTestConfig();
    const denying = await startServer({
      config,
      logger: testLogger(),
      wsAuthenticator: () => ({ ok: false, reason: 'no session cookie' }),
    });
    try {
      await expect(TestClient.connect(denying.port)).rejects.toThrow();
    } finally {
      await denying.stop();
      cleanupDir(config.dataDir);
    }
  });

  it('close on the hub terminates connections', async () => {
    // Use a dedicated server so the shared one stays usable for other tests.
    const config = makeTestConfig();
    const srv = await startServer({
      config,
      logger: testLogger(),
      wsAuthenticator: () => ({ ok: true, connectionId: 'x', userId: 'u1' }),
    });
    const client = await TestClient.connect(srv.port);
    await client.nextEnvelope();
    // Bind the close expectation BEFORE the hub tears the socket down —
    // terminate() fires the client's close event synchronously server-side.
    const clientClosed = once(client.ws, 'close');
    await srv.ws.close();
    await clientClosed;
    expect(srv.ws.connectionCount()).toBe(0);
    await srv.stop();
    cleanupDir(config.dataDir);
  });
});
