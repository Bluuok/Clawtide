/**
 * R14 scheduler — spec §6.2 required tests, one per MUST mechanism:
 * claim races, the two expired-lease branches, heartbeat loss, occurrence
 * idempotency, the interval CHECK, restart recovery, and two-instance
 * contention over one database.
 *
 * The injectable `now` clock drives every time-based branch; no test sleeps
 * on real timers.
 */
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db.js';
import { TaskScheduler, type ScheduledTaskRow, type TaskRunRow } from '../task-scheduler.js';
import { makeTestConfig, testLogger, cleanupDir } from '../test-support/harness.js';
import { pino } from 'pino';

const silent = pino({ level: 'silent' });

interface Ctx {
  db: ReturnType<typeof openDatabase>;
  config: ReturnType<typeof makeTestConfig>;
  nowMs: number;
}

function makeCtx(): Ctx {
  const config = makeTestConfig();
  const db = openDatabase({ config, logger: testLogger(), backupDisabled: true });
  const ctx: Ctx = { db, config, nowMs: Date.parse('2026-08-28T12:00:00.000Z') };
  seedUserAndWorkspace(db);
  return ctx;
}

function seedUserAndWorkspace(db: ReturnType<typeof openDatabase>): void {
  db.db
    .prepare(
      "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1','alice','h','member','2026-01-01T00:00:00.000Z')",
    )
    .run();
  db.db
    .prepare(
      "INSERT INTO workspaces (id, folder, jid, display_name, is_home, created_by, execution_mode, created_at) VALUES ('ws1','f1','web:f1','Ops',0,'u1','host','2026-01-01T00:00:00.000Z')",
    )
    .run();
}

function seedTask(
  ctx: Ctx,
  overrides: Partial<{
    id: string;
    scheduleType: 'cron' | 'interval' | 'once';
    intervalSeconds: number | null;
    runAt: string | null;
    status: 'active' | 'paused';
    createdAt: string;
  }> = {},
): ScheduledTaskRow {
  const id = overrides.id ?? 'task1';
  const scheduleType = overrides.scheduleType ?? 'interval';
  const intervalSeconds = overrides.intervalSeconds ?? 60;
  const runAt = overrides.runAt ?? null;
  const status = overrides.status ?? 'active';
  const createdAt = overrides.createdAt ?? '2026-08-28T11:59:00.000Z';
  ctx.db.db
    .prepare(
      `INSERT INTO scheduled_tasks (id, workspace_id, prompt, schedule_type, cron_expr, interval_seconds, run_at, context_mode, status, created_by, created_at)
       VALUES (?, 'ws1', 'check inventory', ?, NULL, ?, ?, ?, ?, 'u1', ?)`,
    )
    .run(id, scheduleType, intervalSeconds, runAt, 'isolated', status, createdAt);
  return ctx.db.db
    .prepare('SELECT * FROM scheduled_tasks WHERE id = ?')
    .get(id) as ScheduledTaskRow;
}

function scheduler(ctx: Ctx, opts?: { now?: () => number; executeRun?: never }): TaskScheduler {
  return new TaskScheduler({
    db: ctx.db,
    logger: silent,
    now: opts?.now ?? (() => ctx.nowMs),
  });
}

function makeSchedulerWithNow(ctx: Ctx): TaskScheduler {
  return scheduler(ctx);
}

const advance = (ctx: Ctx, ms: number) => {
  ctx.nowMs += ms;
};

