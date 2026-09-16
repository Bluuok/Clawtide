/**
 * Shared protocol types — the single source of truth for the wire contract
 * between the server and the web console. Both `src/` and `web/` import from
 * here; defining a type twice in either side is a defect.
 */

import { z } from 'zod';

/** Standard WebSocket envelope. Every server→client push uses this shape. */
export interface WsEnvelope<T = unknown> {
  type: string;
  payload: T;
  /** Server clock at send time, UTC ISO string. */
  ts: string;
}

/** Payload of the initial `hello` envelope pushed to every WS client. */
export interface WsHelloPayload {
  serverVersion: string;
  /** UTC ISO string; clients use it to detect clock skew for reconnect logs. */
  serverTime: string;
}

/** Client→server WS frames are typed by `type` with JSON payloads. */
export const wsClientFrameSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('pong') }).strict(),
  z.object({ type: z.literal('ping') }).strict(),
  z
    .object({
      type: z.literal('chat'),
      sessionId: z.string().min(1).max(200),
      content: z.string().min(1).max(100_000),
    })
    .strict(),
]);

export type WsClientFrame = z.infer<typeof wsClientFrameSchema>;

/** Payload of `GET /healthz` (no auth: liveness only, no secrets). */
export interface HealthPayload {
  ok: true;
  version: string;
  uptimeSeconds: number;
}

/** Standard JSON error body returned by every non-2xx API response. */
export interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    requestId?: string;
  };
}
