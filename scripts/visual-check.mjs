// Browser-only fixtures: no account, task or provider data is written to a server.
// Usage: node scripts/visual-check.mjs <playwright-module> <output-directory>
import { pathToFileURL } from 'node:url';
import { mkdir } from 'node:fs/promises';
import assert from 'node:assert/strict';
const { chromium } = await import(pathToFileURL(process.argv[2]).href);
const output = process.argv[3];
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, channel: 'msedge' });
const page = await browser.newPage({ viewport: { width: 1440, height: 960 } });
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
let authenticated = true;
let failTranscript = false;
let emptyTranscript = false;
let createdTask = null;
let taskCreates = 0;
let profileSaves = 0;
let extraWorkspace = null;
let provider = { baseUrl: 'https://api.anthropic.com', configured: false };
const time = '2026-09-09T04:00:00Z';
const workspace = {
  id: 'home',
  displayName: 'Personal workspace',
  folder: 'home',
  isHome: true,
  createdAt: time,
};
const profile = {
  id: 'p1',
  name: 'Research partner',
  version: 1,
  isDefault: true,
  promptMode: 'append',
  identity: 'A thoughtful research partner.',
  soul: 'Be curious, clear and precise.',
  agents: 'Verify sources before making claims.',
  tools: 'Use available tools deliberately.',
  updatedAt: time,
};
const task = {
  id: 't1',
  workspaceId: 'home',
  prompt: 'Prepare a morning research digest',
  scheduleType: 'cron',
  cronExpr: '0 9 * * *',
  contextMode: 'isolated',
  status: 'active',
  createdAt: time,
};
await page.route('**/*', async (route) => {
  const req = route.request();
  if (req.resourceType() !== 'fetch') return route.continue();
  const path = new URL(req.url()).pathname;
  if (path.endsWith('/messages') && req.method() === 'GET' && failTranscript) {
    return route.fulfill({
      status: 503,
      json: { error: { code: 'unavailable', message: 'Fixture unavailable' } },
    });
  }
  if (path.endsWith('/messages') && req.method() === 'GET' && emptyTranscript) {
    return route.fulfill({ json: { messages: [] } });
  }
  let data;
  if (path === '/auth/me')
    data = { user: authenticated ? { id: 'u1', username: 'Alex', role: 'admin' } : null };
  else if (path === '/workspaces' && req.method() === 'POST') {
    extraWorkspace = { ...workspace, id: 'w2', isHome: false, ...req.postDataJSON() };
    data = { workspace: extraWorkspace };
  } else if (path === '/workspaces/w2' && req.method() === 'PATCH') {
    Object.assign(extraWorkspace, req.postDataJSON());
    data = { workspace: extraWorkspace };
  } else if (path === '/workspaces')
    data = { workspaces: extraWorkspace ? [workspace, extraWorkspace] : [workspace] };
  else if (path === '/profiles/p1' && req.method() === 'PATCH') {
    const update = req.postDataJSON();
    profileSaves++;
    Object.assign(profile, update.segments, {
      name: update.name,
      promptMode: update.promptMode,
      version: profile.version + 1,
      updatedAt: new Date().toISOString(),
    });
    data = { profile };
  } else if (path === '/profiles/p1/versions')
    data = { versions: [{ version: 1, created_at: time }] };
  else if (path === '/profiles/p1/restore') {
    Object.assign(profile, {
      identity: 'A thoughtful research partner.',
      version: profile.version + 1,
      updatedAt: new Date().toISOString(),
    });
    data = { profile };
  } else if (path === '/profiles') data = { profiles: [profile] };
  else if (path === '/chat/sessions')
    data = {
      sessions: [
        { id: 's1', workspaceId: 'home', updatedAt: time },
        { id: 's2', workspaceId: 'home', updatedAt: '2026-09-08T04:00:00Z' },
      ],
    };
  else if (path.startsWith('/chat/'))
    data = {
      messages: [
        { role: 'user', content: 'Help me plan a focused day.', ts: time },
        {
          role: 'assistant',
          content:
            'Start with one meaningful outcome.\n\n1. Set aside a quiet hour for your most important work.\n2. Gather the context you need.\n3. Leave room to reflect and adjust.',
          ts: time,
        },
      ],
    };
  else if (path === '/tasks' && req.method() === 'POST') {
    taskCreates++;
    createdTask = { ...task, ...req.postDataJSON(), id: 't2' };
    data = { task: createdTask };
  } else if (path === '/tasks') data = { tasks: createdTask ? [task, createdTask] : [task] };
  else if (path === '/tasks/t1/run') data = { queued: true, runId: 'test-run' };
  else if (path === '/tasks/t1' || path === '/tasks/t2') data = { runs: [] };
  else if (path === '/settings/provider') {
    if (req.method() === 'PUT') {
      const update = req.postDataJSON();
      provider = {
        baseUrl: update.baseUrl,
        configured: provider.configured || !!update.apiKey,
      };
    }
    data = { provider };
  } else data = {};
  await route.fulfill({ json: data });
});
await page.routeWebSocket('**/ws', (ws) => {
  ws.onMessage(() => {});
});
for (const route of ['chat', 'profiles', 'tasks', 'workspaces', 'settings', 'login', 'setup']) {
  authenticated = !['login', 'setup'].includes(route);
  await page.goto(`http://127.0.0.1:5173/${route}`);
  await page.waitForTimeout(500);
  if (route === 'tasks') await page.getByText(task.prompt, { exact: true }).first().click();
  await page.screenshot({ path: `${output}/${route}.png`, fullPage: true });
  console.log(
    route,
    await page.evaluate(() => ({
      overflow: document.documentElement.scrollWidth > innerWidth,
      title: document.title,
    })),
  );
}
authenticated = true;
await page.setViewportSize({ width: 390, height: 844 });
for (const route of ['chat', 'profiles', 'tasks', 'workspaces', 'settings', 'login', 'setup']) {
  authenticated = !['login', 'setup'].includes(route);
  await page.goto(`http://127.0.0.1:5173/${route}`);
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${output}/${route}-mobile.png`, fullPage: true });
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  assert.equal(overflow, false, `${route} should fit mobile viewport`);
  if (route === 'chat') {
    // Conversation browsing must preserve each session's unsent draft.
    const composer = page.getByRole('textbox', { name: 'Message', exact: true });
    await composer.fill('Draft for the first conversation');
    const toggle = page.getByRole('button', { name: /Conversations.*Browse/ });
    await toggle.click();
    await page
      .getByRole('searchbox', { name: 'Find conversations' })
      .fill('missing-conversation');
    await page.getByText('No matching conversations.').waitFor();
    await page.getByRole('searchbox', { name: 'Find conversations' }).fill('s2');
    await page.getByRole('button', { name: 'Open conversation s2', exact: true }).click();
    assert.equal(await composer.inputValue(), '');
    await composer.fill('Draft for the second conversation');
    await toggle.click();
    await page.getByRole('searchbox', { name: 'Find conversations' }).fill('');
    await page.getByRole('button', { name: 'Open conversation s1', exact: true }).click();
    assert.equal(await composer.inputValue(), 'Draft for the first conversation');
    const box = await page.getByRole('button', { name: 'Send ↗' }).boundingBox();
    assert.ok(box && box.y + box.height <= 844, 'Mobile composer must remain visible');
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .fill('A focused next step');
    await page
      .getByRole('textbox', { name: 'Message', exact: true })
      .dispatchEvent('keydown', { key: 'Enter', isComposing: true });
    assert.equal(
      await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(),
      'A focused next step',
    );
    await page.getByRole('button', { name: 'Send ↗' }).click();
    await page.waitForTimeout(150);
    assert.equal(
      await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(),
      '',
    );
  }
  if (route === 'tasks') {
    await page.getByText(task.prompt, { exact: true }).first().click();
    await page.getByRole('button', { name: 'Delete', exact: true }).click();
    assert.equal(await page.getByRole('dialog').isVisible(), true);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await page.getByRole('dialog').isVisible(), false);
    await page.getByRole('button', { name: 'Run now' }).click();
    await page.getByText('Queued (run test-run)', { exact: true }).waitFor();
    await page.getByRole('searchbox', { name: 'Find tasks' }).fill('unmatched');
    await page.getByText('No tasks match your filters.').waitFor();
    await page.getByRole('searchbox', { name: 'Find tasks' }).fill('');
    await page.getByRole('combobox', { name: 'Filter tasks by status' }).selectOption('paused');
    await page.getByText('No tasks match your filters.').waitFor();
    await page.getByRole('combobox', { name: 'Filter tasks by status' }).selectOption('all');
    await page.getByRole('button', { name: '+ New task', exact: true }).click();
    const createDialog = page.getByRole('dialog', { name: 'Create a task.' });
    await createDialog.waitFor();
    await createDialog
      .getByRole('textbox', { name: 'What should your worker do?' })
      .fill('Review the weekly reading list');
    await createDialog.getByRole('combobox', { name: 'Schedule type' }).selectOption('once');
    await createDialog.getByRole('button', { name: 'Create', exact: true }).click();
    await createDialog.getByText('Choose a date and time in the future.').waitFor();
    assert.equal(taskCreates, 0);
    await createDialog
      .getByRole('combobox', { name: 'Schedule type' })
      .selectOption('interval');
    await createDialog.getByRole('spinbutton').fill('120');
    await page.screenshot({ path: `${output}/task-create-mobile.png`, fullPage: true });
    await createDialog.getByRole('button', { name: 'Create', exact: true }).click();
    await createDialog.waitFor({ state: 'hidden' });
    assert.equal(taskCreates, 1);
    assert.equal(createdTask.intervalSeconds, 120);
    assert.equal(createdTask.contextMode, 'isolated');
    await page.getByRole('heading', { name: 'Review the weekly reading list' }).waitFor();
    console.log('Task search, status filter, date validation and creation payload: passed');
  }
  if (route === 'profiles') {
    const identity = page.getByRole('textbox', { name: 'Identity', exact: true });
    await identity.fill('A careful studio assistant.');
    await page
      .getByText('Unsaved changes — save or discard before switching profiles.')
      .waitFor();
    await page.getByRole('button', { name: /Values/ }).click();
    await page
      .getByRole('textbox', { name: 'Values', exact: true })
      .fill('Stay curious and kind.');
    await page.getByRole('button', { name: /Identity/ }).click();
    assert.equal(await identity.inputValue(), 'A careful studio assistant.');
    await page.getByRole('button', { name: 'Discard', exact: true }).click();
    assert.equal(await identity.inputValue(), 'A thoughtful research partner.');
    await identity.fill('A careful studio assistant.');
    await page.getByRole('button', { name: 'Save (new version)', exact: true }).click();
    await page.getByText('Saved as a new version.').waitFor();
    assert.equal(profileSaves, 1);
    assert.equal(profile.identity, 'A careful studio assistant.');
    await page.getByRole('button', { name: 'Show history', exact: true }).click();
    await page.getByRole('button', { name: 'Restore', exact: true }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('textarea[aria-label="Identity"]')?.value ===
        'A thoughtful research partner.',
    );
    await page.getByRole('button', { name: /Your workers.*Browse/ }).click();
    await page.getByRole('searchbox', { name: 'Find profiles' }).fill('no-match');
    await page.getByText('No matching profiles.').waitFor();
    await page.getByRole('searchbox', { name: 'Find profiles' }).fill('');
    console.log('Profile sections, discard, save payload, restore and search: passed');
  }
  if (route === 'workspaces') {
    assert.equal(
      await page.getByRole('button', { name: 'Delete', exact: true }).isDisabled(),
      true,
    );
    await page.getByRole('searchbox', { name: 'Find workspaces' }).fill('missing');
    await page.getByText('No matching workspaces.').waitFor();
    await page.getByRole('searchbox', { name: 'Find workspaces' }).fill('');
    await page.getByRole('textbox', { name: 'New workspace name' }).fill('  Studio  ');
    await page.getByRole('button', { name: 'Create workspace', exact: true }).click();
    await page.getByText('Workspace created.', { exact: true }).waitFor();
    assert.equal(extraWorkspace.displayName, 'Studio');
    await page.getByRole('button', { name: 'Rename', exact: true }).last().click();
    await page.getByRole('textbox', { name: 'Rename workspace' }).fill('Research studio');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await page.getByText('Workspace renamed.', { exact: true }).waitFor();
    assert.equal(extraWorkspace.displayName, 'Research studio');
    await page.screenshot({ path: `${output}/workspace-gallery-mobile.png`, fullPage: true });
    console.log('Workspace search, home protection, creation and rename: passed');
  }
  if (route === 'settings') {
    const save = page.getByRole('button', { name: 'Save changes', exact: true });
    assert.equal(await save.isDisabled(), true);
    await page.getByRole('textbox', { name: 'Base URL', exact: true }).fill('invalid');
    await save.click();
    await page.getByRole('alert').waitFor();
    await page
      .getByRole('textbox', { name: 'Base URL', exact: true })
      .fill('https://example.test');
    await save.click();
    await page.getByText('Settings saved.', { exact: true }).waitFor();
    assert.equal(provider.configured, false);
    await page.getByLabel('API key', { exact: true }).fill('fixture-only');
    await save.click();
    await page.getByText('API key saved', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('API key', { exact: true }).inputValue(), '');
    console.log('Settings validation, dirty state and saved-key status: passed');
  }
  console.log(`${route}-mobile`, { overflow });
}
authenticated = true;
failTranscript = true;
await page.goto('http://127.0.0.1:5173/chat');
await page.getByRole('button', { name: 'Retry', exact: true }).waitFor();
failTranscript = false;
await page.getByRole('button', { name: 'Retry', exact: true }).click();
await page.getByRole('button', { name: 'Copy assistant message' }).waitFor();
await page
  .context()
  .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:5173' });
await page.getByRole('button', { name: 'Copy assistant message' }).click();
assert.match(
  await page.evaluate(() => navigator.clipboard.readText()),
  /Start with one meaningful outcome/,
);
emptyTranscript = true;
await page.reload();
await page.locator('.empty-art').evaluate((img) => img.decode());
await page.screenshot({ path: `${output}/chat-empty-mobile.png`, fullPage: true });
await page.setViewportSize({ width: 1440, height: 960 });
await page.screenshot({ path: `${output}/chat-empty.png`, fullPage: true });
await page.getByRole('button', { name: 'Help me plan a focused day.' }).click();
assert.equal(
  await page.getByRole('textbox', { name: 'Message', exact: true }).inputValue(),
  'Help me plan a focused day.',
);
console.log(
  'Conversation search, per-session drafts, retry, clipboard and prompt suggestions: passed',
);
authenticated = false;
for (const width of [390, 768, 900, 1280, 1440]) {
  await page.setViewportSize({ width, height: 900 });
  await page.goto('http://127.0.0.1:5173/login');
  const story = await page.locator('.auth-story').boundingBox();
  const art = await page.locator('.auth-art-image').boundingBox();
  const panel = await page.locator('.auth-art').boundingBox();
  assert.ok(story && art && panel);
  assert.ok(Math.abs(art.height - panel.height) < 2, `Full-height artwork at ${width}px`);
  const overlay = await page
    .locator('.auth-art')
    .evaluate((el) => getComputedStyle(el, '::after').backgroundImage);
  assert.match(overlay, /linear-gradient/, 'Text readability uses a feathered overlay');
  assert.ok(story.x >= panel.x && story.x + story.width <= panel.x + panel.width);
  await page.screenshot({ path: `${output}/login-${width}.png`, fullPage: true });
}
await page.emulateMedia({ reducedMotion: 'reduce' });
await page.goto('http://127.0.0.1:5173/login');
assert.equal(await page.locator('.typed-word').innerText(), 'what matters.|');
await page.emulateMedia({ reducedMotion: 'no-preference' });
const caret = page.locator('.typing-cursor');
const blink = await caret.evaluate((el) => {
  const animation = el.getAnimations().find((a) => a.animationName === 'caret-blink');
  if (!animation) return null;
  animation.pause();
  animation.currentTime = 100;
  const on = getComputedStyle(el).opacity;
  animation.currentTime = 600;
  const off = getComputedStyle(el).opacity;
  return { on, off };
});
assert.ok(blink && Number(blink.on) > 0 && Number(blink.off) === 0, 'Caret visibly blinks');
authenticated = true;
for (const width of [390, 1280]) {
  await page.setViewportSize({ width, height: 650 });
  for (const [route, name] of [
    ['profiles', 'Advanced · AI-assisted draft'],
    ['workspaces', 'Create workspace'],
    ['settings', 'Save changes'],
  ]) {
    await page.goto(`http://127.0.0.1:5173/${route}`);
    const control =
      route === 'profiles'
        ? page.locator('.profile-advanced summary')
        : page.getByRole('button', { name, exact: true });
    await control.scrollIntoViewIfNeeded();
    const box = await control.boundingBox();
    assert.ok(
      box && box.y >= 0 && box.y + box.height <= 650,
      `${route} bottom control reachable at ${width}px`,
    );
    await page.screenshot({ path: `${output}/${route}-bottom-${width}.png`, fullPage: true });
  }
}
console.log('Blinking caret and bottom controls at mobile/short-desktop sizes: passed');
console.log('Full-image login gradient at five widths and reduced motion: passed');
console.log('Page errors:', errors);
await browser.close();
if (errors.length) process.exitCode = 1;
