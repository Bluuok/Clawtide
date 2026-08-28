/**
 * R14 — Occurrence Materialization scheduler (spec §6.2).
 *
 * Core invariants, each enforced in SQL rather than by convention:
 *  1. Materialization: due occurrences first become task_runs rows keyed by a
 *     UNIQUE occurrence_key (`taskId:scheduledTimeISO`). Execution only
 *     consumes the row; immediate runs take the same path, so retries and
 *     re-pumps are naturally idempotent.
 *  2. Claim = ONE conditional UPDATE. A SELECT only finds candidates; the
 *     verdict is `changes() > 0` on the claim statement alone (SQLite
 *     single-writer makes it atomic). No second check-then-write in the app.
 *  3. Non-reentrancy is two SQL branches: an expired lease whose run never
 *     started (started_at IS NULL) may be reclaimed; an expired lease whose
 *     run DID start is failed permanently by failExpiredStartedTaskRuns —
 *     "prefer missing a run to double-running it" lives in the SQL.
 *  4. Pre-start revalidation: marking started_at requires lease_expires_at >
 *     now AND the parent task still active — a stale lease or a deleted/paused
 *     task never begins execution.
 *  5. Heartbeat: conditional renewal keyed on (id, lease_owner, lease_token);
 *     a failed renewal means ownership was lost → stop working immediately.
 *  6. lease_token is an incrementing integer: claim +1, finalize +1 — the
 *     double bump invalidates every previous holder even if it still lives.
 *
 * Concurrency between multiple scheduler instances (or pumps) over one DB is
 * safe precisely because every state transition is a single conditional
 * UPDATE; two pumps may both SELECT the same candidate, only one UPDATE wins.
 */
import type { AppDb } from './db.js';
import type { Logger } from 'pino';
import { randomBytes } from 'node:crypto';
import { CronExpressionParser } from 'cron-parser';
import { nowIso } from './time.js';
import type { Statement } from 'better-sqlite3';

// Lease: the lease must outlive a full agent turn comfortably; 10 minutes
// covers maxTurns=16 with tool latency, and the heartbeat at lease/3 renews
// three times within one lease window, so a single missed beat never lapses.
const LEASE_MS = 10 * 60_000;
const HEARTBEAT_INTERVAL_MS = 200_000;
// Safe pre-start failures (claim → then revalidation refused) back off
// exponentially; after this many attempts the run is marked failed outright.
const MAX_SAFE_PRESTART_ATTEMPTS = 5;
// Pump cadence + caps: setTimeout self-chain, delay clamped into the 32-bit
// signed range (Node coalesces larger values to 1ms), boolean guard against
// pump re-entrancy, and a bounded batch per round.
const PUMP_INTERVAL_MS = 1_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const DRAIN_BATCH = 32;
const NOTIFY_RETRY_BATCH = 8;

export interface ScheduledTaskRow {
  id: string;
  workspace_id: string;
  prompt: string;
  schedule_type: 'cron' | 'interval' | 'once';
  cron_expr: string | null;
  interval_seconds: number | null;
  run_at: string | null;
  context_mode: 'group' | 'isolated';
  status: 'active' | 'paused';
  deleted_at: string | null;
  created_by: string;
  created_at: string;
}

export interface TaskRunRow {
  id: string;
  task_id: string;
  occurrence_key: string;
  trigger_type: 'scheduled' | 'immediate';
  status: 'queued' | 'retry_wait' | 'running' | 'success' | 'failed' | 'missed' | 'cancelled';
  attempt: number;
  available_at: string;
  lease_owner: string | null;
  lease_token: number | null;
  lease_expires_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  result: string | null;
  error: string | null;
  notification_status: 'pending' | 'running' | 'delivered' | 'failed';
  notification_lease_owner: string | null;
  notification_lease_expires_at: string | null;
  created_at: string;
}

export type TaskRunFinalStatus = 'success' | 'failed' | 'missed' | 'cancelled';

export interface SchedulerDeps {
  db: AppDb;
  logger: Logger;
  /** Clock seam for tests (vi.useFakeTimers or an injected offset). */
  now?: () => number;
  /**
   * Execution seam: claims must land on real agent turns without this module
   * knowing the runtime. The default pump drives nothing if absent (rows stay
   * claimed only for as long as the executor holds them).
   */
  executeRun?: (run: TaskRunRow, task: ScheduledTaskRow) => Promise<string>;
}

