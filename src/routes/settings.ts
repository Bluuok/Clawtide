/**
 * Settings route family (MUST-lite): a single Anthropic-compatible provider
 * endpoint + API key, stored in the `settings` table — the top layer of the
 * config priority chain (persisted web settings > env > code defaults).
 *
 * Secret handling: the API key is WRITE-ONLY. GET returns `configured` plus
 * the base URL but never the key; a PATCH/PUT without `apiKey` keeps the
 * stored one. The key is redacted in logs by logger REDACT_PATHS (`apiKey`).
 * Admin-gated: this is system configuration, the independent role gate.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import type { AppDb } from '../db.js';
import { requireAdmin } from '../auth-context.js';
import type { AppEnv } from '../web.js';

export const PROVIDER_BASE_URL_KEY = 'provider.baseUrl';
export const PROVIDER_API_KEY_KEY = 'provider.apiKey';

const putSchema = z.object({
  baseUrl: z
    .string()
    .max(500)
    .refine((v) => {
      if (v.length === 0) return true; // empty resets to default endpoint
      try {
        const url = new URL(v);
        return url.protocol === 'http:' || url.protocol === 'https:';
      } catch {
        return false;
      }
    }, 'baseUrl must be a valid http(s) URL or empty'),
  apiKey: z.string().max(500).optional(),
});

export interface SettingsRoutesDeps {
  db: AppDb;
}

export function registerSettingsRoutes(app: Hono<AppEnv>, deps: SettingsRoutesDeps): void {
  const { db } = deps;

  app.get('/settings/provider', (c) => {
    requireAdmin(c);
    const baseUrl = db.settings.get(PROVIDER_BASE_URL_KEY) ?? '';
    const configured = (db.settings.get(PROVIDER_API_KEY_KEY) ?? '').length > 0;
    // Write-only key: presence is reported, the value never leaves the server.
    return c.json({ provider: { baseUrl, configured } });
  });

  app.put('/settings/provider', async (c) => {
    requireAdmin(c);
    const body = putSchema.parse(await c.req.json());
    if (body.baseUrl.length > 0) {
      db.settings.set(PROVIDER_BASE_URL_KEY, body.baseUrl);
    } else {
      db.settings.delete(PROVIDER_BASE_URL_KEY);
    }
    if (body.apiKey !== undefined) {
      if (body.apiKey.length > 0) {
        db.settings.set(PROVIDER_API_KEY_KEY, body.apiKey);
      } else {
        db.settings.delete(PROVIDER_API_KEY_KEY);
      }
    }
    const configured = (db.settings.get(PROVIDER_API_KEY_KEY) ?? '').length > 0;
    return c.json({ provider: { baseUrl: body.baseUrl, configured } });
  });
}
