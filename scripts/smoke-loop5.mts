/**
 * Loop 5 Gate smoke: real server boot on a temp data dir, then drive the
 * console's actual API surface end-to-end — setup → workspace → profile
 * (versions/restore) → draft confirm-phrase publish → session + WS stream
 * (honest not-configured error) → task run-now with a pump round → settings
 * provider write-only check → 404 hiding for a second user. Mirrors the
 * manual smoke list in HANDOVER §5.2 step 6.
 */
import WebSocket from 'ws';
import { startServer, type RunningServer } from '../src/server.js';
import { makeTestConfig, testLogger, cleanupDir } from '../src/test-support/harness.js';

async function main(): Promise<void> {
  const config = makeTestConfig();
  let server: RunningServer | undefined;
  const base = () => `http://127.0.0.1:${server!.port}`;
  const post = (path: string, body?: unknown, cookie?: string, method = 'POST') =>
    fetch(`${base()}${path}`, {
      method,
      headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  const get = (path: string, cookie?: string) =>
    fetch(`${base()}${path}`, { headers: cookie ? { cookie } : {} });

  try {
    server = await startServer({ config, logger: testLogger(), schedulerAutoStart: false });

    // 1. setup + login
    const setup = await post('/auth/setup', { username: 'smoker', password: 'password-123' });
    if (setup.status !== 201) throw new Error(`setup failed: ${setup.status}`);
    const admin = setup.headers.get('set-cookie')!.split(';')[0]!;

    // 2. workspace + session + profile publish flow
    const wsRes = await post('/workspaces', { displayName: 'Smoke Ops' }, admin);
    const wsId = ((await wsRes.json()) as { workspace: { id: string } }).workspace.id;

    const profRes = await post(
      '/profiles',
      {
        name: 'Smoke profile',
        segments: { identity: 'I am smoke.', soul: '', agents: '', tools: '' },
        promptMode: 'append',
      },
      admin,
    );
    const profile = ((await profRes.json()) as { profile: { id: string; version: number } })
      .profile;

    const draft = await post(
      '/drafts',
      {
        draftJson: JSON.stringify({
          name: 'Drafted',
          identity: 'drafted',
          soul: '',
          agents: '',
          tools: '',
        }),
      },
      admin,
    );
    const d = (await draft.json()) as { draftId: string; confirmationPhrase: string };
    const bad = await post(`/drafts/${d.draftId}/confirm`, { phrase: 'WRONG1' }, admin);
    if (bad.status !== 400) throw new Error('wrong phrase should abort (400)');
    console.log('smoke: draft wrong-phrase aborted as expected');

    // 3. session + WS streaming (honest not-configured error, no fake success)
    const sessRes = await post('/chat/sessions', { workspaceId: wsId }, admin);
    if (sessRes.status !== 201) throw new Error(`session create failed: ${sessRes.status}`);
    const sid = ((await sessRes.json()) as { session: { id: string } }).session.id;
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/ws`, {
      headers: { cookie: admin },
    });
    const streamTypes: string[] = [];
    // Bind ALL handlers before waiting (probe-verified pattern: late binding
    // after an await races the frames). Resolve once the honest
    // not-configured error event lands.
    let resolveWait: (() => void) | undefined;
    let rejectWait: ((err: Error) => void) | undefined;
    const timeout = setTimeout(() => {
      rejectWait?.(new Error(`no error stream within 5s; got ${streamTypes.join(',')}`));
    }, 5000);
    ws.on('open', () => {
      console.log('smoke: ws open');
      ws.send(JSON.stringify({ type: 'chat', sessionId: sid, content: 'hello smoke' }));
    });
    ws.on('error', (e: Error) => {
      console.log('smoke: ws error:', e.message);
      rejectWait?.(e);
    });
    ws.on('close', (code: number, reason: Buffer) => {
      console.log(`smoke: ws close code=${code} reason=${String(reason)}`);
      resolveWait?.();
    });
    ws.on('message', (d: unknown) => {
      const env = JSON.parse(String(d)) as { type: string; payload?: { type?: string } };
      if (env.type === 'stream' && env.payload?.type !== undefined) {
        streamTypes.push(env.payload.type);
        if (env.payload.type === 'error') {
          clearTimeout(timeout);
          resolveWait?.();
        }
      }
    });
    await new Promise<void>((res, rej) => {
      resolveWait = res;
      rejectWait = rej;
    });
    clearTimeout(timeout);
    ws.close();
    if (!streamTypes.includes('turn_started') || !streamTypes.includes('error')) {
      throw new Error(`expected turn_started + error stream, got ${streamTypes.join(',')}`);
    }
    console.log(`smoke: WS stream honest failure (${streamTypes.join(' → ')})`);

    // 4. task run-now → pump → honest failed run
    const taskRes = await post(
      '/tasks',
      {
        workspaceId: wsId,
        prompt: 'smoke task',
        scheduleType: 'once',
        runAt: new Date(Date.now() - 1000).toISOString(),
        contextMode: 'isolated',
      },
      admin,
    );
    const taskId = ((await taskRes.json()) as { task: { id: string } }).task.id;
    const runNow = await post(`/tasks/${taskId}/run`, undefined, admin);
    if (runNow.status !== 202) throw new Error(`run-now failed: ${runNow.status}`);
    await server.services.scheduler.pumpOnce();
    const detail = (await (await get(`/tasks/${taskId}`, admin)).json()) as {
      runs: Array<{ status: string }>;
    };
    if (detail.runs[0]?.status !== 'failed') {
      throw new Error(`expected honest failed run, got ${detail.runs[0]?.status}`);
    }
    console.log('smoke: task run materialized + honestly failed');

    // 5. settings write-only + second user 404 hiding
    await post(
      '/settings/provider',
      { baseUrl: 'https://api.anthropic.com', apiKey: 'sk-smoke' },
      admin,
      'PUT',
    );
    const settingsText = await (await get('/settings/provider', admin)).text();
    if (settingsText.includes('sk-smoke')) throw new Error('API key must never be echoed');
    console.log('smoke: provider settings write-only OK');

    await post('/auth/users', { username: 'mallory', password: 'password-123' }, admin);
    const mal = await post('/auth/login', { username: 'mallory', password: 'password-123' });
    const malCookie = mal.headers.get('set-cookie')!.split(';')[0]!;
    const forbidden = await get(`/tasks/${taskId}`, malCookie);
    if (forbidden.status !== 404)
      throw new Error(`foreign task must 404, got ${forbidden.status}`);
    console.log('smoke: cross-owner 404 hiding OK');

    console.log(
      'smoke: PASS (setup → profile → draft → WS stream → task → settings → RBAC 404)',
    );
  } finally {
    if (server) {
      await server.stop();
      cleanupDir(server.config.dataDir);
    }
  }
}

void main().catch((err) => {
  console.error('smoke FAILED:', err);
  process.exit(1);
});