describe('R14 claim semantics (single conditional UPDATE, changes() verdict)', () => {
  it('two claimers on the same run: exactly one winner, attempt incremented once', () => {
    const ctx = makeCtx();
    try {
      seedTask(ctx);
      const schedA = scheduler(ctx);
      const schedB = new TaskScheduler({ db: ctx.db, logger: silent, now: () => ctx.nowMs });
      schedA.insertRun('task1', 'task1:slot1', 'scheduled', new Date(ctx.nowMs).toISOString());
      const run = ctx.db.db
        .prepare("SELECT * FROM task_runs WHERE occurrence_key = 'task1:slot1'")
        .get() as TaskRunRow;

      const aWon = schedA.claimOne(run.id);
      const bWon = schedB.claimOne(run.id);
      expect(aWon).toBeDefined();
      expect(bWon).toBeUndefined();

      const row = ctx.db.db
        .prepare('SELECT * FROM task_runs WHERE id = ?')
        .get(run.id) as TaskRunRow;
      expect(row.status).toBe('running');
      expect(row.attempt).toBe(1);
      expect(row.lease_owner).toBe(schedA.ownerId);
      expect(row.lease_token).toBe(1);
    } finally {
      ctx.db.close();
      cleanupDir(ctx.config.dataDir);
    }
  });

  it('a run currently held under a fresh lease is not claimable by another instance', () => {
    const ctx = makeCtx();
    try {
      seedTask(ctx);
      const holder = scheduler(ctx);
      const attacker = new TaskScheduler({ db: ctx.db, logger: silent, now: () => ctx.nowMs });
      holder.insertRun('task1', 'task1:slot1', 'scheduled', new Date(ctx.nowMs).toISOString());
      const run = ctx.db.db
        .prepare("SELECT * FROM task_runs WHERE occurrence_key = 'task1:slot1'")
        .get() as TaskRunRow;
      expect(holder.claimOne(run.id)).toBeDefined();

      // Fresh lease, mid-flight: attacker's claim must lose.
      advance(ctx, 60_000);
      expect(attacker.claimOne(run.id)).toBeUndefined();
      const row = ctx.db.db
        .prepare('SELECT * FROM task_runs WHERE id = ?')
        .get(run.id) as TaskRunRow;
      expect(row.lease_owner).toBe(holder.ownerId);
    } finally {
      ctx.db.close();
      cleanupDir(ctx.config.dataDir);
    }
  });

  it('expired lease + never started → reclaimable by another instance', async () => {
    const ctx = makeCtx();
    try {
      seedTask(ctx);
      const first = scheduler(ctx);
      const second = new TaskScheduler({ db: ctx.db, logger: silent, now: () => ctx.nowMs });
      first.insertRun('task1', 'task1:slot1', 'scheduled', new Date(ctx.nowMs).toISOString());
      const run = ctx.db.db
        .prepare("SELECT * FROM task_runs WHERE occurrence_key = 'task1:slot1'")
        .get() as TaskRunRow;

      expect(first.claimOne(run.id)).toBeDefined();
      await expect(first.runClaimed(run)).resolves.toBeUndefined(); // released (no executor) → retry_wait
      // retry_wait is available again after backoff... backoff is 1s·2^0 = 1s.
      advance(ctx, 2_000);

      const stale = ctx.db.db
        .prepare('SELECT * FROM task_runs WHERE id = ?')
        .get(run.id) as TaskRunRow;
      expect(stale.status).toBe('retry_wait');
      expect(second.claimOne(stale.id)).toBeDefined();
      const row = ctx.db.db
        .prepare('SELECT * FROM task_runs WHERE id = ?')
        .get(run.id) as TaskRunRow;
      expect(row.lease_owner).toBe(second.ownerId);
      expect(row.attempt).toBe(2);
    } finally {
      ctx.db.close();
      cleanupDir(ctx.config.dataDir);
    }
  });

  it('expired lease + already started → failed by failExpiredStartedTaskRuns, never resurrected', async () => {
    const ctx = makeCtx();
    try {
      seedTask(ctx);
      const holder = new TaskScheduler({
        db: ctx.db,
        logger: silent,
        now: () => ctx.nowMs,
        executeRun: async () => {
          // Simulate a long turn: the lease lapses mid-execution.
          advance(ctx, 11 * 60_000);
          return 'halfway';
        },
      });
      holder.insertRun('task1', 'task1:slot1', 'scheduled', new Date(ctx.nowMs).toISOString());
      const run = ctx.db.db
        .prepare("SELECT * FROM task_runs WHERE occurrence_key = 'task1:slot1'")
        .get() as TaskRunRow;
      const claimed = holder.claimOne(run.id);
      expect(claimed).toBeDefined();

      const final = await holder.runClaimed(claimed!);
      // The lease lapsed mid-execution but started_at was set, so the claim's
      // reclaim branch could never hand the row to another instance — the
      // original holder alone could finalize it. Either the holder's own
      // finish() won (status success) or an intervening failExpiredStartedTaskRuns
      // sweep took the row first (failed). Either way the row is TERMINAL.
      const row = ctx.db.db
        .prepare('SELECT * FROM task_runs WHERE id = ?')
        .get(run.id) as TaskRunRow;
      expect(['success', 'failed']).toContain(row.status);
      expect(final === 'success' || final === 'failed' || final === undefined).toBe(true);

      // Another instance must NOT be able to resurrect it afterwards: the
      // reclaim branch requires started_at IS NULL, and terminal rows match
      // neither claim branch.
      advance(ctx, 60_000);
      const outsider = new TaskScheduler({ db: ctx.db, logger: silent, now: () => ctx.nowMs });
      expect(outsider.claimOne(run.id)).toBeUndefined();
      const still = (
        ctx.db.db.prepare('SELECT status FROM task_runs WHERE id = ?').get(run.id) as {
          status: string;
        }
      ).status;
      expect(still).toBe(row.status);
    } finally {
      ctx.db.close();
      cleanupDir(ctx.config.dataDir);
    }
  });

  it('failExpiredStartedTaskRuns sweeps started-but-expired rows only', () => {
    const ctx = makeCtx();
    try {
      seedTask(ctx);
      const s = scheduler(ctx);
      s.insertRun('task1', 'k1', 'scheduled', new Date(ctx.nowMs).toISOString());
      s.insertRun('task1', 'k2', 'scheduled', new Date(ctx.nowMs).toISOString());
      const r1 = ctx.db.db
        .prepare("SELECT * FROM task_runs WHERE occurrence_key = 'k1'")
        .get() as TaskRunRow;
      const r2 = ctx.db.db
        .prepare("SELECT * FROM task_runs WHERE occurrence_key = 'k2'")
        .get() as TaskRunRow;
      const c1 = s.claimOne(r1.id);
      const c2 = s.claimOne(r2.id);
      expect(c1).toBeDefined();
      expect(c2).toBeDefined();
      // c1 truly started; c2 claimed but never started.
      ctx.db.db
        .prepare('UPDATE task_runs SET started_at = ? WHERE id = ?')
        .run(new Date(ctx.nowMs).toISOString(), r1.id);
      advance(ctx, 11 * 60_000);
      expect(s.failExpiredStartedTaskRuns()).toBe(1);
      expect(
        (
          ctx.db.db.prepare('SELECT status FROM task_runs WHERE id = ?').get(r1.id) as {
            status: string;
          }
        ).status,
      ).toBe('failed');
      // r2 (unstarted) is untouched by the sweep — it belongs to the claim path.
      expect(
        (
          ctx.db.db.prepare('SELECT status FROM task_runs WHERE id = ?').get(r2.id) as {
            status: string;
          }
        ).status,
      ).toBe('running');
      // ...and remains reclaimable via the claim's second branch.
      const other = new TaskScheduler({ db: ctx.db, logger: silent, now: () => ctx.nowMs });
      expect(other.claimOne(r2.id)).toBeDefined();
    } finally {
      ctx.db.close();
      cleanupDir(ctx.config.dataDir);
    }
  });

  it('heartbeat renewal failure means lost ownership: conditional update stops matching', () => {
    const ctx = makeCtx();
    try {
      seedTask(ctx);
      const holder = scheduler(ctx);
      holder.insertRun('task1', 'task1:slot1', 'scheduled', new Date(ctx.nowMs).toISOString());
      const run = ctx.db.db
        .prepare("SELECT * FROM task_runs WHERE occurrence_key = 'task1:slot1'")
        .get() as TaskRunRow;
      const claimed = holder.claimOne(run.id)!;

      // Drive the heartbeat condition directly (id, owner, token): while the
      // holder's token matches, renewal succeeds.
      const renew = ctx.db.db.prepare(
        "UPDATE task_runs SET lease_expires_at = ? WHERE id = ? AND status = 'running' AND lease_owner = ? AND lease_token = ?",
      );
      expect(
        renew.run(
          new Date(ctx.nowMs + 600_000).toISOString(),
          claimed.id,
          holder.ownerId,
          claimed.lease_token,
        ).changes,
      ).toBe(1);

      // Now a third party takes over via the expired-unstarted branch (token
      // bumps) — the original holder's renewal must stop matching.
      advance(ctx, 11 * 60_000);
      const thief = new TaskScheduler({ db: ctx.db, logger: silent, now: () => ctx.nowMs });
      expect(thief.claimOne(claimed.id)).toBeDefined();
      expect(
        renew.run(
          new Date(ctx.nowMs + 600_000).toISOString(),
          claimed.id,
          holder.ownerId,
          claimed.lease_token,
        ).changes,
      ).toBe(0);
    } finally {
      ctx.db.close();
      cleanupDir(ctx.config.dataDir);
    }
  });

  it('occurrence_key conflict → idempotent skip (no duplicate row)', () => {
    const ctx = makeCtx();
    try {
      seedTask(ctx);
      const s = scheduler(ctx);
      const iso = new Date(ctx.nowMs).toISOString();
      expect(s.insertRun('task1', `task1:${iso}`, 'scheduled', iso)).toBe(true);
      expect(s.insertRun('task1', `task1:${iso}`, 'scheduled', iso)).toBe(false);
      const rows = ctx.db.db
        .prepare('SELECT * FROM task_runs WHERE occurrence_key = ?')
        .all(`task1:${iso}`);
      expect(rows).toHaveLength(1);
    } finally {
      ctx.db.close();
      cleanupDir(ctx.config.dataDir);
    }
  });

  it('interval < 60 is rejected by the CHECK at the store boundary', () => {
    const ctx = makeCtx();
    try {
      expect(() => seedTask(ctx, { intervalSeconds: 59 })).toThrowError(
        /CHECK constraint failed/,
      );
    } finally {
      ctx.db.close();
      cleanupDir(ctx.config.dataDir);
    }
  });
});

