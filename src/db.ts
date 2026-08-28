/**
 * The single database entry point (spec §3/§4): every table access in the
 * codebase goes through a handle produced here — no module opens its own
 * better-sqlite3 instance.
 *
 * Migration protocol (spec §5, reference CLAUDE.md §7):
 *  - Schema version lives in `PRAGMA user_version`.
 *  - Opening a database whose version is NEWER than the code refuses to start
 *    (downgrade is unsupported — newer rows may violate older assumptions).
 *  - Upgrading a database that already contains data copies the file into
 *    `data/backups/` first, then applies migrations forward-only, each inside
 *    a transaction together with its `user_version` bump.
 */
import { existsSync, mkdirSync, copyFileSync, statSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Database as SqliteDatabase, Statement } from 'better-sqlite3';
import type { AppConfig } from './config.js';
import type { Logger } from 'pino';
import { nowIso } from './time.js';
import { MIGRATION_V2_USERS } from './migrations/002-users.js';
import { MIGRATION_V3_WORKSPACES } from './migrations/003-workspaces.js';
import { MIGRATION_V4_PROFILES_AND_RUNTIME } from './migrations/004-profiles-runtime.js';
import { MIGRATION_V5_SCHEDULER } from './migrations/005-scheduler.js';

export class MigrationError extends Error {
  constructor(
    message: string,
    public readonly version: number,
  ) {
    super(message);
    this.name = 'MigrationError';
  }
}

/** Database is newer than the code understands; starting would be a downgrade. */
export class DowngradeUnsupportedError extends MigrationError {
  constructor(dbVersion: number, codeVersion: number) {
    super(
      `Database schema version ${dbVersion} is newer than supported version ${codeVersion}. ` +
        'Downgrades are not supported; restore a backup or upgrade the deployment.',
      dbVersion,
    );
    this.name = 'DowngradeUnsupportedError';
  }
}

export interface Migration {
  version: number;
  name: string;
  up: (db: SqliteDatabase) => void;
}

const MIGRATION_V1_SETTINGS: Migration = {
  version: 1,
  name: 'settings',
  up: (db) => {
    db.exec(`
      CREATE TABLE settings (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `);
  },
};

/** Ordered migration chain — append-only; never edit or reorder existing entries. */
export const MIGRATIONS: readonly Migration[] = [
  MIGRATION_V1_SETTINGS,
  MIGRATION_V2_USERS,
  MIGRATION_V3_WORKSPACES,
  MIGRATION_V4_PROFILES_AND_RUNTIME,
  MIGRATION_V5_SCHEDULER,
];

/**
 * Persisted web settings — the top layer of the config priority chain
 * (persisted web settings > env > code defaults, spec §3). Values are JSON
 * strings so later loops can store structured knobs; access is typed per key
 * at call sites. Only Loop-0-neutral plumbing lives here; specific setting
 * keys are owned by the loop that introduces them.
 */
export class SettingsStore {
  private readonly stmtGet: Statement;
  private readonly stmtSet: Statement;
  private readonly stmtAll: Statement;
  private readonly stmtDelete: Statement;

  constructor(db: SqliteDatabase) {
    this.stmtGet = db.prepare('SELECT value FROM settings WHERE key = ?');
    this.stmtSet = db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    );
    this.stmtAll = db.prepare('SELECT key, value FROM settings ORDER BY key');
    this.stmtDelete = db.prepare('DELETE FROM settings WHERE key = ?');
  }

  get(key: string): string | undefined {
    const row = this.stmtGet.get(key) as { value: string } | undefined;
    return row?.value;
  }

  getJson<T>(key: string): T | undefined {
    const raw = this.get(key);
    if (raw === undefined) return undefined;
    return JSON.parse(raw) as T;
  }

  set(key: string, value: string): void {
    this.stmtSet.run(key, value, nowIso());
  }

  setJson(key: string, value: unknown): void {
    this.set(key, JSON.stringify(value));
  }

  delete(key: string): void {
    this.stmtDelete.run(key);
  }

  entries(): Array<{ key: string; value: string }> {
    return this.stmtAll.all() as Array<{ key: string; value: string }>;
  }
}

