/**
 * Error taxonomy for the HTTP layer. Throwing a WebError anywhere in a route
 * produces a structured JSON body; anything else becomes a 500 with the
 * requestId attached (and the stack stays in the log, not the response).
 */
import type { ApiErrorBody } from '../shared/protocol.js';

export type ErrorCode =
  | 'bad_request'
  | 'validation_failed'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'conflict'
  | 'payload_too_large'
  | 'rate_limited'
  | 'internal_error';

const STATUS_BY_CODE: Record<ErrorCode, number> = {
  bad_request: 400,
  validation_failed: 400,
  unauthorized: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  payload_too_large: 413,
  rate_limited: 429,
  internal_error: 500,
};

export class WebError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly expose: boolean;

  constructor(code: ErrorCode, message: string, opts?: { expose?: boolean }) {
    super(message);
    this.name = 'WebError';
    this.code = code;
    this.status = STATUS_BY_CODE[code];
    // 500s never carry their message to the client unless explicitly marked safe.
    this.expose = opts?.expose ?? this.status < 500;
  }
}

export function apiErrorBody(code: string, message: string, requestId?: string): ApiErrorBody {
  return { error: { code, message, ...(requestId ? { requestId } : undefined) } };
}