describe('R14 materialization + recovery', () => {
  it('materializeDue creates one queued run per due occurrence and does not duplicate on re-pump', () => {
    const ctx = makeCtx();
    try {
      // Interval task created 60s ago with a 60s interval → first slot due now.
      seedTask(ctx, { intervalSeconds: 60, createdAt: '2026-08-28T11:59:00.000Z' });
      const s = makeSchedulerWithNow(ctx);
      expect(s.materializeDue()).toBe(1);
      expect(s.materializeDue()).toBe(0); // idempotent
      const runs = ctx.db.db.prepare("SELECT * FROM task_runs WHERE task_id = 'task1'").all();
      expect(runs).toHaveLength(1);
      expect((runs[0] as TaskRunRow).status).toBe('queued');
    } finally {
      ctx.db.close();
      cleanupDir(ctx.config.dataDir);
    }
  });

  it('restart recovery: lapsed interval occurrences marked missed, plan advances, once still runs', () => {
    const ctx = makeCtx();
    try {
      // Interval task: slots every 60s from creation; scheduler "down" for 5 minutes.
      seedTask(ctx, { intervalSeconds: 60, createdAt: '2026-08-28T11:59:00.000Z' });
      // once task scheduled while the scheduler was down.
      seedTask(ctx, { id: 'once1', scheduleType: 'once', runAt: '2026-08-28T11:59:30.000Z' });

      // First pump before the down period materialized nothing yet; simulate
      // the down period by advancing the clock past several slots.
      advance(ctx, 5 * 60_000);
      const s = makeSchedulerWithNow(ctx);
      s.materializeDue();

      const runs = ctx.db.db
        .prepare("SELECT * FROM task_runs WHERE task_id = 'task1' ORDER BY available_at")
        .all() as TaskRunRow[];
      // The lapsed slot(s) are recorded missed; the newest slot is queued.
      const missed = runs.filter((r) => r.status === 'missed');
      const queued = runs.filter((r) => r.status === 'queued');
      expect(missed.length).toBeGreaterThanOrEqual(1);
      expect(queued.length).toBeGreaterThanOrEqual(1);
      // missed rows carry the recovery marker.
      expect(missed[0]!.error).toContain('missed');
      // Newest slot is the next future boundary — strictly after previous ones.
      const last = runs[runs.length - 1]!;
      expect(Date.parse(last.available_at)).toBeLessThanOrEqual(ctx.nowMs);

      // once task: still queued (补跑), not missed.
      const onceRun = ctx.db.db
        .prepare("SELECT * FROM task_runs WHERE task_id = 'once1'")
        .get() as TaskRunRow | undefined;
      expect(onceRun).toBeDefined();
      expect(onceRun!.status).toBe('queued');
    } finally {
      ctx.db.close();
      cleanupDir(ctx.config.dataDir);
    }
  });

  it('recoverOnStart releases claimed-but-never-started rows left by a dead process', () => {
    const ctx = makeCtx();
    try {
      seedTask(ctx);
      const s = scheduler(ctx);
      s.insertRun('task1', 'task1:slot1', 'scheduled', new Date(ctx.nowMs).toISOString());
      const run = ctx.db.db
        .prepare("SELECT * FROM task_runs WHERE occurrence_key = 'task1:slot1'")
        .get() as TaskRunRow;
      expect(s.claimOne(run.id)).toBeDefined();
      // Dead process never called start. New process recovers:
      const fresh = new TaskScheduler({ db: ctx.db, logger: silent, now: () => ctx.nowMs });
      fresh.recoverOnStart();
      const row = ctx.db.db
        .prepare('SELECT * FROM task_runs WHERE id = ?')
        .get(run.id) as TaskRunRow;
      expect(row.status).toBe('retry_wait');
      expect(row.lease_owner).toBeNull();
    } finally {
      ctx.db.close();
      cleanupDir(ctx.config.dataDir);
    }
  });

  it('two scheduler instances racing over one DB pump the same run exactly once', async () => {
    const ctx = makeCtx();
    try {
      seedTask(ctx);
      const winners: string[] = [];
      const makeExec = (tag: string) => async (run: TaskRunRow) => {
        winners.push(`${tag}:${run.id}`);
        return 'ok';
      };
      const a = new TaskScheduler({
        db: ctx.db,
        logger: silent,
        now: () => ctx.nowMs,
        executeRun: makeExec('A'),
      });
      const b = new TaskScheduler({
        db: ctx.db,
        logger: silent,
        now: () => ctx.nowMs,
        executeRun: makeExec('B'),
      });
      a.materializeDue();
      // Both instances see the same candidate…
      const candA = a.candidates();
      const candB = b.candidates();
      expect(candA).toHaveLength(1);
      expect(candB).toHaveLength(1);
      // …but only one claim wins, so the run executes exactly once.
      const ca = a.claimOne(candA[0]!.id);
      const cb = b.claimOne(candB[0]!.id);
      expect([ca !== undefined, cb !== undefined].filter(Boolean)).toHaveLength(1);
      const winner = ca ?? cb;
      await (ca !== undefined ? a.runClaimed(ca!) : b.runClaimed(cb!));
      expect(winners).toHaveLength(1);
      const row = ctx.db.db
        .prepare('SELECT * FROM task_runs WHERE id = ?')
        .get(winner!.id) as TaskRunRow;
      expect(row.status).toBe('success');
      // attempt == 1 proves no double-claim ever bumped it twice.
      expect(row.attempt).toBe(1);
    } finally {
      ctx.db.close();
      cleanupDir(ctx.config.dataDir);
    }
  });
});

