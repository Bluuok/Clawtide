/**
 * R20 schema: workspaces (RBAC resource + Home protection) and the IM-side
 * tables (channel accounts with encrypted credentials, mounts binding
 * conversations to workspaces/sessions). channel_accounts/mounts are created
 * here so R19 credential vault tests can exercise them; adapters arrive Loop 4.
 */
import type { Migration } from '../db.ts';

export const MIGRATION_V3_WORKSPACES: Migration = {
  version: 3,
  name: 'workspaces-and-channels',
  up: (db) => {
    db.exec(`
      CREATE TABLE workspaces (
        id             TEXT PRIMARY KEY,
        folder         TEXT NOT NULL UNIQUE,
        jid            TEXT NOT NULL UNIQUE,
        display_name   TEXT NOT NULL,
        is_home        INTEGER NOT NULL DEFAULT 0 CHECK (is_home IN (0,1)),
        created_by     TEXT REFERENCES users(id),
        execution_mode TEXT NOT NULL DEFAULT 'host',
        created_at     TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_workspaces_created_by ON workspaces(created_by);
      CREATE INDEX idx_workspaces_folder ON workspaces(folder);

      CREATE TABLE channel_accounts (
        id                  TEXT PRIMARY KEY,
        user_id             TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        channel             TEXT NOT NULL,
        credentials_enc     BLOB,
        owner_im_id         TEXT,
        default_workspace_id TEXT REFERENCES workspaces(id),
        created_at          TEXT NOT NULL,
        UNIQUE (user_id, channel)
      ) STRICT;

      CREATE TABLE channel_mounts (
        id                  TEXT PRIMARY KEY,
        account_id          TEXT NOT NULL REFERENCES channel_accounts(id) ON DELETE CASCADE,
        conversation_jid    TEXT NOT NULL,
        kind                TEXT NOT NULL CHECK (kind IN ('group','direct')),
        target_workspace_id TEXT REFERENCES workspaces(id),
        target_session_id   TEXT,
        UNIQUE (account_id, conversation_jid)
      ) STRICT;
    `);
  },
};
