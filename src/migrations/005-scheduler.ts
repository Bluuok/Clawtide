/**
 * R14 schema: scheduled tasks + materialized runs + run history.
 *
 * - scheduled_tasks: the definition row (cron | interval | once). interval
 *   carries CHECK (interval_seconds >= 60) so sub-minute intervals cannot be
 *   defined. status active|paused; paused tasks are not materialized.
 * - task_runs: one row per materialized occurrence. occurrence_key UNIQUE is
 *   the materialization idempotency point — the same occurrence can only ever
 *   land once, and execution merely consumes the row. Lease columns implement
 *   SQLite single-writer mutex; notification lease columns are a SEPARATE
 *   lease group so a failed notification never re-runs the task (spec §6.2.8).
 * - task_run_logs: append-only history for the console.
 */
import type { Migration } from '../db.js';

export const MIGRATION_V5_SCHEDULER: Migration = {
  version: 5,
  name: 'scheduler',
  up: (db) => {
    db.exec(`
      CREATE TABLE scheduled_tasks (
        id              TEXT PRIMARY KEY,
        workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
        prompt          TEXT NOT NULL,
        schedule_type   TEXT NOT NULL CHECK (schedule_type IN ('cron','interval','once')),
        cron_expr       TEXT,
        interval_seconds INTEGER CHECK (interval_seconds IS NULL OR interval_seconds >= 60),
        run_at          TEXT,
        context_mode    TEXT NOT NULL CHECK (context_mode IN ('group','isolated')),
        status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused')),
        deleted_at      TEXT,
        created_by      TEXT NOT NULL REFERENCES users(id),
        created_at      TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_scheduled_tasks_workspace ON scheduled_tasks(workspace_id);
      CREATE INDEX idx_scheduled_tasks_status ON scheduled_tasks(status) WHERE deleted_at IS NULL;

      CREATE TABLE task_runs (
        id            TEXT PRIMARY KEY,
        task_id       TEXT NOT NULL REFERENCES scheduled_tasks(id),
        occurrence_key TEXT NOT NULL UNIQUE,
        trigger_type  TEXT NOT NULL CHECK (trigger_type IN ('scheduled','immediate')),
        status        TEXT NOT NULL DEFAULT 'queued'
                      CHECK (status IN ('queued','retry_wait','running','success','failed','missed','cancelled')),
        attempt       INTEGER NOT NULL DEFAULT 0,
        available_at  TEXT NOT NULL,
        lease_owner   TEXT,
        lease_token   INTEGER,
        lease_expires_at TEXT,
        started_at    TEXT,
        finished_at   TEXT,
        result        TEXT,
        error         TEXT,
        notification_status TEXT NOT NULL DEFAULT 'pending'
                      CHECK (notification_status IN ('pending','running','delivered','failed')),
        notification_lease_owner TEXT,
        notification_lease_expires_at TEXT,
        created_at    TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_task_runs_task ON task_runs(task_id);
      CREATE INDEX idx_task_runs_status ON task_runs(status, available_at);

      CREATE TABLE task_run_logs (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id     TEXT NOT NULL REFERENCES scheduled_tasks(id),
        run_id      TEXT REFERENCES task_runs(id),
        status      TEXT NOT NULL,
        duration_ms INTEGER,
        error       TEXT,
        run_at      TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_task_run_logs_task ON task_run_logs(task_id);
    `);
  },
};
