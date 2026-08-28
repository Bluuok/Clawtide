/**
 * R20 workspace store: rows + the sibling-home resolver the RBAC functions
 * consume. Web groups use `web:`-prefixed jids (created for the console);
 * IM groups carry the channel conversation jid.
 */
import { randomBytes } from 'node:crypto';
import type { AppDb } from '../db.js';
import { nowIso } from '../time.js';
import type { WorkspaceResource } from '../rbac.js';

export interface WorkspaceRow extends WorkspaceResource {
  id: string;
  display_name: string;
  execution_mode: string;
  created_at: string;
}

export class WorkspaceStore {
  private readonly stmtById;
  private readonly stmtByFolder;
  private readonly stmtByJid;
  private readonly stmtHomeOwnerByFolder;
  private readonly stmtInsert;
  private readonly stmtAll;
  private readonly stmtDelete;
  private readonly stmtUpdateName;

  constructor(db: AppDb) {
    const raw = db.db;
    this.stmtById = raw.prepare('SELECT * FROM workspaces WHERE id = ?');
    this.stmtByFolder = raw.prepare('SELECT * FROM workspaces WHERE folder = ?');
    this.stmtByJid = raw.prepare('SELECT * FROM workspaces WHERE jid = ?');
    // Legacy re-derivation: owner of the home workspace in a folder.
    this.stmtHomeOwnerByFolder = raw.prepare(
      'SELECT created_by FROM workspaces WHERE folder = ? AND is_home = 1 AND created_by IS NOT NULL LIMIT 1',
    );
    this.stmtInsert = raw.prepare(
      `INSERT INTO workspaces (id, folder, jid, display_name, is_home, created_by, execution_mode, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'host', ?)`,
    );
    this.stmtAll = raw.prepare('SELECT * FROM workspaces ORDER BY created_at');
    this.stmtDelete = raw.prepare('DELETE FROM workspaces WHERE id = ?');
    this.stmtUpdateName = raw.prepare('UPDATE workspaces SET display_name = ? WHERE id = ?');
  }

  byId(id: string): WorkspaceRow | undefined {
    return this.stmtById.get(id) as WorkspaceRow | undefined;
  }

  byFolder(folder: string): WorkspaceRow | undefined {
    return this.stmtByFolder.get(folder) as WorkspaceRow | undefined;
  }

  byJid(jid: string): WorkspaceRow | undefined {
    return this.stmtByJid.get(jid) as WorkspaceRow | undefined;
  }

  list(): WorkspaceRow[] {
    return this.stmtAll.all() as WorkspaceRow[];
  }

  create(input: {
    folder: string;
    jid: string;
    displayName: string;
    isHome: boolean;
    createdBy: string | null;
  }): WorkspaceRow {
    const id = randomBytes(16).toString('hex');
    this.stmtInsert.run(
      id,
      input.folder,
      input.jid,
      input.displayName,
      input.isHome ? 1 : 0,
      input.createdBy,
      nowIso(),
    );
    return this.byId(id)!;
  }

  /**
   * Per-user home workspace (spec R20: is_home=1, owned, never deletable).
   * Folder convention: `home-<username>`; jid `web:home-<username>`.
   * Idempotent — safe to call on every login.
   */
  ensureHome(username: string, userId: string): WorkspaceRow {
    const folder = `home-${username}`;
    const existing = this.byFolder(folder);
    if (existing !== undefined) return existing;
    return this.create({
      folder,
      jid: `web:${folder}`,
      displayName: `${username}'s Home`,
      isHome: true,
      createdBy: userId,
    });
  }

  rename(id: string, displayName: string): boolean {
    return this.stmtUpdateName.run(displayName, id).changes > 0;
  }

  deleteById(id: string): boolean {
    return this.stmtDelete.run(id).changes > 0;
  }

  /** RBAC sibling-home resolver (legacy ownership re-derivation). */
  readonly resolveSiblingHome = (folder: string): string | null => {
    const row = this.stmtHomeOwnerByFolder.get(folder) as { created_by: string } | undefined;
    return row?.created_by ?? null;
  };
}