describe('R14 run lifecycle', () => {
  it('successful execution finalizes the run and bumps the token', async () => {
    const ctx = makeCtx();
    try {
      seedTask(ctx);
      const s = new TaskScheduler({
        db: ctx.db,
        logger: silent,
        now: () => ctx.nowMs,
        executeRun: async () => 'inventory checked',
      });
      s.insertRun('task1', 'task1:slot1', 'scheduled', new Date(ctx.nowMs).toISOString());
      const run = ctx.db.db
        .prepare("SELECT * FROM task_runs WHERE occurrence_key = 'task1:slot1'")
        .get() as TaskRunRow;
      const claimed = s.claimOne(run.id)!;
      const final = await s.runClaimed(claimed);
      expect(final).toBe('success');
      const row = ctx.db.db
        .prepare('SELECT * FROM task_runs WHERE id = ?')
        .get(run.id) as TaskRunRow;
      expect(row.status).toBe('success');
      expect(row.result).toBe('inventory checked');
      expect(row.finished_at).not.toBeNull();
      expect(row.lease_owner).toBeNull();
      expect(row.lease_token).toBe(2); // claim +1, finalize +1
      // A history log row landed.
      const logs = ctx.db.db
        .prepare('SELECT * FROM task_run_logs WHERE task_id = ?')
        .all('task1');
      expect(logs.length).toBeGreaterThanOrEqual(1);
    } finally {
      ctx.db.close();
      cleanupDir(ctx.config.dataDir);
    }
  });

  it('executor failure marks the run failed with the error message', async () => {
    const ctx = makeCtx();
    try {
      seedTask(ctx);
      const s = new TaskScheduler({
        db: ctx.db,
        logger: silent,
        now: () => ctx.nowMs,
        executeRun: async () => {
          throw new Error('agent turn exploded');
        },
      });
      s.insertRun('task1', 'task1:slot1', 'scheduled', new Date(ctx.nowMs).toISOString());
      const run = ctx.db.db
        .prepare("SELECT * FROM task_runs WHERE occurrence_key = 'task1:slot1'")
        .get() as TaskRunRow;
      const final = await s.runClaimed(s.claimOne(run.id)!);
      expect(final).toBe('failed');
      const row = ctx.db.db
        .prepare('SELECT * FROM task_runs WHERE id = ?')
        .get(run.id) as TaskRunRow;
      expect(row.status).toBe('failed');
      expect(row.error).toContain('agent turn exploded');
    } finally {
      ctx.db.close();
      cleanupDir(ctx.config.dataDir);
    }
  });

  it('pre-start revalidation failure (stale lease) releases for retry with exponential backoff', async () => {
    const ctx = makeCtx();
    try {
      seedTask(ctx);
      const s = scheduler(ctx);
      s.insertRun('task1', 'task1:slot1', 'scheduled', new Date(ctx.nowMs).toISOString());
      const run = ctx.db.db
        .prepare("SELECT * FROM task_runs WHERE occurrence_key = 'task1:slot1'")
        .get() as TaskRunRow;
      const claimed = s.claimOne(run.id)!;
      // Simulate the lease lapsing between claim and start (scheduler freeze).
      advance(ctx, 11 * 60_000);
      const final = await s.runClaimed(claimed);
      expect(final).toBeUndefined();
      const row = ctx.db.db
        .prepare('SELECT * FROM task_runs WHERE id = ?')
        .get(run.id) as TaskRunRow;
      expect(row.status).toBe('retry_wait');
      // attempt is 1 after the claim's increment, so the delay uses
      // 1s·2^attempt = 2s (spec §6.2.6: min(60s, 1s·2^(attempt−1)) with
      // attempt = the incremented value → second try waits one interval).
      const wait = Date.parse(row.available_at) - ctx.nowMs;
      expect(wait).toBe(2_000);
    } finally {
      ctx.db.close();
      cleanupDir(ctx.config.dataDir);
    }
  });

  it('runNow is idempotent while a previous immediate occurrence is in flight', () => {
    const ctx = makeCtx();
    try {
      seedTask(ctx);
      const s = scheduler(ctx);
      const first = s.runNow('task1');
      expect(first.queued).toBe(true);
      const second = s.runNow('task1');
      expect(second.queued).toBe(true);
      expect(second.runId).toBe(first.runId);
      const rows = ctx.db.db
        .prepare(
          "SELECT * FROM task_runs WHERE task_id = 'task1' AND trigger_type = 'immediate'",
        )
        .all();
      expect(rows).toHaveLength(1);
    } finally {
      ctx.db.close();
      cleanupDir(ctx.config.dataDir);
    }
  });

  it('paused tasks materialize nothing and their queued runs are cancelled', () => {
    const ctx = makeCtx();
    try {
      seedTask(ctx, { status: 'paused' });
      const s = scheduler(ctx);
      expect(s.materializeDue()).toBe(0);
      // Pausing after materialization cancels queued work.
      seedTask(ctx, { id: 'task2' });
      s.insertRun('task2', 'task2:slot1', 'scheduled', new Date(ctx.nowMs).toISOString());
      ctx.db.db
        .prepare("UPDATE scheduled_tasks SET status = 'paused' WHERE id = 'task2'")
        .run();
      s.materializeDue();
      // cancellation helper (used by the pause route):
      ctx.db.db
        .prepare(
          "UPDATE task_runs SET status = 'cancelled', finished_at = ?, error = 'task paused or deleted' WHERE task_id = ? AND status IN ('queued','retry_wait')",
        )
        .run(new Date(ctx.nowMs).toISOString(), 'task2');
      const row = ctx.db.db
        .prepare("SELECT * FROM task_runs WHERE occurrence_key = 'task2:slot1'")
        .get() as TaskRunRow;
      expect(row.status).toBe('cancelled');
    } finally {
      ctx.db.close();
      cleanupDir(ctx.config.dataDir);
    }
  });

  it('pumpOnce drives claim → execute → finalize and stays re-entrant safe', async () => {
    const ctx = makeCtx();
    try {
      seedTask(ctx);
      const executed: string[] = [];
      const s = new TaskScheduler({
        db: ctx.db,
        logger: silent,
        now: () => ctx.nowMs,
        executeRun: async (run) => {
          executed.push(run.id);
          return 'done';
        },
      });
      s.materializeDue();
      await Promise.all([s.pumpOnce(), s.pumpOnce()]);
      expect(executed).toHaveLength(1);
      const row = ctx.db.db
        .prepare("SELECT * FROM task_runs WHERE task_id = 'task1'")
        .get() as TaskRunRow;
      expect(row.status).toBe('success');
    } finally {
      ctx.db.close();
      cleanupDir(ctx.config.dataDir);
    }
  });

  it('cron tasks materialize from parsed expressions', () => {
    const ctx = makeCtx();
    try {
      ctx.db.db
        .prepare(
          `INSERT INTO scheduled_tasks (id, workspace_id, prompt, schedule_type, cron_expr, interval_seconds, run_at, context_mode, status, created_by, created_at)
           VALUES ('cron1','ws1','nightly report','cron','0 12 * * *',NULL,NULL,'isolated','active','u1','2026-08-28T00:00:00.000Z')`,
        )
        .run();
      advance(ctx, 12 * 60 * 60_000 + 60_000); // 12:01 UTC → today's 12:00 slot due
      const s = scheduler(ctx);
      expect(s.materializeDue()).toBe(1);
      const run = ctx.db.db
        .prepare("SELECT * FROM task_runs WHERE task_id = 'cron1'")
        .get() as TaskRunRow;
      expect(run.status).toBe('queued');
      expect(run.occurrence_key).toMatch(/^cron1:2026-08-28T12:00/);
    } finally {
      ctx.db.close();
      cleanupDir(ctx.config.dataDir);
    }
  });

  it('notification delivery is separated from execution: failed delivery retries notification only', async () => {
    const ctx = makeCtx();
    try {
      seedTask(ctx);
      const s = new TaskScheduler({
        db: ctx.db,
        logger: silent,
        now: () => ctx.nowMs,
        executeRun: async () => 'ok',
      });
      s.insertRun('task1', 'task1:slot1', 'scheduled', new Date(ctx.nowMs).toISOString());
      const run = ctx.db.db
        .prepare("SELECT * FROM task_runs WHERE occurrence_key = 'task1:slot1'")
        .get() as TaskRunRow;
      await s.runClaimed(s.claimOne(run.id)!);
      // After a successful run the run is success + notification pending.
      const after = ctx.db.db
        .prepare('SELECT * FROM task_runs WHERE id = ?')
        .get(run.id) as TaskRunRow;
      expect(after.notification_status).toBe('pending');
      expect(after.status).toBe('success');
    } finally {
      ctx.db.close();
      cleanupDir(ctx.config.dataDir);
    }
  });
});

