/**
 * Channel account route family (R07 config surface): register/update/list
 * IM channel accounts. Credentials (bot token / app secret) are encrypted
 * with AES-256-GCM at write time and NEVER returned — GET reports
 * `configured` only. owner_im_id binds the channel-native owner identity
 * (R20 Owner Gate); cross-channel identity is deliberately not unified.
 *
 * RBAC: an account row belongs to its creating user; foreign rows 404
 * (same hiding rule as workspaces). List shows only the caller's accounts.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { randomBytes } from 'node:crypto';
import { WebError } from '../errors.js';
import type { AppDb } from '../db.js';
import type { CredentialVault } from '../vault.js';
import { requireUser } from '../auth-context.js';
import type { AppEnv } from '../web.js';

const channelId = z.enum([
  'feishu',
  'telegram',
  'qq',
  'dingtalk',
  'wechat',
  'discord',
  'whatsapp',
]);

const createSchema = z
  .object({
    channel: channelId,
    // Telegram: the bot token as one string. Feishu: appId+appSecret packed
    // as JSON before encryption — one BLOB column holds either shape.
    credentials: z.record(z.string(), z.string()),
    ownerImId: z.string().min(1).max(200).optional(),
    defaultWorkspaceId: z.string().min(1).optional(),
  })
  .refine(
    (v) =>
      v.channel !== 'telegram' ||
      (typeof v.credentials.botToken === 'string' && v.credentials.botToken.length > 0),
    { message: 'telegram requires credentials.botToken' },
  )
  .refine(
    (v) =>
      v.channel !== 'feishu' ||
      (typeof v.credentials.appId === 'string' &&
        v.credentials.appId.length > 0 &&
        typeof v.credentials.appSecret === 'string' &&
        v.credentials.appSecret.length > 0),
    { message: 'feishu requires credentials.appId + credentials.appSecret' },
  );

const updateSchema = z.object({
  credentials: z.record(z.string(), z.string()).optional(),
  ownerImId: z.string().min(1).max(200).nullable().optional(),
  defaultWorkspaceId: z.string().min(1).nullable().optional(),
});

export interface ChannelRoutesDeps {
  db: AppDb;
  vault: CredentialVault;
}

export function registerChannelRoutes(app: Hono<AppEnv>, deps: ChannelRoutesDeps): void {
  const { db, vault } = deps;

  interface AccountRow {
    id: string;
    user_id: string;
    channel: string;
    credentials_enc: Buffer | null;
    owner_im_id: string | null;
    default_workspace_id: string | null;
    created_at: string;
  }

  const byIdFor = (userId: string, id: string): AccountRow | undefined =>
    db.db
      .prepare('SELECT * FROM channel_accounts WHERE id = ? AND user_id = ?')
      .get(id, userId) as AccountRow | undefined;

  const toApi = (row: AccountRow) => ({
    id: row.id,
    channel: row.channel,
    // Write-only credentials: presence is reported, ciphertext never leaves.
    configured: row.credentials_enc !== null && row.credentials_enc.length > 0,
    ownerImId: row.owner_im_id,
    defaultWorkspaceId: row.default_workspace_id,
    createdAt: row.created_at,
  });

  app.get('/channels', (c) => {
    const user = requireUser(c);
    const rows = db.db
      .prepare('SELECT * FROM channel_accounts WHERE user_id = ? ORDER BY created_at')
      .all(user.id) as AccountRow[];
    return c.json({ channels: rows.map(toApi) });
  });

  app.post('/channels', async (c) => {
    const user = requireUser(c);
    const body = createSchema.parse(await c.req.json());
    // One account per (user, channel) — the UNIQUE constraint is the policy.
    const existing = db.db
      .prepare('SELECT id FROM channel_accounts WHERE user_id = ? AND channel = ?')
      .get(user.id, body.channel);
    if (existing !== undefined) {
      throw new WebError(
        'conflict',
        'an account for this channel already exists; PATCH instead',
      );
    }
    const id = randomBytes(16).toString('hex');
    const enc =
      body.channel === 'feishu'
        ? vault.encrypt(JSON.stringify(body.credentials))
        : vault.encrypt(body.credentials.botToken ?? JSON.stringify(body.credentials));
    db.db
      .prepare(
        'INSERT INTO channel_accounts (id, user_id, channel, credentials_enc, owner_im_id, default_workspace_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        id,
        user.id,
        body.channel,
        enc,
        body.ownerImId ?? null,
        body.defaultWorkspaceId ?? null,
        new Date().toISOString(),
      );
    const row = byIdFor(user.id, id)!;
    return c.json({ channel: toApi(row) }, 201);
  });

  app.patch('/channels/:id', async (c) => {
    const user = requireUser(c);
    const row = byIdFor(user.id, c.req.param('id'));
    if (row === undefined) throw new WebError('not_found', 'channel account not found');
    const body = updateSchema.parse(await c.req.json());
    if (body.credentials !== undefined) {
      const enc =
        row.channel === 'feishu'
          ? vault.encrypt(JSON.stringify(body.credentials))
          : vault.encrypt(body.credentials.botToken ?? JSON.stringify(body.credentials));
      db.db
        .prepare('UPDATE channel_accounts SET credentials_enc = ? WHERE id = ?')
        .run(enc, row.id);
    }
    if (body.ownerImId !== undefined) {
      db.db
        .prepare('UPDATE channel_accounts SET owner_im_id = ? WHERE id = ?')
        .run(body.ownerImId, row.id);
    }
    if (body.defaultWorkspaceId !== undefined) {
      db.db
        .prepare('UPDATE channel_accounts SET default_workspace_id = ? WHERE id = ?')
        .run(body.defaultWorkspaceId, row.id);
    }
    return c.json({ channel: toApi(byIdFor(user.id, row.id)!) });
  });

  app.delete('/channels/:id', (c) => {
    const user = requireUser(c);
    const row = byIdFor(user.id, c.req.param('id'));
    if (row === undefined) throw new WebError('not_found', 'channel account not found');
    db.db.prepare('DELETE FROM channel_accounts WHERE id = ?').run(row.id);
    return c.json({ ok: true });
  });
}
