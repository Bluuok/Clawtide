import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { openDatabase, DowngradeUnsupportedError, MIGRATIONS, type Migration } from '../db.js';
import { makeTestConfig, testLogger, cleanupDir } from '../test-support/harness.js';

describe('openDatabase migration protocol', () => {
  let dataDir: string;

  beforeEach(() => {
    dataDir = makeTestConfig().dataDir;
  });

  afterAll(() => {
    // Individual tests clean their own dirs; nothing tracked here.
  });

  it('applies the full chain to a fresh database', () => {
    const db = openDatabase({ config: { dataDir }, logger: testLogger() });
    try {
      expect(db.schemaVersion()).toBe(MIGRATIONS.length);
      // settings table exists and works
      db.settings.set('k', 'v');
      expect(db.settings.get('k')).toBe('v');
    } finally {
      db.close();
      cleanupDir(dataDir);
    }
  });

  it('is a no-op when reopened at current version', () => {
    const logger = testLogger();
    let db = openDatabase({ config: { dataDir }, logger });
    db.settings.set('persisted', 'value');
    db.close();
    db = openDatabase({ config: { dataDir }, logger });
    try {
      expect(db.schemaVersion()).toBe(MIGRATIONS.length);
      expect(db.settings.get('persisted')).toBe('value');
    } finally {
      db.close();
      cleanupDir(dataDir);
    }
  });

  it('refuses to open a database newer than the code (downgrade unsupported)', () => {
    // Build a v1 database, then pretend the marker is ahead of the code.
    let db = openDatabase({ config: { dataDir }, logger: testLogger() });
    db.close();
    db = openDatabase({ config: { dataDir }, logger: testLogger() });
    db.db.pragma(`user_version = ${MIGRATIONS.length + 5}`);
    db.close();

    expect(() => openDatabase({ config: { dataDir }, logger: testLogger() })).toThrowError(
      DowngradeUnsupportedError,
    );
    cleanupDir(dataDir);
  });

  it('backs up an existing non-empty database before upgrading', async () => {
    // Simulate a pre-existing v0 database: a real SQLite file (created without
    // our migration chain) that already has content on disk.
    const { default: Database } = await import('better-sqlite3');
    const dbPath = path.join(dataDir, 'clawtide.db');
    const pre = new Database(dbPath);
    pre.exec('CREATE TABLE legacy (x TEXT)');
    pre.close();

    const db = openDatabase({ config: { dataDir }, logger: testLogger() });
    try {
      const backupsDir = path.join(dataDir, 'backups');
      expect(existsSync(backupsDir)).toBe(true);
      // .db only — the -wal/-shm sidecar copies start with the same prefix.
      const backups = readdirSync(backupsDir).filter(
        (f) => f.startsWith('pre-migrate-') && f.endsWith('.db'),
      );
      expect(backups.length).toBe(1);
      expect(statSync(path.join(backupsDir, backups[0]!)).size).toBeGreaterThan(0);
    } finally {
      db.close();
      cleanupDir(dataDir);
    }
  });

  it('runs a custom migration chain forward with per-migration version bumps', () => {
    // Real v1 settings migration + a test-owned v2: AppDb always expects the
    // settings table, so any chain used with openDatabase includes it.
    const chain: Migration[] = [
      { version: 1, name: 'settings', up: MIGRATIONS[0]!.up },
      { version: 2, name: 'two', up: (db) => db.exec('CREATE TABLE t2 (b TEXT);') },
    ];
    const db = openDatabase({
      config: { dataDir },
      logger: testLogger(),
      migrations: chain,
      backupDisabled: true,
    });
    try {
      expect(db.schemaVersion()).toBe(2);
      db.db.exec("INSERT INTO t2 (b) VALUES ('y')");
    } finally {
      db.close();
      cleanupDir(dataDir);
    }
  });

  it('rolls back a failed migration (transactional version bump)', () => {
    const chain: Migration[] = [
      { version: 1, name: 'settings', up: MIGRATIONS[0]!.up },
      {
        version: 2,
        name: 'broken',
        up: (db) => {
          db.exec('CREATE TABLE half (a TEXT);');
          throw new Error('boom mid-migration');
        },
      },
    ];
    expect(() =>
      openDatabase({
        config: { dataDir },
        logger: testLogger(),
        migrations: chain,
        backupDisabled: true,
      }),
    ).toThrowError('boom mid-migration');

    // Reopen: must still be at v1 and the broken migration's partial DDL rolled back.
    const db = openDatabase({
      config: { dataDir },
      logger: testLogger(),
      migrations: [chain[0]!],
      backupDisabled: true,
    });
    try {
      expect(db.schemaVersion()).toBe(1);
      const tables = db.db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;
      expect(tables.map((t) => t.name)).not.toContain('half');
    } finally {
      db.close();
      cleanupDir(dataDir);
    }
  });
});

