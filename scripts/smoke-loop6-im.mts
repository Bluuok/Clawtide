/**
 * Loop 6 smoke: real IM channel verification with operator-provided
 * credentials. Registers a Telegram + Feishu channel account through the
 * API (encrypted at rest), boots the server with imAutoStart, and confirms
 * adapters actually connect (long-polling / WS). Inbound reply verification
 * requires a human to message the bot; this script verifies connection
 * establishment and reports honestly what remains manual.
 *
 * Credentials come from env: TELEGRAM_BOT_TOKEN, FEISHU_APP_ID,
 * FEISHU_APP_SECRET. Missing credentials → that channel is skipped with a
 * NOT VERIFIED note (never faked).
 */
import { startServer, type RunningServer } from '../src/server.js';
import { makeTestConfig, testLogger, cleanupDir } from '../src/test-support/harness.js';
import { CredentialVault } from '../src/vault.js';
import { joinConfigDir } from '../src/auth.js';

async function main(): Promise<void> {
  const config = makeTestConfig();
  const telegramToken = process.env.TELEGRAM_BOT_TOKEN;
  const feishuAppId = process.env.FEISHU_APP_ID;
  const feishuAppSecret = process.env.FEISHU_APP_SECRET;

  let server: RunningServer | undefined;
  try {
    server = await startServer({
      config,
      logger: testLogger(),
      schedulerAutoStart: false,
      imAutoStart: false,
    });
    const base = `http://127.0.0.1:${server.port}`;
    const setup = await fetch(`${base}/auth/setup`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'smoker', password: 'password-123' }),
    });
    const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
    const vault = CredentialVault.open(joinConfigDir(config));

    const insert = (channel: string, creds: string, ownerImId: string) =>
      server!.db.db
        .prepare(
          "INSERT INTO channel_accounts (id, user_id, channel, credentials_enc, owner_im_id, created_at) VALUES (?, 'seed', ?, ?, ?, ?)",
        )
        .run(
          `acc-${channel}`,
          channel,
          vault.encrypt(creds),
          ownerImId,
          new Date().toISOString(),
        );
    // Seed a user row for the account FK.
    server.db.db
      .prepare(
        "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('seed', 'im-owner', 'x', 'admin', ?)",
      )
      .run(new Date().toISOString());

    if (telegramToken !== undefined && telegramToken.length > 0) {
      insert('telegram', telegramToken, 'TELEGRAM_OWNER_ID_PENDING');
      console.log('smoke: telegram account registered (encrypted at rest)');
    } else {
      console.log('smoke: telegram SKIPPED — no TELEGRAM_BOT_TOKEN (NOT VERIFIED)');
    }
    if (
      feishuAppId !== undefined &&
      feishuAppId.length > 0 &&
      feishuAppSecret !== undefined &&
      feishuAppSecret.length > 0
    ) {
      insert(
        'feishu',
        JSON.stringify({ appId: feishuAppId, appSecret: feishuAppSecret }),
        'FEISHU_OWNER_ID_PENDING',
      );
      console.log('smoke: feishu account registered (encrypted at rest)');
    } else {
      console.log('smoke: feishu SKIPPED — no FEISHU_APP_ID/FEISHU_APP_SECRET (NOT VERIFIED)');
    }

    // Boot the adapters for real: grammY long-polls Telegram (getMe +
    // getUpdates) and the Lark SDK opens its WebSocket. A wrong credential
    // fails loudly here. Adapters must be registered with the manager first
    // (server.ts does that only when imAutoStart is enabled — replicate the
    // construction here for a connection-only check).
    const started: string[] = [];
    const failures: string[] = [];
    if (server.services.imManager === undefined) throw new Error('imManager missing');
    const rows = server.db.db.prepare('SELECT * FROM channel_accounts').all() as Array<{
      id: string;
      channel: string;
      credentials_enc: Buffer | null;
    }>;
    for (const row of rows) {
      if (row.credentials_enc === null) continue;
      const decrypted = vault.decrypt(row.credentials_enc);
      let adapter: import('../src/im-channel.js').ImChannelAdapter | undefined;
      if (row.channel === 'telegram') {
        const { TelegramAdapter } = await import('../src/channels/telegram.js');
        adapter = new TelegramAdapter({ botToken: decrypted, accountId: row.id });
      } else if (row.channel === 'feishu') {
        const creds = JSON.parse(decrypted) as { appId: string; appSecret: string };
        const { FeishuAdapter } = await import('../src/channels/feishu.js');
        adapter = new FeishuAdapter({ ...creds, accountId: row.id });
      }
      if (adapter === undefined) continue;
      server.services.imManager.register(row.id, adapter);
      try {
        await adapter.start(async () => undefined);
        started.push(row.channel);
      } catch (err) {
        failures.push(`${row.channel}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    console.log(`smoke: adapters connected: [${started.join(', ') || 'none'}]`);
    if (failures.length > 0) console.log(`smoke: adapter failures: ${failures.join(' | ')}`);
    if (started.length === 0) {
      throw new Error('no adapter connected — nothing was verified');
    }
    console.log(
      'smoke: PASS (connection-level). Send a message to the bot manually to verify inbound→turn→reply; owner_im_id must be set to your channel user id for full Owner Gate behavior.',
    );
    // Connection-level verification is done: stop here. Long-polling never
    // "finishes", so a clean exit (not a hang) is the success shape.
    process.exit(0);
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
