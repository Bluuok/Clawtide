/**
 * Scheduled task store: CRUD over scheduled_tasks. The scheduler consumes the
 * rows; pause/resume and delete cancel in-flight queued runs so a paused or
 * deleted task never executes afterwards (its claim path requires an active
 * parent).
 */
import { randomBytes } from 'node:crypto';
import type { AppDb } from '../db.js';
import { nowIso } from '../time.js';
import type { ScheduledTaskRow } from '../task-scheduler.js';

export interface CreateTaskInput {
  workspaceId: string;
  prompt: string;
  scheduleType: 'cron' | 'interval' | 'once';
  cronExpr?: string | null;
  intervalSeconds?: number | null;
  runAt?: string | null;
  contextMode: 'group' | 'isolated';
  createdBy: string;
}

export class TaskStore {
  private readonly stmtById;
  private readonly stmtByWorkspace;
  private readonly stmtInsert;
  private readonly stmtSetStatus;
  private readonly stmtDelete;
  private readonly stmtCancelQueued;

  constructor(db: AppDb) {
    const raw = db.db;
    this.stmtById = raw.prepare('SELECT * FROM scheduled_tasks WHERE id = ?');
    this.stmtByWorkspace = raw.prepare(
      'SELECT * FROM scheduled_tasks WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY created_at',
    );
    this.stmtInsert = raw.prepare(
      `INSERT INTO scheduled_tasks (id, workspace_id, prompt, schedule_type, cron_expr,
         interval_seconds, run_at, context_mode, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
    );
    this.stmtSetStatus = raw.prepare('UPDATE scheduled_tasks SET status = ? WHERE id = ?');
    this.stmtDelete = raw.prepare('UPDATE scheduled_tasks SET deleted_at = ? WHERE id = ?');
    this.stmtCancelQueued = raw.prepare(
      `UPDATE task_runs SET status = 'cancelled', finished_at = ?, error = 'task paused or deleted'
       WHERE task_id = ? AND status IN ('queued','retry_wait')`,
    );
  }

  byId(id: string): ScheduledTaskRow | undefined {
    return this.stmtById.get(id) as ScheduledTaskRow | undefined;
  }

  listForWorkspace(workspaceId: string): ScheduledTaskRow[] {
    return this.stmtByWorkspace.all(workspaceId) as ScheduledTaskRow[];
  }

  create(input: CreateTaskInput): ScheduledTaskRow {
    const id = randomBytes(16).toString('hex');
    this.stmtInsert.run(
      id,
      input.workspaceId,
      input.prompt,
      input.scheduleType,
      input.cronExpr ?? null,
      input.intervalSeconds ?? null,
      input.runAt ?? null,
      input.contextMode,
      input.createdBy,
      nowIso(),
    );
    return this.byId(id)!;
  }

  /** Pause/resume. Pausing also cancels queued runs (resume cannot revive them). */
  setStatus(id: string, status: 'active' | 'paused'): boolean {
    const res = this.stmtSetStatus.run(status, id);
    if (res.changes > 0 && status === 'paused') {
      this.stmtCancelQueued.run(nowIso(), id);
    }
    return res.changes > 0;
  }

  /** Soft delete (404-hiding + audit trail stay intact); queued runs cancelled. */
  softDelete(id: string): boolean {
    const res = this.stmtDelete.run(nowIso(), id);
    if (res.changes > 0) this.stmtCancelQueued.run(nowIso(), id);
    return res.changes > 0;
  }
}
