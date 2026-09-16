/**
 * WebSocket hub on top of `ws`, attached to the node HTTP server's native
 * upgrade. Authentication is a pluggable gate filled in by Loop 1 (cookie
 * session check at upgrade time); until then, no upgrade path is registered —
 * the hub runs, but every upgrade is rejected as unauthorized rather than
 * silently accepted. That keeps the transport tested without shipping an
 * unauthenticated socket.
 */
import { WebSocketServer, type WebSocket } from 'ws';
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import {
  wsClientFrameSchema,
  type WsEnvelope,
  type WsHelloPayload,
} from '../shared/protocol.js';
import { appVersion } from './version.js';

/** Result of authenticating an upgrade request. */
export interface WsAuthResult {
  ok: boolean;
  /** Stable id used in logs and per-connection bookkeeping. */
  connectionId?: string;
  userId?: string;
  reason?: string;
}

export type WsAuthenticator = (req: IncomingMessage) => Promise<WsAuthResult> | WsAuthResult;

export interface WsHubOptions {
  config: AppConfig;
  logger: Logger;
  /** Loop 1 installs the cookie-session authenticator; absent = reject all. */
  authenticator?: WsAuthenticator;
  /**
   * Chat-frame handler: invoked for `{ type: 'chat', sessionId, content }`
   * frames from an authenticated connection. Loop 2 wires this to the agent
   * runtime; streaming responses come back via broadcastToUser.
   */
  onChat?: (
    userId: string,
    payload: { sessionId: string; content: string },
  ) => void | Promise<void>;
}

interface HubConnection {
  socket: WebSocket;
  connectionId: string;
  userId?: string;
  alive: boolean;
}

const HEARTBEAT_INTERVAL_MS = 30_000;

export class WsHub {
  private readonly wss: WebSocketServer;
  private readonly connections = new Map<string, HubConnection>();
  private heartbeat: NodeJS.Timeout | undefined;
  private nextConnectionId = 0;
  private stopped = false;

  constructor(
    private readonly opts: WsHubOptions,
    private readonly log: Logger,
  ) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
    this.wss.on(
      'connection',
      (socket: WebSocket, request: IncomingMessage, auth: WsAuthResult) =>
        this.handleConnection(socket, request, auth),
    );
  }

  /** Attach to the server's `upgrade` event. Call once after listen(). */
  attach(server: {
    on: (
      event: 'upgrade',
      cb: (req: IncomingMessage, socket: Duplex, head: Buffer) => void,
    ) => unknown;
  }): void {
    server.on('upgrade', (req, socket, head) => {
      void this.handleUpgrade(req, socket, head);
    });
    this.heartbeat = setInterval(() => this.sweep(), HEARTBEAT_INTERVAL_MS);
    this.heartbeat.unref();
  }

  private async handleUpgrade(
    req: IncomingMessage,
    socket: Duplex,
    head: Buffer,
  ): Promise<void> {
    if (this.stopped) {
      socket.destroy();
      return;
    }
    let auth: WsAuthResult;
    try {
      auth =
        this.opts.authenticator !== undefined
          ? await this.opts.authenticator(req)
          : { ok: false, reason: 'websocket auth not configured' };
    } catch (err) {
      this.log.warn({ err, path: req.url }, 'ws upgrade auth threw');
      auth = { ok: false, reason: 'auth error' };
    }
    if (!auth.ok) {
      // 401 before completing the handshake; destroy keeps no half-open socket.
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      this.wss.emit('connection', ws, req, auth);
    });
  }

  private handleConnection(socket: WebSocket, _req: IncomingMessage, auth: WsAuthResult): void {
    const connectionId = auth.connectionId ?? `ws-${++this.nextConnectionId}`;
    const conn: HubConnection = { socket, connectionId, userId: auth.userId, alive: true };
    this.connections.set(connectionId, conn);
    const log = this.log.child({ connectionId, userId: auth.userId });
    log.debug({ total: this.connections.size }, 'ws connected');

    const hello: WsEnvelope<WsHelloPayload> = {
      type: 'hello',
      payload: { serverVersion: appVersion(), serverTime: new Date().toISOString() },
      ts: new Date().toISOString(),
    };
    socket.send(JSON.stringify(hello));

    socket.on('pong', () => {
      conn.alive = true;
    });
    socket.on('message', (data) => {
      let raw: unknown;
      try {
        raw = JSON.parse(String(data));
      } catch {
        log.debug('ws frame not json; ignored');
        return;
      }
      const parsed = wsClientFrameSchema.safeParse(raw);
      if (!parsed.success) {
        log.debug('invalid ws frame; ignored');
        return;
      }
      const frame = parsed.data;
      if (frame.type === 'ping') {
        socket.send(
          JSON.stringify({ type: 'pong', payload: null, ts: new Date().toISOString() }),
        );
      } else if (frame.type === 'chat') {
        if (auth.userId !== undefined && this.opts.onChat !== undefined) {
          void this.dispatchChat(
            auth.userId,
            { sessionId: frame.sessionId, content: frame.content },
            log,
          );
        } else {
          log.debug({ type: frame.type }, 'chat frame dropped: no handler or no auth');
        }
      }
    });
    socket.on('close', () => {
      this.connections.delete(connectionId);
      log.debug({ total: this.connections.size }, 'ws closed');
    });
    socket.on('error', (err) => {
      log.warn({ err }, 'ws error');
    });
  }

  private async dispatchChat(
    userId: string,
    payload: { sessionId: string; content: string },
    log: Logger,
  ): Promise<void> {
    try {
      await this.opts.onChat?.(userId, payload);
    } catch (err) {
      log.warn({ err, sessionId: payload.sessionId }, 'ws chat handler failed');
    }
  }

  private sweep(): void {
    for (const conn of this.connections.values()) {
      if (!conn.alive) {
        conn.socket.terminate();
        continue;
      }
      conn.alive = false;
      conn.socket.ping();
    }
  }

  /** Broadcast one envelope to every authenticated connection. */
  broadcast<T>(envelope: WsEnvelope<T>): void {
    const data = JSON.stringify(envelope);
    for (const conn of this.connections.values()) {
      if (conn.socket.readyState === conn.socket.OPEN) conn.socket.send(data);
    }
  }

  /** Fan out an envelope to every connection of one authenticated user. */
  broadcastToUser<T>(userId: string, envelope: WsEnvelope<T>): void {
    const data = JSON.stringify(envelope);
    for (const conn of this.connections.values()) {
      if (conn.userId === userId && conn.socket.readyState === conn.socket.OPEN) {
        conn.socket.send(data);
      }
    }
  }

  connectionCount(): number {
    return this.connections.size;
  }

  close(): Promise<void> {
    this.stopped = true;
    if (this.heartbeat !== undefined) clearInterval(this.heartbeat);
    return new Promise((resolve) => {
      for (const conn of this.connections.values()) conn.socket.terminate();
      this.wss.close(() => resolve());
    });
  }
}
