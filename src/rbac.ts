/**
 * R20 — RBAC tri-state over workspaces. Ownership drives everything; the
 * admin role has NO bypass here, and that is a structural fact, not a rule to
 * remember: `role` arrives as a parameter and the logic never reads it. The
 * admin role matters only at an independent gate (host execution permission /
 * system config), which is a separate concern from ownership.
 *
 * All three functions answer the same resource shape:
 *   { jid, is_home, folder, created_by }
 *
 * Decision table:
 *   is_home            → visible/modifiable by owner only; deletable by NOBODY.
 *   IM group (jid not `web:`)
 *     created_by set   → true iff caller id matches (any mismatch → false).
 *     created_by NULL  → legacy row: re-derive ownership from a sibling home
 *                        workspace in the same folder; if that fails → DENY.
 *   Web group (`web:`) → caller id === created_by.
 */
export interface RbacUser {
  id: string;
  role: 'admin' | 'member';
}

export interface WorkspaceResource {
  jid: string;
  /** STRICT-mode SQLite: stored as 0|1, i.e. `0 | 1` at this layer. */
  is_home: 0 | 1;
  folder: string;
  created_by: string | null;
}

export type AccessVerdict = 'allow' | 'deny';

/**
 * Sibling-home resolver for legacy rows: given a folder, return the owning
 * user id of the home workspace in that folder, or null. The caller (service
 * layer) supplies this from the DB — the policy stays pure.
 */
export type SiblingHomeResolver = (folder: string) => string | null;

export function canAccessGroup(
  user: RbacUser,
  ws: WorkspaceResource,
  resolveSiblingHome: SiblingHomeResolver,
): AccessVerdict {
  return decide(user, ws, 'access', resolveSiblingHome);
}

export function canModifyGroup(
  user: RbacUser,
  ws: WorkspaceResource,
  resolveSiblingHome: SiblingHomeResolver,
): AccessVerdict {
  return decide(user, ws, 'modify', resolveSiblingHome);
}

export function canDeleteGroup(
  user: RbacUser,
  ws: WorkspaceResource,
  resolveSiblingHome: SiblingHomeResolver,
): AccessVerdict {
  return decide(user, ws, 'delete', resolveSiblingHome);
}

function decide(
  user: RbacUser,
  ws: WorkspaceResource,
  op: 'access' | 'modify' | 'delete',
  resolveSiblingHome: SiblingHomeResolver,
): AccessVerdict {
  // Home workspaces: owner can see and modify; nobody — admin included —
  // can ever delete one.
  if (ws.is_home) {
    if (op === 'delete') return 'deny';
    return ws.created_by !== null && ws.created_by === user.id ? 'allow' : 'deny';
  }

  const isWebGroup = ws.jid.startsWith('web:');
  if (!isWebGroup) {
    // IM group.
    if (ws.created_by !== null) {
      return ws.created_by === user.id ? 'allow' : 'deny';
    }
    // Legacy row: re-derive from the folder's home workspace.
    const ownerId = resolveSiblingHome(ws.folder);
    // deny by default when ownership cannot be re-derived.
    return ownerId !== null && ownerId === user.id ? 'allow' : 'deny';
  }

  // Web group.
  return ws.created_by !== null && ws.created_by === user.id ? 'allow' : 'deny';
}
