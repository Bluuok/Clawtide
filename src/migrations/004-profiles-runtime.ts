/**
 * R15 + runtime foundation schema:
 *  - agent_profiles (four orthogonal segments), immutable version snapshots,
 *    two-stage drafts, partial-unique default index.
 *  - agent_sessions / chat_threads / chat_messages for persisted conversation
 *    context (SDK session id resumable across turns).
 *  - tool_events: the trace of every tool invocation "side effects are
 *    audit-able" (spec 防线 §5-8).
 */
import type { Migration } from '../db.ts';

export const MIGRATION_V4_PROFILES_AND_RUNTIME: Migration = {
  version: 4,
  name: 'profiles-and-agent-runtime',
  up: (db) => {
    db.exec(`
      CREATE TABLE agent_profiles (
        id              TEXT PRIMARY KEY,
        owner_user_id   TEXT NOT NULL REFERENCES users(id),
        name            TEXT NOT NULL,
        identity_prompt TEXT NOT NULL DEFAULT '',
        soul_prompt     TEXT NOT NULL DEFAULT '',
        agents_prompt   TEXT NOT NULL DEFAULT '',
        tools_prompt    TEXT NOT NULL DEFAULT '',
        prompt_mode     TEXT NOT NULL DEFAULT 'append' CHECK (prompt_mode IN ('append','replace')),
        version         INTEGER NOT NULL,
        identity_hash   TEXT NOT NULL,
        is_default      INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0,1)),
        status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','deleted')),
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL
      ) STRICT;
      -- One active default profile per owner (spec §6.3 item 4).
      CREATE UNIQUE INDEX idx_agent_profiles_one_default
        ON agent_profiles(owner_user_id) WHERE is_default = 1 AND status = 'active';
      CREATE INDEX idx_agent_profiles_owner ON agent_profiles(owner_user_id);

      -- Immutable history: restore never mutates a snapshot row.
      CREATE TABLE agent_profile_versions (
        id              TEXT PRIMARY KEY,
        agent_profile_id TEXT NOT NULL REFERENCES agent_profiles(id) ON DELETE CASCADE,
        version         INTEGER NOT NULL,
        identity_prompt TEXT NOT NULL DEFAULT '',
        soul_prompt     TEXT NOT NULL DEFAULT '',
        agents_prompt   TEXT NOT NULL DEFAULT '',
        tools_prompt    TEXT NOT NULL DEFAULT '',
        created_at      TEXT NOT NULL
      ) STRICT;
      CREATE UNIQUE INDEX idx_agent_profile_versions_once
        ON agent_profile_versions(agent_profile_id, version);

      -- Two-stage AI draft → confirmation-phrase publish.
      CREATE TABLE profile_drafts (
        id                 TEXT PRIMARY KEY,
        owner_user_id      TEXT NOT NULL REFERENCES users(id),
        draft_json         TEXT NOT NULL,
        confirmation_phrase TEXT NOT NULL,
        expires_at         TEXT NOT NULL,
        stage              TEXT NOT NULL DEFAULT 'draft' CHECK (stage IN ('draft','confirmed','expired','aborted')),
        created_at         TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_profile_drafts_owner ON profile_drafts(owner_user_id);

      CREATE TABLE agent_sessions (
        id            TEXT PRIMARY KEY,
        workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
        sdk_session_id TEXT NOT NULL,
        thread_id     TEXT NOT NULL REFERENCES chat_threads(id),
        profile_id    TEXT REFERENCES agent_profiles(id),
        created_at    TEXT NOT NULL,
        updated_at    TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_agent_sessions_workspace ON agent_sessions(workspace_id);

      CREATE TABLE chat_threads (
        id           TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL REFERENCES workspaces(id),
        kind         TEXT NOT NULL CHECK (kind IN ('group','direct')),
        title        TEXT NOT NULL DEFAULT '',
        created_at   TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_chat_threads_workspace ON chat_threads(workspace_id);

      CREATE TABLE chat_messages (
        id            TEXT PRIMARY KEY,
        thread_id     TEXT NOT NULL REFERENCES chat_threads(id) ON DELETE CASCADE,
        session_id    TEXT REFERENCES agent_sessions(id),
        role          TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
        content       TEXT NOT NULL,
        ts            TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_chat_messages_thread ON chat_messages(thread_id);

      CREATE TABLE tool_events (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id  TEXT NOT NULL REFERENCES agent_sessions(id),
        tool_name   TEXT NOT NULL,
        input_json  TEXT,
        output_json TEXT,
        ts          TEXT NOT NULL
      ) STRICT;
      CREATE INDEX idx_tool_events_session ON tool_events(session_id);
    `);
  },
};
