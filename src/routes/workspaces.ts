/**
 * Workspace route family (R20 surface): list/get/create/update/delete with
 * tri-state RBAC enforcement and cross-owner hiding — a workspace owned by
 * someone else returns 404, never 403, so existence itself is not disclosed.
 * Home workspaces are auto-created per user at setup; they are undeletable
 * (canDeleteGroup denies unconditionally) and the console explains why.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { WebError } from '../errors.js';
import { canAccessGroup, canModifyGroup, canDeleteGroup, type RbacUser } from '../rbac.js';
import type { WorkspaceStore, WorkspaceRow } from '../stores/workspaces.js';
import { requireUser } from '../auth-context.js';
import type { SessionUser } from '../auth.js';
import type { AppEnv } from '../web.js';

const createSchema = z.object({
  displayName: z.string().min(1).max(120),
  folder: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9_-]+$/)
    .optional(),
});

const updateSchema = z.object({
  displayName: z.string().min(1).max(120),
});

export interface WorkspaceRoutesDeps {
  workspaceStore: WorkspaceStore;
}

export function registerWorkspaceRoutes(app: Hono<AppEnv>, deps: WorkspaceRoutesDeps): void {
  const { workspaceStore } = deps;
  const resolve = workspaceStore.resolveSiblingHome;

  const requireVisible = (user: SessionUser, id: string): WorkspaceRow => {
    const ws = workspaceStore.byId(id);
    if (ws === undefined || canAccessGroup(toRbac(user), ws, resolve) !== 'allow') {
      // Foreign or nonexistent — same answer, no oracle.
      throw new WebError('not_found', 'workspace not found');
    }
    return ws;
  };

  app.get('/workspaces', async (c) => {
    const user = requireUser(c);
    const visible = workspaceStore
      .list()
      .filter((ws) => canAccessGroup(toRbac(user), ws, resolve) === 'allow');
    return c.json({ workspaces: visible.map(toApi) });
  });

  app.post('/workspaces', async (c) => {
    const user = requireUser(c);
    const body = createSchema.parse(await c.req.json().catch(() => undefined));
    const folder = body.folder ?? `ws-${randomBytes(4).toString('hex')}`;
    if (workspaceStore.byFolder(folder) !== undefined) {
      throw new WebError('conflict', 'folder already exists');
    }
    workspaceStore.create({
      folder,
      jid: `web:${folder}`,
      displayName: body.displayName,
      isHome: false,
      createdBy: user.id,
    });
    return c.json({ workspace: toApi(workspaceStore.byFolder(folder)!) }, 201);
  });

  app.get('/workspaces/:id', async (c) => {
    const user = requireUser(c);
    return c.json({ workspace: toApi(requireVisible(user, c.req.param('id'))) });
  });

  app.patch('/workspaces/:id', async (c) => {
    const user = requireUser(c);
    const ws = requireVisible(user, c.req.param('id'));
    if (canModifyGroup(toRbac(user), ws, resolve) !== 'allow') {
      throw new WebError('not_found', 'workspace not found');
    }
    const body = updateSchema.parse(await c.req.json().catch(() => undefined));
    workspaceStore.rename(ws.id, body.displayName);
    return c.json({ workspace: toApi(workspaceStore.byId(ws.id)!) });
  });

  app.delete('/workspaces/:id', async (c) => {
    const user = requireUser(c);
    const ws = workspaceStore.byId(c.req.param('id'));
    if (ws === undefined) {
      throw new WebError('not_found', 'workspace not found');
    }
    const visible = canAccessGroup(toRbac(user), ws, resolve) === 'allow';
    // canDeleteGroup: home → deny for EVERYONE (admin included); otherwise
    // ownership decides. Non-visible resources stay 404.
    if (canDeleteGroup(toRbac(user), ws, resolve) !== 'allow') {
      if (!visible) throw new WebError('not_found', 'workspace not found');
      throw new WebError('forbidden', 'home workspace cannot be deleted');
    }
    workspaceStore.deleteById(ws.id);
    return c.json({ ok: true });
  });
}

function toRbac(user: SessionUser): RbacUser {
  return { id: user.id, role: user.role };
}

function toApi(ws: WorkspaceRow) {
  return {
    id: ws.id,
    folder: ws.folder,
    jid: ws.jid,
    displayName: ws.display_name,
    isHome: ws.is_home === 1, // STRICT-mode INTEGER 0|1 → boolean
    createdBy: ws.created_by,
    createdAt: ws.created_at,
  };
}
