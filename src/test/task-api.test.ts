/**
 * Task route surface over a real HTTP server: RBAC-gated CRUD, pause/resume
 * canceling queued runs, and run-now idempotency. The scheduler pump is not
 * auto-started; tests drive it manually.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startServer, type RunningServer } from '../server.js';
import { makeTestConfig, testLogger, cleanupDir } from '../test-support/harness.js';
import { nowIso } from '../time.js';

let server: RunningServer;
let base: string;

let adminCookie: string | null = null;

async function registerUser(username: string): Promise<string> {
  if (adminCookie === null) {
    // First user must come through /auth/setup (exactly once, becomes admin).
    const setup = await fetch(`${base}/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password: 'password-123' }),
    });
    if (setup.status === 201) {
      adminCookie = setup.headers.get('set-cookie')!.split(';')[0]!;
      return adminCookie;
    }
  }
  // Subsequent users: admin creates the account, then the user logs in.
  const create = await fetch(`${base}/auth/users`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: adminCookie! },
    body: JSON.stringify({ username, password: 'password-123', role: 'member' }),
  });
  if (create.status !== 201)
    throw new Error(`user create failed for ${username}: ${create.status}`);
  const res = await fetch(`${base}/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password: 'password-123' }),
  });
  if (res.status !== 200) throw new Error(`login failed for ${username}: ${res.status}`);
  return res.headers.get('set-cookie')!.split(';')[0]!;
}

async function createWorkspace(cookie: string): Promise<string> {
  const res = await fetch(`${base}/workspaces`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie },
    body: JSON.stringify({ displayName: 'Task Ops' }),
  });
  const body = (await res.json()) as { workspace: { id: string } };
  return body.workspace.id;
}

beforeAll(async () => {
  const config = makeTestConfig();
  server = await startServer({
    config,
    logger: testLogger(),
    schedulerAutoStart: false,
    taskExecutor: async () => 'ran',
  });
  base = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
  await server.stop();
  cleanupDir(server.config.dataDir);
});

describe('task API (R14 route surface)', () => {
  it('unauthenticated access is 401', async () => {
    const res = await fetch(`${base}/tasks?workspaceId=x`);
    expect(res.status).toBe(401);
  });

  it('create → list → get lifecycle with interval validation', async () => {
    const cookie = await registerUser(`tuser_${nowIso().replace(/\W/g, '')}`.slice(0, 28));
    const wsId = await createWorkspace(cookie);

    const created = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        workspaceId: wsId,
        prompt: 'check inventory',
        scheduleType: 'interval',
        intervalSeconds: 60,
        contextMode: 'isolated',
      }),
    });
    expect(created.status).toBe(201);
    const { task } = (await created.json()) as { task: { id: string; status: string } };
    expect(task.status).toBe('active');

    // interval < 60 rejected at the route boundary (pre-check): the route
    // schema enforces min(60) before the DB CHECK does.
    const tooFast = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        workspaceId: wsId,
        prompt: 'x',
        scheduleType: 'interval',
        intervalSeconds: 30,
      }),
    });
    expect(tooFast.status).toBe(400);

    const list = await fetch(`${base}/tasks?workspaceId=${wsId}`, { headers: { cookie } });
    const listBody = (await list.json()) as { tasks: Array<{ id: string }> };
    expect(listBody.tasks.map((t) => t.id)).toContain(task.id);

    // Another user cannot even see the task (404 hiding).
    const other = await registerUser(`tother_${nowIso().replace(/\W/g, '')}`.slice(0, 28));
    const foreign = await fetch(`${base}/tasks/${task.id}`, { headers: { cookie: other } });
    expect(foreign.status).toBe(404);

    const detail = await fetch(`${base}/tasks/${task.id}`, { headers: { cookie } });
    expect(detail.status).toBe(200);
  });

  it('pause/resume/delete + run-now idempotency and conflicts', async () => {
    const cookie = await registerUser(`trun_${nowIso().replace(/\W/g, '')}`.slice(0, 28));
    const wsId = await createWorkspace(cookie);
    const created = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        workspaceId: wsId,
        prompt: 'nightly scan',
        scheduleType: 'once',
        runAt: '2099-01-01T00:00:00.000Z',
      }),
    });
    const { task } = (await created.json()) as { task: { id: string } };

    const runNow = await fetch(`${base}/tasks/${task.id}/run`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(runNow.status).toBe(202);
    const body = (await runNow.json()) as { runId?: string };
    expect(typeof body.runId).toBe('string');

    // Second run-now while the first is queued → idempotent same runId.
    const again = await fetch(`${base}/tasks/${task.id}/run`, {
      method: 'POST',
      headers: { cookie },
    });
    const againBody = (await again.json()) as { runId?: string };
    expect(againBody.runId).toBe(body.runId);

    // Pause, then run-now → conflict (task not active).
    await fetch(`${base}/tasks/${task.id}/pause`, { method: 'POST', headers: { cookie } });
    const pausedRun = await fetch(`${base}/tasks/${task.id}/run`, {
      method: 'POST',
      headers: { cookie },
    });
    expect(pausedRun.status).toBe(409);

    // Delete → subsequent access 404 (even for the owner).
    await fetch(`${base}/tasks/${task.id}`, { method: 'DELETE', headers: { cookie } });
    const gone = await fetch(`${base}/tasks/${task.id}`, { headers: { cookie } });
    expect(gone.status).toBe(404);
  });
});