/** Pure next-schedule computation — exported for direct unit testing. */
export function nextScheduleAt(
  task: Pick<ScheduledTaskRow, 'schedule_type' | 'run_at' | 'interval_seconds'>,
  nowMs: number,
): string | null {
  if (task.schedule_type === 'once') return task.run_at;
  if (task.schedule_type === 'interval') {
    const intervalMs = (task.interval_seconds ?? 0) * 1000;
    if (intervalMs <= 0) return null;
    // Anchor intervals at wall-clock multiples so a fresh interval task
    // fires on the next boundary rather than drifting from creation time.
    const anchor = Date.parse('2026-01-01T00:00:00.000Z');
    const elapsed = nowMs - anchor;
    const steps = elapsed > 0 ? Math.floor(elapsed / intervalMs) + 1 : 0;
    return new Date(anchor + steps * intervalMs).toISOString();
  }
  return null; // cron handled by cronExprNext (cron-parser) in the store layer
}

export class TaskScheduler {
  private readonly stmtCandidates: Statement;
  private readonly stmtClaim: Statement;
  private readonly stmtStart: Statement;
  private readonly stmtHeartbeat: Statement;
  private readonly stmtFinish: Statement;
  private readonly stmtRetry: Statement;
  private readonly stmtFailExpired: Statement;
  private readonly stmtInsertRun: Statement;
  private readonly stmtTaskById: Statement;
  private readonly stmtActiveTasks: Statement;
  private readonly stmtRunById: Statement;
  private readonly stmtLatestRun: Statement;
  private readonly stmtMarkMissed: Statement;
  private readonly stmtCancelQueued: Statement;
  private readonly stmtLog: Statement;
  private readonly stmtNotifyCandidates: Statement;
  private readonly stmtNotifyClaim: Statement;
  private readonly stmtNotifyDeliver: Statement;
  private readonly stmtNotifyFail: Statement;

  private pumpTimer: NodeJS.Timeout | null = null;
  private heartbeats = new Map<string, NodeJS.Timeout>();
  private schedulerPumping = false;
  private stopped = false;
  private readonly owner: string;
  private readonly now: () => number;

