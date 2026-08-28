/**
 * Loop 3 Gate smoke: real server boot on a temp data dir with the scheduler
 * pump auto-started, a real task created through HTTP, one pump round driven
 * by wall-clock materialization (a once task in the past), and graceful stop.
 */
import { startServer, type RunningServer } from '../src/server.js';
import { makeTestConfig, testLogger, cleanupDir } from '../src/test-support/harness.js';

async function main(): Promise<void> {
  const config = makeTestConfig();
  let server: RunningServer | undefined;
  try {
    server = await startServer({ config, logger: testLogger() });
    const base = `http://127.0.0.1:${server.port}`;

    // setup + login
    const setup = await fetch(`${base}/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'smoker', password: 'password-123' }),
    });
    if (setup.status !== 201) throw new Error(`setup failed: ${setup.status}`);
    const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;

    // workspace
    const wsRes = await fetch(`${base}/workspaces`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({ displayName: 'Smoke Ops' }),
    });
    const wsId = ((await wsRes.json()) as { workspace: { id: string } }).workspace.id;

    // once task already due → next pump materializes it
    const taskRes = await fetch(`${base}/tasks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify({
        workspaceId: wsId,
        prompt: 'smoke turn',
        scheduleType: 'once',
        runAt: new Date(Date.now() - 5000).toISOString(),
        contextMode: 'isolated',
      }),
    });
    if (taskRes.status !== 201) throw new Error(`task create failed: ${taskRes.status}`);
    const task = ((await taskRes.json()) as { task: { id: string } }).task;

    // drive one pump round manually (auto-start is on; pumpOnce is safe to call)
    await server.services.scheduler.pumpOnce();

    const detailRes = await fetch(`${base}/tasks/${task.id}`, { headers: { cookie } });
    const detail = (await detailRes.json()) as {
      runs: Array<{ status: string; error: string | null }>;
    };
    const run = detail.runs[0];
    if (!run) throw new Error('no run materialized');
    console.log(`smoke: run status=${run.status} error=${JSON.stringify(run.error)}`);
    // Without ANTHROPIC_API_KEY the turn fails loudly — that IS the expected
    // honest outcome; the run must be failed, not stuck queued.
    if (run.status !== 'failed') throw new Error(`expected failed run, got ${run.status}`);

    console.log('smoke: PASS (boot → task → materialize → claim → honest failure → stop next)');
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
