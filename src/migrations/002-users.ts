/**
 * R19 schema: users, browser sessions, and the login audit trail.
 * Password hashes are bcrypt(12); session tokens are stored as 64-hex opaque
 * strings with a unique index (lookup by token is the hot path).
 */
import type { Migration } from '../db.ts';

export const MIGRATION_V2_USERS: Migration = {
  version: 2,
  name: 'users-and-sessions',
  up: (db) => {
    db.exec(`
      CREATE TABLE users (
        id            TEXT PRIMARY KEY,
        username      TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
        created_at    TEXT NOT NULL
      ) STRICT;

      CREATE TABLE user_sessions (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        token      TEXT NOT NULL UNIQUE,
        ip_address TEXT,
        user_agent TEXT,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_user_sessions_user_id ON user_sessions(user_id);
      CREATE INDEX idx_user_sessions_expires ON user_sessions(expires_at);

      CREATE TABLE auth_audit_log (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        ts       TEXT NOT NULL,
        username TEXT,
        ip       TEXT,
        event    TEXT NOT NULL CHECK (event IN ('login_success','login_fail','rate_limited','logout')),
        detail   TEXT
      ) STRICT;
      CREATE INDEX idx_auth_audit_ts ON auth_audit_log(ts);
    `);
  },
};
