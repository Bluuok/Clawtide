/**
 * R19 user access + audit. All statements live with the accessor that uses
 * them (db.ts convention). Password hashes never leave this module except as
 * bcrypt strings for comparison inside auth.ts.
 */
import { randomBytes } from 'node:crypto';
import type { AppDb } from '../db.js';
import { nowIso } from '../time.js';
import type { SessionUser } from '../auth.js';

export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: 'admin' | 'member';
  created_at: string;
}

export type AuditEvent = 'login_success' | 'login_fail' | 'rate_limited' | 'logout';

export class UserStore {
  private readonly stmtById;
  private readonly stmtByName;
  private readonly stmtCount;
  private readonly stmtInsert;
  private readonly stmtAll;
  private readonly stmtDelete;
  private readonly stmtAudit;

  constructor(db: AppDb) {
    const raw = db.db;
    this.stmtById = raw.prepare('SELECT * FROM users WHERE id = ?');
    this.stmtByName = raw.prepare('SELECT * FROM users WHERE username = ?');
    this.stmtCount = raw.prepare('SELECT COUNT(*) AS n FROM users');
    this.stmtInsert = raw.prepare(
      'INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)',
    );
    this.stmtAll = raw.prepare(
      'SELECT id, username, role, created_at FROM users ORDER BY created_at',
    );
    this.stmtDelete = raw.prepare('DELETE FROM users WHERE id = ?');
    this.stmtAudit = raw.prepare(
      'INSERT INTO auth_audit_log (ts, username, ip, event, detail) VALUES (?, ?, ?, ?, ?)',
    );
  }

  byId(id: string): UserRow | undefined {
    return this.stmtById.get(id) as UserRow | undefined;
  }

  byName(username: string): UserRow | undefined {
    return this.stmtByName.get(username) as UserRow | undefined;
  }

  count(): number {
    return (this.stmtCount.get() as { n: number }).n;
  }

  create(username: string, passwordHash: string, role: 'admin' | 'member'): UserRow {
    const id = randomBytes(16).toString('hex');
    this.stmtInsert.run(id, username, passwordHash, role, nowIso());
    return this.byId(id)!;
  }

  list(): Array<{ id: string; username: string; role: string; created_at: string }> {
    return this.stmtAll.all() as Array<{
      id: string;
      username: string;
      role: string;
      created_at: string;
    }>;
  }

  deleteById(id: string): boolean {
    return this.stmtDelete.run(id).changes > 0;
  }

  audit(event: AuditEvent, username: string | null, ip: string | null, detail?: string): void {
    this.stmtAudit.run(nowIso(), username, ip, event, detail ?? null);
  }

  toSessionUser(row: UserRow): SessionUser {
    return { id: row.id, username: row.username, role: row.role };
  }
}