describe('SettingsStore', () => {
  it('upserts, reads json, deletes, and lists entries ordered', () => {
    const dataDir = makeTestConfig().dataDir;
    const db = openDatabase({
      config: { dataDir },
      logger: testLogger(),
      backupDisabled: true,
    });
    try {
      db.settings.set('a', '1');
      db.settings.set('a', '2'); // upsert
      expect(db.settings.get('a')).toBe('2');

      db.settings.setJson('obj', { nested: [1, 2] });
      expect(db.settings.getJson<{ nested: number[] }>('obj')).toEqual({ nested: [1, 2] });
      expect(db.settings.getJson('missing')).toBeUndefined();

      db.settings.set('b', 'x');
      const keys = db.settings.entries().map((e) => e.key);
      expect(keys).toEqual(['a', 'b', 'obj']);

      db.settings.delete('a');
      expect(db.settings.get('a')).toBeUndefined();
    } finally {
      db.close();
      cleanupDir(dataDir);
    }
  });
});

describe('v4 migration: profiles + runtime tables', () => {
  it('creates R15 + runtime tables with the partial-unique default index', () => {
    const cfg = makeTestConfig();
    const db = openDatabase({ config: cfg, logger: testLogger(), backupDisabled: true });
    try {
      db.db
        .prepare(
          "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1', 'alice', 'h', 'member', '2026-01-01')",
        )
        .run();
      const insertPartialDefault = (id: string): void => {
        db.db
          .prepare(
            `INSERT INTO agent_profiles (id, owner_user_id, name, identity_prompt, soul_prompt, agents_prompt, tools_prompt, prompt_mode, version, identity_hash, is_default, status, created_at, updated_at)
             VALUES (?, 'u1','n','','','','','append',1,'h',1,'active','t','t')`,
          )
          .run(id);
      };
      insertPartialDefault('p1');
      expect(() => insertPartialDefault('p2')).toThrowError(/UNIQUE constraint failed/);

      db.db
        .prepare(
          "INSERT INTO workspaces (id, folder, jid, display_name, is_home, created_by, execution_mode, created_at) VALUES ('w1','f1','web:f1','n',0,'u1','host','t')",
        )
        .run();
      db.db
        .prepare(
          "INSERT INTO chat_threads (id, workspace_id, kind, title, created_at) VALUES ('t1', 'w1', 'direct', '', 't')",
        )
        .run();
      db.db
        .prepare(
          "INSERT INTO agent_sessions (id, workspace_id, sdk_session_id, thread_id, profile_id, created_at, updated_at) VALUES ('s1','w1','uuid','t1',NULL,'t','t')",
        )
        .run();
      db.db
        .prepare(
          "INSERT INTO chat_messages (id, thread_id, session_id, role, content, ts) VALUES ('m1','t1','s1','user','hi','t')",
        )
        .run();
      db.db
        .prepare(
          "INSERT INTO tool_events (session_id, tool_name, input_json, output_json, ts) VALUES ('s1','bash','{}',NULL,'t')",
        )
        .run();
    } finally {
      db.close();
      cleanupDir(cfg.dataDir);
    }
  });
});

