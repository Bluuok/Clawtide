import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { WebSocket } from 'ws';
import { startServer, type RunningServer } from '../server.js';
import { makeTestConfig, testLogger, cleanupDir } from '../test-support/harness.js';

describe('saved provider settings reach the execution boundary', () => {
  let server: RunningServer;
  let cookie: string;
  let base: string;
  let workspaceId: string;
  let calls: Options[];
  beforeEach(async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', 'synthetic-env-key');
    vi.stubEnv('ANTHROPIC_BASE_URL', 'https://env.invalid');
    calls = [];
    server = await startServer({
      config: makeTestConfig(),
      logger: testLogger(),
      schedulerAutoStart: false,
      imAutoStart: false,
      executeTurn: async function* ({ options }) {
        calls.push(options);
        yield { type: 'result', subtype: 'success' } as SDKMessage;
      },
    });
    base = 'http://127.0.0.1:' + server.port;
    const setup = await fetch(base + '/auth/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'provider_admin', password: 'synthetic-password' }),
    });
    expect(setup.status).toBe(201);
    cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    const res = await fetch(base + '/workspaces', { headers: { cookie } });
    workspaceId = ((await res.json()) as { workspaces: { id: string }[] }).workspaces[0]!.id;
  });
  afterEach(async () => {
    await server.stop();
    cleanupDir(server.config.dataDir);
    vi.unstubAllEnvs();
  });
  async function save(apiKey?: string, baseUrl = 'https://saved.invalid') {
    const res = await fetch(base + '/settings/provider', {
      method: 'PUT',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ baseUrl, ...(apiKey !== undefined ? { apiKey } : {}) }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain('synthetic-saved');
    const view = await fetch(base + '/settings/provider', { headers: { cookie } });
    expect(await view.text()).not.toContain('synthetic-saved');
  }
  it('HTTP uses saved key; rotation and omitted key apply without restart', async () => {
    vi.stubEnv('ANTHROPIC_API_KEY', '');
    await save('synthetic-saved-1');
    const runtime = server.services.runtime;
    expect(runtime.isConfigured()).toBe(true);
    const session = runtime.createSession({ workspaceId });
    const res = await fetch(base + '/chat/sessions/' + session.id + '/messages', {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ content: 'first' }),
    });
    expect(res.status).toBe(200);
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]!.env).toMatchObject({
      ANTHROPIC_API_KEY: 'synthetic-saved-1',
      ANTHROPIC_BASE_URL: 'https://saved.invalid',
    });
    await save('synthetic-saved-2');
    await runtime.sendMessage(session, 'rotated', () => {});
    await save(undefined, 'https://updated.invalid');
    await runtime.sendMessage(session, 'retained', () => {});
    expect(calls[1]!.env?.ANTHROPIC_API_KEY).toBe('synthetic-saved-2');
    expect(calls[2]!.env).toMatchObject({
      ANTHROPIC_API_KEY: 'synthetic-saved-2',
      ANTHROPIC_BASE_URL: 'https://updated.invalid',
    });
    await save('', '');
    expect(runtime.isConfigured()).toBe(false);
    const events: string[] = [];
    await runtime.sendMessage(session, 'cleared', (e) => events.push(e.type));
    expect(events).toContain('error');
    expect(calls).toHaveLength(3);
  });
  it('clearing overrides falls back to environment for both key and endpoint', async () => {
    await save('synthetic-saved');
    await save('', '');
    const runtime = server.services.runtime;
    await runtime.sendMessage(runtime.createSession({ workspaceId }), 'env', () => {});
    expect(calls[0]!.env).toMatchObject({
      ANTHROPIC_API_KEY: 'synthetic-env-key',
      ANTHROPIC_BASE_URL: 'https://env.invalid',
    });
  });
  it('authenticated WebSocket uses saved settings', async () => {
    await save('synthetic-saved-ws');
    const session = server.services.runtime.createSession({ workspaceId });
    const ws = new WebSocket('ws://127.0.0.1:' + server.port + '/ws', { headers: { cookie } });
    try {
      await new Promise<void>((resolve, reject) => {
        ws.once('open', resolve);
        ws.once('error', reject);
      });
      ws.send(JSON.stringify({ type: 'chat', sessionId: session.id, content: 'ws turn' }));
      await expect.poll(() => calls.length).toBe(1);
      expect(calls[0]!.env?.ANTHROPIC_API_KEY).toBe('synthetic-saved-ws');
    } finally {
      ws.terminate();
    }
  });
  it('scheduler resolves saved settings on every immediate run, including repeat after completion', async () => {
    await save('synthetic-saved-task');
    const ws = server.services.workspaceStore.byId(workspaceId)!;
    const task = server.services.taskStore.create({
      workspaceId,
      prompt: 'task',
      scheduleType: 'once',
      runAt: '2099-01-01T00:00:00.000Z',
      contextMode: 'isolated',
      createdBy: ws.created_by!,
    });
    const scheduler = server.services.scheduler;
    const firstResponse = await fetch(base + '/tasks/' + task.id + '/run', {
      method: 'POST',
      headers: { cookie },
    });
    expect(firstResponse.status).toBe(202);
    const first = (await firstResponse.json()) as { queued: boolean; runId: string };
    expect(first.queued).toBe(true);
    expect(await scheduler.runClaimed(scheduler.claimOne(first.runId!)!)).toBe('success');
    await save('synthetic-saved-task-2');
    const secondResponse = await fetch(base + '/tasks/' + task.id + '/run', {
      method: 'POST',
      headers: { cookie },
    });
    expect(secondResponse.status).toBe(202);
    const second = (await secondResponse.json()) as { queued: boolean; runId: string };
    expect(second.queued).toBe(true);
    expect(second.runId).not.toBe(first.runId);
    expect(await scheduler.runClaimed(scheduler.claimOne(second.runId!)!)).toBe('success');
    expect(calls.map((c) => c.env?.ANTHROPIC_API_KEY)).toEqual([
      'synthetic-saved-task',
      'synthetic-saved-task-2',
    ]);
  });
});