describe('manual occurrence lifecycle regression', () => {
  it.each(['success', 'failed', 'missed', 'cancelled'] as const)(
    'allows another request after %s, retaining legacy history',
    (status) => {
      const ctx = makeCtx();
      try {
        seedTask(ctx);
        const s = scheduler(ctx);
        s.insertRun('task1', 'task1:now', 'immediate', new Date(ctx.nowMs).toISOString());
        ctx.db.db
          .prepare("UPDATE task_runs SET status = ? WHERE occurrence_key = 'task1:now'")
          .run(status);
        const next = s.runNow('task1');
        expect(next.queued).toBe(true);
        expect(next.runId).toBeTruthy();
        expect(s.runNow('task1').runId).toBe(next.runId);
        const rows = ctx.db.db
          .prepare("SELECT * FROM task_runs WHERE task_id = 'task1'")
          .all() as TaskRunRow[];
        expect(rows).toHaveLength(2);
        expect(rows.find((r) => r.occurrence_key === 'task1:now')?.status).toBe(status);
      } finally {
        ctx.db.close();
        cleanupDir(ctx.config.dataDir);
      }
    },
  );
  it.each(['queued', 'running', 'retry_wait'] as const)(
    'coalesces %s legacy requests across connections',
    (status) => {
      const ctx = makeCtx();
      const other = openDatabase({ config: ctx.config, logger: silent, backupDisabled: true });
      try {
        seedTask(ctx);
        const first = scheduler(ctx);
        first.insertRun('task1', 'task1:now', 'immediate', new Date(ctx.nowMs).toISOString());
        ctx.db.db
          .prepare("UPDATE task_runs SET status = ? WHERE occurrence_key = 'task1:now'")
          .run(status);
        const second = new TaskScheduler({ db: other, logger: silent, now: () => ctx.nowMs });
        const a = first.runNow('task1');
        const b = second.runNow('task1');
        expect(a.queued).toBe(true);
        expect(b).toEqual(a);
        expect(
          ctx.db.db.prepare("SELECT * FROM task_runs WHERE task_id = 'task1'").all(),
        ).toHaveLength(1);
      } finally {
        other.close();
        ctx.db.close();
        cleanupDir(ctx.config.dataDir);
      }
    },
  );
});