export interface OpenDatabaseOptions {
  config: Pick<AppConfig, 'dataDir'>;
  logger: Logger;
  /** Test seam: run an explicit chain instead of the production MIGRATIONS. */
  migrations?: readonly Migration[];
  /** Test seam: skip file backup (in-memory databases). */
  backupDisabled?: boolean;
}

export class AppDb {
  readonly db: SqliteDatabase;
  readonly settings: SettingsStore;
  readonly path: string;

  constructor(db: SqliteDatabase, path: string) {
    this.db = db;
    this.path = path;
    this.settings = new SettingsStore(db);
  }

  /** Close the connection. Idempotent; safe during shutdown races. */
  close(): void {
    if (this.db.open) this.db.close();
  }

  schemaVersion(): number {
    return (this.db.pragma('user_version', { simple: true }) as number) ?? 0;
  }

  /**
   * Ordered statement registry lives with the accessor that uses it; this
   * helper only centralizes preparation so callers can't forget encoding
   * conventions (all timestamps UTC ISO strings).
   */
  prepare(sql: string): Statement {
    return this.db.prepare(sql);
  }
}

function applyPragmas(db: SqliteDatabase, logger: Logger): void {
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  const mode = (db.pragma('journal_mode', { simple: true }) as string) ?? '';
  if (mode !== 'wal') {
    logger.warn({ journalMode: mode }, 'wal mode unavailable; falling back to default journal');
  }
}

function backupDatabase(dbPath: string, backupsDir: string, fromVersion: number): string {
  mkdirSync(backupsDir, { recursive: true });
  const stamp = nowIso().replace(/[:.]/g, '-');
  const target = path.join(
    backupsDir,
    `pre-migrate-v${fromVersion}-${stamp}${path.extname(dbPath)}`,
  );
  copyFileSync(dbPath, target);
  for (const suffix of ['-wal', '-shm']) {
    const side = dbPath + suffix;
    if (existsSync(side)) copyFileSync(side, target + suffix);
  }
  return target;
}

/** Prune pre-migration backups beyond the newest N (default 10). */
export function pruneBackups(backupsDir: string, keep = 10): void {
  if (!existsSync(backupsDir)) return;
  const files = readdirSync(backupsDir)
    .filter((f) => f.startsWith('pre-migrate-') && f.endsWith('.db'))
    .sort()
    .reverse();
  for (const f of files.slice(keep)) {
    rmSync(path.join(backupsDir, f), { force: true });
  }
}

export function openDatabase(opts: OpenDatabaseOptions): AppDb {
  const { config, logger } = opts;
  const migrations = opts.migrations ?? MIGRATIONS;
  const codeVersion = migrations.length > 0 ? migrations[migrations.length - 1]!.version : 0;

  mkdirSync(config.dataDir, { recursive: true });
  const dbPath = path.join(config.dataDir, 'clawtide.db');
  const hadContent = existsSync(dbPath) && statSync(dbPath).size > 0;

  const db = new Database(dbPath);
  applyPragmas(db, logger);

  try {
    const dbVersion = (db.pragma('user_version', { simple: true }) as number) ?? 0;
    if (dbVersion > codeVersion) {
      throw new DowngradeUnsupportedError(dbVersion, codeVersion);
    }
    if (dbVersion < codeVersion && hadContent && opts.backupDisabled !== true) {
      const backup = backupDatabase(dbPath, path.join(config.dataDir, 'backups'), dbVersion);
      logger.info({ backup, fromVersion: dbVersion }, 'database backed up before migration');
      pruneBackups(path.join(config.dataDir, 'backups'));
    }
    for (const migration of migrations) {
      if (migration.version <= dbVersion) continue;
      const run = db.transaction(() => {
        migration.up(db);
        db.pragma(`user_version = ${migration.version}`);
      });
      run();
      logger.info({ version: migration.version, name: migration.name }, 'migration applied');
    }
  } catch (err) {
    db.close();
    throw err;
  }
  return new AppDb(db, dbPath);
}