  constructor(private readonly deps: SchedulerDeps) {
    const raw = deps.db.db;
    this.now = deps.now ?? (() => Date.now());
    this.owner = `sched-${randomBytes(8).toString('hex')}`;
    this.stmtCandidates = raw.prepare(`
      SELECT r.* FROM task_runs r
      JOIN scheduled_tasks t ON t.id = r.task_id
      WHERE t.status = 'active' AND t.deleted_at IS NULL
        AND r.status IN ('queued','retry_wait') AND r.available_at <= ?
      ORDER BY r.available_at
      LIMIT ?
    `);
    // The claim IS this statement; winner is decided by changes() > 0. The
    // expired-unstarted branch (running + lapsed lease + started_at IS NULL)
    // is the reclaim path; a lapsed lease with started_at is NOT claimable —
    // failExpiredStartedTaskRuns owns that row.
    this.stmtClaim = raw.prepare(`
      UPDATE task_runs
      SET status = 'running', lease_owner = ?, lease_token = lease_token + 1,
          lease_expires_at = ?, attempt = attempt + 1
      WHERE id = ? AND (
        (status IN ('queued','retry_wait') AND available_at <= ?)
        OR (status = 'running' AND lease_expires_at IS NOT NULL
            AND lease_expires_at <= ? AND started_at IS NULL))
    `);
    // Pre-start revalidation: fresh lease AND parent task still active.
    this.stmtStart = raw.prepare(`
      UPDATE task_runs SET started_at = ?, lease_expires_at = ?
      WHERE id = ? AND lease_owner = ? AND lease_token = ?
        AND lease_expires_at IS NOT NULL AND lease_expires_at > ?
        AND EXISTS (SELECT 1 FROM scheduled_tasks t
                    WHERE t.id = task_runs.task_id
                      AND t.status = 'active' AND t.deleted_at IS NULL)
    `);
    this.stmtHeartbeat = raw.prepare(`
      UPDATE task_runs SET lease_expires_at = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_token = ?
    `);
    this.stmtFinish = raw.prepare(`
      UPDATE task_runs
      SET status = ?, finished_at = ?, result = ?, error = ?,
          lease_owner = NULL, lease_expires_at = NULL, lease_token = lease_token + 1
      WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_token = ?
    `);
    this.stmtRetry = raw.prepare(`
      UPDATE task_runs
      SET status = 'retry_wait', available_at = ?, lease_owner = NULL,
          lease_expires_at = NULL, error = ?
      WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_token = ?
    `);
    // Expired lease + already started → failed, never resurrected.
    this.stmtFailExpired = raw.prepare(`
      UPDATE task_runs
      SET status = 'failed', finished_at = ?, error = 'lease expired after start; not resurrected',
          lease_owner = NULL, lease_expires_at = NULL, lease_token = lease_token + 1
      WHERE status = 'running' AND lease_expires_at IS NOT NULL AND lease_expires_at <= ?
        AND started_at IS NOT NULL
    `);
    this.stmtInsertRun = raw.prepare(`
      INSERT INTO task_runs (id, task_id, occurrence_key, trigger_type, status, attempt,
        available_at, created_at)
      VALUES (?, ?, ?, ?, 'queued', 0, ?, ?)
      ON CONFLICT(occurrence_key) DO NOTHING
    `);
    this.stmtTaskById = raw.prepare('SELECT * FROM scheduled_tasks WHERE id = ?');
    this.stmtActiveTasks = raw.prepare(`
      SELECT * FROM scheduled_tasks
      WHERE status = 'active' AND deleted_at IS NULL
    `);
    this.stmtRunById = raw.prepare('SELECT * FROM task_runs WHERE id = ?');
    this.stmtLatestRun = raw.prepare(`
      SELECT * FROM task_runs WHERE task_id = ? AND trigger_type = 'scheduled'
      ORDER BY available_at DESC LIMIT 1
    `);
    this.stmtMarkMissed = raw.prepare(`
      UPDATE task_runs SET status = 'missed', finished_at = ?,
        error = 'missed while scheduler down'
      WHERE id = ?
    `);
    this.stmtCancelQueued = raw.prepare(`
      UPDATE task_runs SET status = 'cancelled', finished_at = ?,
        error = 'task paused or deleted'
      WHERE task_id = ? AND status IN ('queued','retry_wait')
    `);
    this.stmtLog = raw.prepare(`
      INSERT INTO task_run_logs (task_id, run_id, status, duration_ms, error, run_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    // Notification lease: independent columns + independent claim statement.
    // A notification failure retries notification only — the run stays
    // success/failed as recorded.
    this.stmtNotifyCandidates = raw.prepare(`
      SELECT r.* FROM task_runs r
      WHERE r.notification_status = 'pending'
        AND (r.finished_at IS NOT NULL AND r.status IN ('success','failed','missed','cancelled'))
      ORDER BY r.finished_at LIMIT ?
    `);
    this.stmtNotifyClaim = raw.prepare(`
      UPDATE task_runs SET notification_status = 'running',
        notification_lease_owner = ?, notification_lease_expires_at = ?
      WHERE id = ? AND notification_status = 'pending'
    `);
    this.stmtNotifyDeliver = raw.prepare(`
      UPDATE task_runs SET notification_status = 'delivered', notification_lease_owner = NULL,
        notification_lease_expires_at = NULL
      WHERE id = ? AND notification_status = 'running' AND notification_lease_owner = ?
    `);
    this.stmtNotifyFail = raw.prepare(`
      UPDATE task_runs SET notification_status = 'pending', notification_lease_owner = NULL,
        notification_lease_expires_at = NULL
      WHERE id = ? AND notification_status = 'running' AND notification_lease_owner = ?
    `);
  }

  get ownerId(): string {
    return this.owner;
  }

  // ---- materialization -----------------------------------------------------

  /**
   * Materialize the next occurrence(s) of active tasks. One run row per
   * occurrence_key; the UNIQUE + DO NOTHING makes this idempotent under any
   * re-pump or concurrent scheduler.
   */
  materializeDue(): number {
    const nowMs = this.now();
    const nowStr = new Date(nowMs).toISOString();
    let created = 0;
    for (const task of this.stmtActiveTasks.all() as ScheduledTaskRow[]) {
      const due = this.materializeTask(task, nowMs, nowStr);
      created += due;
    }
    return created;
  }

  private materializeTask(task: ScheduledTaskRow, nowMs: number, nowStr: string): number {
    let created = 0;
    // Catch-up: interval tasks whose previous scheduled run's time has already
    // passed materialize the missed occurrence as 'missed' (restart recovery),
    // then schedule forward. once tasks that were missed while down still run.
    if (task.schedule_type === 'once') {
      if (task.run_at !== null && task.run_at <= nowStr) {
        if (this.insertRun(task.id, `${task.id}:${task.run_at}`, 'scheduled', nowStr)) created += 1;
      }
      return created;
    }
    if (task.schedule_type === 'interval') {
      const last = this.stmtLatestRun.get(task.id) as
        | (TaskRunRow & { available_at: string })
        | undefined;
      const intervalMs = (task.interval_seconds ?? 0) * 1000;
      if (intervalMs <= 0) return 0;
      // Find the previous scheduled slot: if a prior run exists, its slot is
      // its occurrence_key suffix; otherwise the first slot is the next
      // interval boundary after task creation.
      let prevSlotMs: number | null = null;
      if (last !== undefined) {
        prevSlotMs = Date.parse(last.available_at);
      } else {
        prevSlotMs = Date.parse(task.created_at) + intervalMs;
      }
      // Advance in interval steps from prevSlotMs; any slot <= now that has
      // never been materialized is either this pump's due slot or (if more
      // than one interval behind) a missed occurrence.
      let slotMs = prevSlotMs;
      let guard = 0;
      while (slotMs !== null && slotMs <= nowMs && guard < DRAIN_BATCH) {
        const slotIso = new Date(slotMs).toISOString();
        const key = `${task.id}:${slotIso}`;
        const inserted = this.insertRun(task.id, key, 'scheduled', nowStr, slotIso);
        if (inserted) {
          created += 1;
          // More than one interval behind now → this slot was missed while
          // the scheduler was down; record missed rather than queueing a
          // late burst (spec §6.2.8: 记 missed 并推进计划).
          const slotsBehind = Math.floor((nowMs - slotMs) / intervalMs);
          if (slotsBehind >= 1) {
            const runRow = this.deps.db.db
              .prepare('SELECT id FROM task_runs WHERE occurrence_key = ?')
              .get(key) as { id: string } | undefined;
            if (runRow !== undefined) this.stmtMarkMissed.run(nowStr, runRow.id);
          }
        }
        slotMs += intervalMs;
        guard += 1;
      }
      return created;
    }
    // cron: next fire time from the expression via the store layer.
    const next = this.nextCronAt(task.cron_expr, nowMs);
    if (next !== null && next <= nowMs) {
      if (
        this.insertRun(task.id, `${task.id}:${new Date(next).toISOString()}`, 'scheduled', nowStr)
      )
        created += 1;
    }
    return created;
  }

  private runIdForKey(key: string): string {
    const row = this.deps.db.db.prepare('SELECT id FROM task_runs WHERE occurrence_key = ?').get(key) as
      | { id: string }
      | undefined;
    return row?.id ?? key;
  }

  /** cron-parser seam: unit-tested separately with real expressions. */
  private nextCronAt(expr: string | null, nowMs: number): number | null {
    if (expr === null || expr.length === 0) return null;
    try {
      // cron-parser v5: CronExpressionParser.parse with an anchored
      // currentDate in UTC (every persisted timestamp is UTC ISO — local tz
      // must not leak into fire times); prev() yields the most recent fire
      // time at/before now — the due occurrence (next() would always be in
      // the future, so a due-occurrence scan must look backwards).
      const prev = CronExpressionParser.parse(expr, {
        currentDate: new Date(nowMs),
        tz: 'UTC',
      }).prev();
      return prev.getTime();
    } catch (err) {
      this.deps.logger.warn(
        { expr, err: err instanceof Error ? err.message : String(err) },
        'invalid cron expression',
      );
      return null;
    }
  }

  insertRun(
    taskId: string,
    occurrenceKey: string,
    triggerType: 'scheduled' | 'immediate',
    nowStr: string,
    availableAt?: string,
  ): boolean {
    const id = randomBytes(16).toString('hex');
    const res = this.stmtInsertRun.run(
      id,
      taskId,
      occurrenceKey,
      triggerType,
      availableAt ?? nowStr,
      nowStr,
    );
    return res.changes > 0;
  }

  /** Immediate run: same materialization path → idempotent by key. */
  runNow(taskId: string): { queued: boolean; runId?: string } {
    const task = this.stmtTaskById.get(taskId) as ScheduledTaskRow | undefined;
    if (task === undefined || task.status !== 'active' || task.deleted_at !== null) {
      return { queued: false };
    }
    const nowStr = new Date(this.now()).toISOString();
    const key = `${task.id}:now`;
    // Immediate occurrences are keyed per task, NOT per call — a second
    // runNow while one is queued/running is an idempotent skip.
    const existing = this.deps.db.db
      .prepare(
        "SELECT id FROM task_runs WHERE occurrence_key = ? AND status NOT IN ('success','failed','missed','cancelled')",
      )
      .get(key) as { id: string } | undefined;
    if (existing !== undefined) return { queued: true, runId: existing.id };
    const id = randomBytes(16).toString('hex');
    const ok =
      this.stmtInsertRun.run(id, task.id, key, 'immediate', nowStr, nowStr).changes > 0;
    return { queued: ok, runId: ok ? id : undefined };
  }

  // ---- claim + execute -----------------------------------------------------

  /** Candidates only; the verdict lives in claimOne's changes(). */
  candidates(limit = DRAIN_BATCH): TaskRunRow[] {
    return this.stmtCandidates.all(new Date(this.now()).toISOString(), limit) as TaskRunRow[];
  }

  /**
   * Single conditional UPDATE; returns the fresh row when this caller won,
   * undefined when another writer got there first.
   */
  claimOne(runId: string): TaskRunRow | undefined {
    const nowMs = this.now();
    const nowStr = new Date(nowMs).toISOString();
    const leaseEnd = new Date(nowMs + LEASE_MS).toISOString();
    const candidate = this.stmtRunById.get(runId) as TaskRunRow | undefined;
    if (candidate === undefined) return undefined;
    const res = this.stmtClaim.run(this.owner, leaseEnd, runId, nowStr, nowStr);
    if (res.changes === 0) return undefined;
    return this.stmtRunById.get(runId) as TaskRunRow;
  }

  /**
   * Pre-start revalidation + execution under heartbeat. Returns the final
   * status written by this holder, or undefined if ownership was lost before
   * completion.
   */
  async runClaimed(run: TaskRunRow): Promise<TaskRunFinalStatus | undefined> {
    const nowMs = this.now();
    const nowStr = new Date(nowMs).toISOString();
    // Re-read: `run` may be a pre-claim snapshot (claimOne's fresh read is
    // authoritative, but accepting a snapshot keeps pump code simple). The
    // current row state decides every conditional UPDATE below.
    const current = (this.stmtRunById.get(run.id) as TaskRunRow | undefined) ?? run;
    // Revalidation gate: fresh lease + parent active, else pre-start failure.
    const startRes = this.stmtStart.run(
      nowStr,
      new Date(nowMs + LEASE_MS).toISOString(),
      current.id,
      this.owner,
      current.lease_token,
      nowStr,
    );
    if (startRes.changes === 0) {
      this.releaseForRetry(current, 'pre-start revalidation failed');
      return undefined;
    }
    // Re-read after the start UPDATE: attempt/lease_token moved (+1 by claim,
    // possibly again here) — the finalize conditions below must match the
    // CURRENT row state, not the pre-claim snapshot the caller passed in.
    const live = this.stmtRunById.get(current.id) as TaskRunRow;
    const task = this.stmtTaskById.get(current.task_id) as ScheduledTaskRow | undefined;
    if (task === undefined) {
      this.releaseForRetry(live, 'task vanished');
      return undefined;
    }
    this.startHeartbeat(current.id, live.lease_token ?? 0);
    try {
      if (this.deps.executeRun === undefined) {
        // Nothing to execute with: this scheduler instance is a pump/claim
        // engine only. Release for retry so another configured instance (or a
        // later configured one) can take it.
        this.stopHeartbeat(current.id);
        // Roll back started_at: this run never truly began, so it must stay
        // in the "expired unstarted → reclaimable" class, not the "started →
        // dead" one (spec §6.2.3 — the two branches are decided by started_at).
        this.deps.db.db
          .prepare('UPDATE task_runs SET started_at = NULL WHERE id = ?')
          .run(current.id);
        this.releaseForRetry(live, 'no executor configured on this scheduler');
        return undefined;
      }
      const result = await this.deps.executeRun(live, task);
      return this.finish(live, 'success', result, null);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return this.finish(live, 'failed', null, message);
    } finally {
      this.stopHeartbeat(current.id);
    }
  }

  private releaseForRetry(run: TaskRunRow, reason: string): void {
    if (run.attempt + 1 >= MAX_SAFE_PRESTART_ATTEMPTS) {
      const nowStr = new Date(this.now()).toISOString();
      const failed = this.deps.db.db.prepare(`
        UPDATE task_runs SET status = 'failed', finished_at = ?, error = ?
        WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_token = ?
      `);
      failed.run(nowStr, `${reason}; exceeded MAX_SAFE_PRESTART_ATTEMPTS`, run.id, this.owner, run.lease_token);
      this.writeLog(run.task_id, run.id, 'failed', null, 'max safe prestart attempts exceeded');
      return;
    }
    // Exponential backoff: min(60s, 1s · 2^(attempt-1)).
    const delay = Math.min(60_000, 1000 * 2 ** Math.max(0, run.attempt));
    const availableAt = new Date(this.now() + delay).toISOString();
    const res = this.stmtRetry.run(availableAt, reason, run.id, this.owner, run.lease_token);
    if (res.changes > 0) this.writeLog(run.task_id, run.id, 'retry_wait', null, reason);
  }

  private finish(
    run: TaskRunRow,
    status: 'success' | 'failed',
    result: string | null,
    error: string | null,
  ): TaskRunFinalStatus {
    const nowMs = this.now();
    const res = this.stmtFinish.run(
      status,
      new Date(nowMs).toISOString(),
      result,
      error,
      run.id,
      this.owner,
      run.lease_token,
    );
    if (res.changes === 0) return undefined as unknown as TaskRunFinalStatus;
    const duration = this.startedDurationMs(run, nowMs);
    this.writeLog(run.task_id, run.id, status, duration, error);
    return status;
  }

  private startedDurationMs(run: TaskRunRow, nowMs: number): number | null {
    const startedAt = (this.stmtRunById.get(run.id) as TaskRunRow | undefined)?.started_at;
    if (startedAt === null || startedAt === undefined) return null;
    return Math.max(0, nowMs - Date.parse(startedAt));
  }

  // ---- heartbeat ------------------------------------------------------------

  private startHeartbeat(runId: string, token: number): void {
    const timer = setInterval(() => {
      const renewed = this.stmtHeartbeat.run(
        new Date(this.now() + LEASE_MS).toISOString(),
        runId,
        this.owner,
        token,
      );
      if (renewed.changes === 0) {
        // Ownership lost (expired + reclaimed, or finished elsewhere): stop
        // working immediately. The executor observes the abort via its own
        // cancellation path; this holder must not write again.
        this.stopHeartbeat(runId);
        this.deps.logger.warn({ runId, owner: this.owner }, 'lease renewal failed; aborting run');
      }
    }, HEARTBEAT_INTERVAL_MS);
    timer.unref?.();
    this.heartbeats.set(runId, timer);
  }

  private stopHeartbeat(runId: string): void {
    const timer = this.heartbeats.get(runId);
    if (timer !== undefined) {
      clearInterval(timer);
      this.heartbeats.delete(runId);
    }
  }

  // ---- expired-lease sweep --------------------------------------------------

  /** Branch 2 of non-reentrancy: expired AND started → failed, not resurrected. */
  failExpiredStartedTaskRuns(): number {
    const nowStr = new Date(this.now()).toISOString();
    const res = this.stmtFailExpired.run(nowStr, nowStr);
    if (res.changes > 0) {
      this.deps.logger.warn({ count: res.changes }, 'expired started runs marked failed');
    }
    return res.changes;
  }

  // ---- pump ------------------------------------------------------------------

  start(): void {
    this.stopped = false;
    this.scheduleNextPump(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.pumpTimer !== null) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }
    for (const [runId, timer] of this.heartbeats) {
      clearInterval(timer);
      this.heartbeats.delete(runId);
    }
  }

  private scheduleNextPump(delayMs: number): void {
    if (this.stopped) return;
    const clamped = Math.min(Math.max(delayMs, 0), MAX_TIMER_DELAY_MS);
    this.pumpTimer = setTimeout(() => void this.pumpOnce(), clamped);
    this.pumpTimer.unref?.();
  }

  async pumpOnce(): Promise<void> {
    if (this.schedulerPumping || this.stopped) return;
    this.schedulerPumping = true;
    try {
      this.failExpiredStartedTaskRuns();
      this.materializeDue();
      // Recover long-dead leases before claiming: expired-unstarted become
      // reclaimable purely via the claim's OR branch, so no extra step is
      // needed here — claimOne's second branch handles them.
      let processed = 0;
      for (const candidate of this.candidates(DRAIN_BATCH)) {
        const claimed = this.claimOne(candidate.id);
        if (claimed === undefined) continue; // lost the race; fine
        await this.runClaimed(claimed);
        processed += 1;
        if (processed >= DRAIN_BATCH) break;
      }
      this.retryNotifications(NOTIFY_RETRY_BATCH);
    } finally {
      this.schedulerPumping = false;
    }
    this.scheduleNextPump(PUMP_INTERVAL_MS);
  }

  // ---- restart recovery -------------------------------------------------------

  /**
   * Startup scan: runs left running/queued by a previous process. Interval
   * occurrences that lapsed while down are recorded 'missed' by
   * materializeDue's catch-up logic; once tasks still fire (their run row is
   * still queued and available_at <= now). Orphaned 'running' rows with
   * started_at from a dead process are failed by failExpiredStartedTaskRuns
   * once their lease lapses — no special startup code needed, deliberately.
   */
  recoverOnStart(): void {
    const nowStr = new Date(this.now()).toISOString();
    // Runs claimed but never started by the dead process: release them back
    // to the queue immediately (their lease may still look fresh).
    const deadUnstarted = this.deps.db.db.prepare(`
      UPDATE task_runs SET status = 'retry_wait', available_at = ?, lease_owner = NULL,
        lease_expires_at = NULL, error = 'process restarted before start'
      WHERE status = 'running' AND started_at IS NULL AND lease_expires_at IS NOT NULL
    `);
    deadUnstarted.run(nowStr);
    this.deps.logger.info('scheduler recovery pass complete');
  }

  // ---- notifications ------------------------------------------------------------

  private retryNotifications(limit: number): void {
    const nowMs = this.now();
    const rows = this.stmtNotifyCandidates.all(limit) as TaskRunRow[];
    for (const row of rows) {
      const claimed = this.stmtNotifyClaim.run(
        this.owner,
        new Date(nowMs + LEASE_MS).toISOString(),
        row.id,
      );
      if (claimed.changes === 0) continue;
      try {
        // Delivery = writing the outcome to task_run_logs (the console's
        // history surface). Notification failures must never re-run the task.
        this.writeLog(row.task_id, row.id, `notification:${row.status}`, null, null);
        this.stmtNotifyDeliver.run(row.id, this.owner);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.stmtNotifyFail.run(row.id, this.owner);
        this.deps.logger.warn({ runId: row.id, err: message }, 'notification delivery failed; will retry');
      }
    }
  }

  private writeLog(
    taskId: string,
    runId: string,
    status: string,
    durationMs: number | null,
    error: string | null,
  ): void {
    this.stmtLog.run(taskId, runId, status, durationMs, error, new Date(this.now()).toISOString());
  }

  // ---- run/task read surface (console) --------------------------------------------

  runsForTask(taskId: string): TaskRunRow[] {
    return this.deps.db.db
      .prepare('SELECT * FROM task_runs WHERE task_id = ? ORDER BY available_at DESC LIMIT 100')
      .all(taskId) as TaskRunRow[];
  }

  runById(id: string): TaskRunRow | undefined {
    return this.stmtRunById.get(id) as TaskRunRow | undefined;
  }

  taskById(id: string): ScheduledTaskRow | undefined {
    return this.stmtTaskById.get(id) as ScheduledTaskRow | undefined;
  }
}