describe('v5 migration: scheduler tables', () => {
  const seedTaskBase = (db: ReturnType<typeof openDatabase>['db']): void => {
    db.prepare(
      "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1', 'alice', 'h', 'member', '2026-01-01')",
    ).run();
    db.prepare(
      "INSERT INTO workspaces (id, folder, jid, display_name, is_home, created_by, execution_mode, created_at) VALUES ('w1','f1','web:f1','n',0,'u1','host','t')",
    ).run();
    db.prepare(
      "INSERT INTO scheduled_tasks (id, workspace_id, prompt, schedule_type, cron_expr, interval_seconds, run_at, context_mode, status, created_by, created_at) VALUES ('t1','w1','do it','interval',NULL,120,NULL,'isolated','active','u1','t')",
    ).run();
  };

  it('creates scheduler tables; interval < 60 rejected by CHECK', () => {
    const cfg = makeTestConfig();
    const db = openDatabase({ config: cfg, logger: testLogger(), backupDisabled: true });
    try {
      seedTaskBase(db.db);
      const insertRun = (id: string, occurrence: string) =>
        db.db
          .prepare(
            `INSERT INTO task_runs (id, task_id, occurrence_key, trigger_type, status, attempt, available_at, notification_status, created_at)
             VALUES (?, 't1', ?, 'scheduled', 'queued', 0, 't', 'pending', 't')`,
          )
          .run(id, occurrence);
      insertRun('r1', 't1:2026-01-01T00:00:00.000Z');
      // Same occurrence again → UNIQUE violation = materialization idempotency.
      expect(() => insertRun('r2', 't1:2026-01-01T00:00:00.000Z')).toThrowError(
        /UNIQUE constraint failed/,
      );
      // interval < 60 seconds violates the CHECK on scheduled_tasks.
      expect(() =>
        db.db
          .prepare(
            "INSERT INTO scheduled_tasks (id, workspace_id, prompt, schedule_type, interval_seconds, context_mode, status, created_by, created_at) VALUES ('t2','w1','x','interval',59,'isolated','active','u1','t')",
          )
          .run(),
      ).toThrowError(/CHECK constraint failed/);
      // interval >= 60 accepted.
      db.db
        .prepare(
          "INSERT INTO scheduled_tasks (id, workspace_id, prompt, schedule_type, interval_seconds, context_mode, status, created_by, created_at) VALUES ('t3','w1','x','interval',60,'isolated','active','u1','t')",
        )
        .run();
      // Run log history row lands.
      db.db
        .prepare(
          "INSERT INTO task_run_logs (task_id, run_id, status, duration_ms, error, run_at) VALUES ('t1','r1','success',12,NULL,'t')",
        )
        .run();
    } finally {
      db.close();
      cleanupDir(cfg.dataDir);
    }
  });
});

describe('pruneBackups', () => {
  it('keeps only the newest N backups', async () => {
    const { mkdirSync } = await import('node:fs');
    const dataDir = makeTestConfig().dataDir;
    const backupsDir = path.join(dataDir, 'backups');
    mkdirSync(backupsDir, { recursive: true });
    // 12 backups with increasing stamps; stamps sort lexicographically.
    for (let i = 0; i < 12; i++) {
      const stamp = String(1000 + i);
      writeFileSync(path.join(backupsDir, `pre-migrate-v0-${stamp}.db`), 'x');
    }
    writeFileSync(path.join(backupsDir, 'unrelated.txt'), 'x');
    const { pruneBackups } = await import('../db.js');
    pruneBackups(backupsDir, 10);
    const remaining = readdirSync(backupsDir);
    expect(remaining.filter((f) => f.startsWith('pre-migrate-'))).toHaveLength(10);
    expect(remaining.filter((f) => f.endsWith('.db'))).toHaveLength(10);
    expect(remaining).toContain('unrelated.txt');
    // Newest kept: stamp 1011 present, oldest 1000 gone.
    expect(remaining).toContain('pre-migrate-v0-1011.db');
    expect(remaining).not.toContain('pre-migrate-v0-1000.db');
    cleanupDir(dataDir);
  });
});
