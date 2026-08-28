/**
 * Scheduled task route family: create/list/get/pause/resume/delete + a
 * run-now trigger. Authorization uses the same sessionMiddleware + RBAC gate
 * as chat: only a user who can access the workspace can act on its tasks
 * (foreign resources 404). Task execution itself never carries a user session
 * — scheduled runs go through the scheduler's internal path, not through
 * publish-capable contexts (spec §6.3 item 5).
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { WebError } from '../errors.js';
import type { WorkspaceStore } from '../stores/workspaces.js';
import type { TaskStore } from '../stores/tasks.js';
import type { TaskScheduler } from '../task-scheduler.js';
import { canAccessGroup } from '../rbac.js';
import { requireUser } from '../auth-context.js';
import type { AppEnv } from '../web.js';

const cronField = z
  .string()
  .max(120)
  .refine((v) => {
    // Structural validation only; the scheduler re-parses with cron-parser at
    // materialization time and a malformed expression simply never fires.
    const fields = v.trim().split(/\s+/);
    return fields.length === 5 || fields.length === 6;
  }, 'cron expression must have 5 or 6 fields');

const createSchema = z
  .object({
    workspaceId: z.string().min(1),
    prompt: z.string().min(1).max(100_000),
    scheduleType: z.enum(['cron', 'interval', 'once']),
    cronExpr: cronField.optional(),
    intervalSeconds: z.number().int().min(60).optional(),
    runAt: z.string().datetime().optional(),
    contextMode: z.enum(['group', 'isolated']).default('isolated'),
  })
  .refine(
    (v) =>
      (v.scheduleType === 'cron' && !!v.cronExpr) ||
      (v.scheduleType === 'interval' && v.intervalSeconds !== undefined) ||
      (v.scheduleType === 'once' && !!v.runAt),
    { message: 'scheduleType requires a matching cronExpr / intervalSeconds / runAt' },
  );

export interface TaskRoutesDeps {
  taskStore: TaskStore;
  workspaceStore: WorkspaceStore;
  scheduler: TaskScheduler;
}

export function registerTaskRoutes(app: Hono<AppEnv>, deps: TaskRoutesDeps): void {
  const { taskStore, workspaceStore, scheduler } = deps;

  const requireAccessibleWorkspace = (
    user: { id: string; role: 'admin' | 'member' },
    workspaceId: string,
  ) => {
    const ws = workspaceStore.byId(workspaceId);
    if (
      ws === undefined ||
      canAccessGroup(user, ws, workspaceStore.resolveSiblingHome) !== 'allow'
    ) {
      throw new WebError('not_found', 'workspace not found');
    }
    return ws;
  };

  const requireTask = (user: { id: string; role: 'admin' | 'member' }, taskId: string) => {
    const task = taskStore.byId(taskId);
    if (task === undefined || task.deleted_at !== null) {
      throw new WebError('not_found', 'task not found');
    }
    requireAccessibleWorkspace(user, task.workspace_id);
    return task;
  };

  app.get('/tasks', (c) => {
    const user = requireUser(c);
    const workspaceId = c.req.query('workspaceId');
    if (!workspaceId) throw new WebError('bad_request', 'workspaceId query parameter required');
    requireAccessibleWorkspace(user, workspaceId);
    return c.json({ tasks: taskStore.listForWorkspace(workspaceId).map(toApi) });
  });

  app.post('/tasks', async (c) => {
    const user = requireUser(c);
    const body = createSchema.parse(await c.req.json());
    requireAccessibleWorkspace(user, body.workspaceId);
    const task = taskStore.create({
      workspaceId: body.workspaceId,
      prompt: body.prompt,
      scheduleType: body.scheduleType,
      cronExpr: body.cronExpr ?? null,
      intervalSeconds: body.intervalSeconds ?? null,
      runAt: body.runAt ?? null,
      contextMode: body.contextMode,
      createdBy: user.id,
    });
    return c.json({ task: toApi(task) }, 201);
  });

  app.get('/tasks/:id', (c) => {
    const user = requireUser(c);
    const task = requireTask(user, c.req.param('id'));
    return c.json({ task: toApi(task), runs: scheduler.runsForTask(task.id).map(toRunApi) });
  });

  app.post('/tasks/:id/pause', (c) => {
    const user = requireUser(c);
    const task = requireTask(user, c.req.param('id'));
    taskStore.setStatus(task.id, 'paused');
    return c.json({ task: toApi(taskStore.byId(task.id)!) });
  });

  app.post('/tasks/:id/resume', (c) => {
    const user = requireUser(c);
    const task = requireTask(user, c.req.param('id'));
    taskStore.setStatus(task.id, 'active');
    return c.json({ task: toApi(taskStore.byId(task.id)!) });
  });

  app.delete('/tasks/:id', (c) => {
    const user = requireUser(c);
    const task = requireTask(user, c.req.param('id'));
    taskStore.softDelete(task.id);
    return c.json({ deleted: true });
  });

  /** Run now: the same materialization path as scheduled occurrences. */
  app.post('/tasks/:id/run', (c) => {
    const user = requireUser(c);
    const task = requireTask(user, c.req.param('id'));
    const result = scheduler.runNow(task.id);
    if (!result.queued) throw new WebError('conflict', 'task is not active');
    return c.json({ queued: true, ...(result.runId ? { runId: result.runId } : {}) }, 202);
  });
}

function toApi(t: {
  id: string;
  workspace_id: string;
  prompt: string;
  schedule_type: string;
  cron_expr: string | null;
  interval_seconds: number | null;
  run_at: string | null;
  context_mode: string;
  status: string;
  created_at: string;
}) {
  return {
    id: t.id,
    workspaceId: t.workspace_id,
    prompt: t.prompt,
    scheduleType: t.schedule_type,
    cronExpr: t.cron_expr,
    intervalSeconds: t.interval_seconds,
    runAt: t.run_at,
    contextMode: t.context_mode,
    status: t.status,
    createdAt: t.created_at,
  };
}

function toRunApi(r: {
  id: string;
  task_id: string;
  status: string;
  attempt: number;
  available_at: string;
  started_at: string | null;
  finished_at: string | null;
  result: string | null;
  error: string | null;
}) {
  return {
    id: r.id,
    taskId: r.task_id,
    status: r.status,
    attempt: r.attempt,
    availableAt: r.available_at,
    startedAt: r.started_at,
    finishedAt: r.finished_at,
    result: r.result,
    error: r.error,
  };
}
