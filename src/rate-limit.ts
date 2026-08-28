/**
 * Two-layer login rate limiting (spec §6.1 item 7, exact mechanism):
 *
 *  Layer 1  key = `${username}:${ip}` — window = lockoutMinutes (runtime
 *           configurable), threshold = AUTH_MAX_ATTEMPTS.
 *  Layer 2  key = `user:${username}` — GLOBAL across IPs, threshold = layer-1
 *           threshold × 4, fixed 1-hour window.
 *
 * A successful login clears ONLY the layer-1 record. The global layer decays
 * on its own TTL: if success reset it, an attacker could resynchronize the
 * global counter by logging in legitimately between bursts.
 *
 * Cross-account password spraying (many usernames, one IP) is a known blind
 * spot of this shape — documented as an evolution direction, not hidden.
 */
import type { Logger } from 'pino';

export interface RateLimitWindow {
  /** Fixed now-advancing clock in ms; tests drive this directly. */
  nowMs: number;
}

interface AttemptRecord {
  firstAttemptMs: number;
  count: number;
}

const CLEANUP_INTERVAL_MS = 10 * 60 * 1000;

export class LoginRateLimiter {
  private readonly layer1 = new Map<string, AttemptRecord>();
  private readonly layer2 = new Map<string, AttemptRecord>();
  private readonly layer2WindowMs = 60 * 60 * 1000; // fixed 1h global window
  private cleanupTimer: NodeJS.Timeout | undefined;
  private stopped = false;

  constructor(
    private readonly maxAttempts: number,
    private readonly layer1WindowMs: number,
    private readonly logger?: Logger,
  ) {
    const ttl = Math.max(24 * 60 * 60 * 1000, this.layer1WindowMs, this.layer2WindowMs);
    this.cleanupTimer = setInterval(() => this.cleanup(ttl), CLEANUP_INTERVAL_MS);
    this.cleanupTimer.unref();
  }

  /** Outcome of consulting both layers before a login attempt. */
  check(
    username: string,
    ip: string,
    nowMs: number,
  ): { allowed: boolean; layer: 1 | 2 | undefined } {
    const l1 = this.liveRecord(this.layer1, `${username}:${ip}`, nowMs, this.layer1WindowMs);
    if (l1 !== undefined && l1.count >= this.maxAttempts) {
      return { allowed: false, layer: 1 };
    }
    const l2 = this.liveRecord(this.layer2, `user:${username}`, nowMs, this.layer2WindowMs);
    if (l2 !== undefined && l2.count >= this.maxAttempts * 4) {
      return { allowed: false, layer: 2 };
    }
    return { allowed: true, layer: undefined };
  }

  /** Record a failed attempt on both layers. */
  failure(username: string, ip: string, nowMs: number): void {
    this.bump(this.layer1, `${username}:${ip}`, nowMs, this.layer1WindowMs);
    this.bump(this.layer2, `user:${username}`, nowMs, 60 * 60 * 1000);
  }

  /** Success clears layer 1 only; the global layer decays naturally. */
  success(username: string, ip: string): void {
    this.layer1.delete(`${username}:${ip}`);
  }

  stop(): void {
    this.stopped = true;
    if (this.cleanupTimer !== undefined) clearInterval(this.cleanupTimer);
  }

  // -- internals ------------------------------------------------------------

  private bump(
    map: Map<string, AttemptRecord>,
    key: string,
    nowMs: number,
    windowMs: number,
  ): void {
    const rec = map.get(key);
    if (rec === undefined || nowMs - rec.firstAttemptMs > windowMs) {
      map.set(key, { firstAttemptMs: nowMs, count: 1 });
      return;
    }
    rec.count += 1;
  }

  private liveRecord(
    map: Map<string, AttemptRecord>,
    key: string,
    nowMs: number,
    windowMs: number,
  ): AttemptRecord | undefined {
    const rec = map.get(key);
    if (rec === undefined) return undefined;
    if (nowMs - rec.firstAttemptMs > windowMs) {
      map.delete(key);
      return undefined;
    }
    return rec;
  }

  private cleanup(ttlMs: number): void {
    if (this.stopped) return;
    const now = Date.now();
    for (const [key, rec] of this.layer1) {
      if (now - rec.firstAttemptMs > ttlMs) this.layer1.delete(key);
    }
    for (const [key, rec] of this.layer2) {
      if (now - rec.firstAttemptMs > ttlMs) this.layer2.delete(key);
    }
    this.logger?.debug('login rate limiter cleanup swept');
  }
}

/**
 * Client IP for rate-limit keys and audit rows. Only the socket address is
 * trusted unless TRUST_PROXY is on, in which case the leftmost X-Forwarded-For
 * hop is honored (we sit behind one trusted proxy by assumption).
 */
export function clientIp(
  req: {
    socket: { remoteAddress?: string };
    headers: Record<string, string | string[] | undefined>;
  },
  trustProxy: boolean,
): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    if (typeof xff === 'string' && xff.length > 0) {
      const first = xff.split(',')[0]?.trim();
      if (first) return first;
    }
  }
  return req.socket.remoteAddress ?? 'unknown';
}
