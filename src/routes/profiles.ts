/**
 * R15 route surface: profile CRUD/versions/default/restore + two-stage
 * draft→confirmation-phrase publish.
 *
 * Publish source is NEVER read from the body. The `PublishContext` is built
 * here from the authenticated cookie session (`requireUser`); a client-supplied
 * `source` field in the request is ignored by construction — the route simply
 * does not look at it, and the store's confirmDraft takes no source argument.
 * Background/scheduled/sub-agent callers have no session and never reach
 * publish.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { WebError } from '../errors.js';
import type { AgentProfileStore, AgentProfile } from '../stores/agent-profiles.js';
import type { PublishContext } from '../stores/agent-profiles.js';
import type { ProfileSegments, PromptMode } from '../prompt-plan.js';
import { requireUser } from '../auth-context.js';
import type { AppEnv } from '../web.js';

const segmentsSchema = z.object({
  identity: z.string().default(''),
  soul: z.string().default(''),
  agents: z.string().default(''),
  tools: z.string().default(''),
});

// PATCH must distinguish "not provided" from "explicit empty": z.object.partial()
// over defaulted fields would fill absent keys with the default, silently
// clearing untouched segments. So separate schema with no defaults.
const segmentsPatchSchema = z.object({
  identity: z.string().optional(),
  soul: z.string().optional(),
  agents: z.string().optional(),
  tools: z.string().optional(),
});

const createSchema = z.object({
  name: z.string().min(1).max(120),
  segments: segmentsSchema,
  promptMode: z.enum(['append', 'replace']).default('append'),
});

const patchSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  segments: segmentsPatchSchema.optional(),
  promptMode: z.enum(['append', 'replace']).optional(),
});

const restoreSchema = z.object({ version: z.number().int().min(1) });
const draftSchema = z.object({ draftJson: z.string().min(1) });
const confirmSchema = z.object({ phrase: z.string().min(1) });

export interface ProfileRoutesDeps {
  profileStore: AgentProfileStore;
}

export function registerProfileRoutes(app: Hono<AppEnv>, deps: ProfileRoutesDeps): void {
  const { profileStore } = deps;

  app.get('/profiles', (c) => {
    const user = requireUser(c);
    const list = profileStore
      .list(user.id)
      .map((p) => toApi(p))
      .filter((p) => p.status === 'active');
    return c.json({ profiles: list });
  });

  app.post('/profiles', async (c) => {
    const user = requireUser(c);
    const body = createSchema.parse(await c.req.json());
    const created = profileStore.create(user.id, {
      name: body.name,
      segments: toSegments(body.segments),
      prompt_mode: body.promptMode,
    });
    return c.json({ profile: toApi(created) }, 201);
  });

  app.get('/profiles/:id', (c) => {
    const user = requireUser(c);
    const p = profileStore.byIdFor(user.id, c.req.param('id'));
    if (p === undefined) throw new WebError('not_found', 'profile not found');
    return c.json({ profile: toApi(p) });
  });

  app.patch('/profiles/:id', async (c) => {
    const user = requireUser(c);
    const p = profileStore.byIdFor(user.id, c.req.param('id'));
    if (p === undefined) throw new WebError('not_found', 'profile not found');
    const body = patchSchema.parse(await c.req.json());
    const updated = profileStore.update(user.id, c.req.param('id'), {
      ...(body.name ? { name: body.name } : {}),
      ...toSegmentPatch(body.segments),
      ...(body.promptMode ? { prompt_mode: body.promptMode } : {}),
    });
    return c.json({ profile: toApi(updated) });
  });

  app.get('/profiles/:id/versions', (c) => {
    const user = requireUser(c);
    const p = profileStore.byIdFor(user.id, c.req.param('id'));
    if (p === undefined) throw new WebError('not_found', 'profile not found');
    return c.json({ versions: profileStore.versions(p.id) });
  });

  app.post('/profiles/:id/default', (c) => {
    const user = requireUser(c);
    if (profileStore.byIdFor(user.id, c.req.param('id')) === undefined) {
      throw new WebError('not_found', 'profile not found');
    }
    const p = profileStore.setDefault(user.id, c.req.param('id'));
    return c.json({ profile: toApi(p) });
  });

  app.post('/profiles/:id/restore', async (c) => {
    const user = requireUser(c);
    const p = profileStore.byIdFor(user.id, c.req.param('id'));
    if (p === undefined) throw new WebError('not_found', 'profile not found');
    const body = restoreSchema.parse(await c.req.json());
    const restored = profileStore.restore(user.id, c.req.param('id'), body.version);
    return c.json({ profile: toApi(restored) });
  });

  // ---- two-stage draft ----------------------------------------------------

  app.post('/drafts', async (c) => {
    const user = requireUser(c);
    const body = draftSchema.parse(await c.req.json());
    const draft = profileStore.createDraft(user.id, body.draftJson);
    // The confirmation phrase is the user's to relay; it is the only path to
    // publish this draft.
    return c.json(draft, 201);
  });

  app.post('/drafts/:id/confirm', async (c) => {
    const user = requireUser(c);
    const body = confirmSchema.parse(await c.req.json());
    const ctx: PublishContext = { userId: user.id };
    const result = profileStore.confirmDraft(ctx, c.req.param('id'), body.phrase, publishDraft);
    if (result.status === 'not_found') throw new WebError('not_found', 'draft not found');
    if (result.status === 'aborted') throw new WebError('bad_request', result.reason);
    // result.status === 'published'
    return c.json({ status: 'published' });
  });

  function publishDraft(ctx: PublishContext, draftJson: string): void {
    const parsed = zodParseDraft(draftJson);
    if (!parsed.ok)
      throw new WebError('bad_request', `published draft is malformed: ${parsed.error}`);
    const existing =
      parsed.profileId !== undefined
        ? profileStore.byIdFor(ctx.userId, parsed.profileId)
        : undefined;
    if (existing === undefined) {
      profileStore.create(ctx.userId, {
        name: parsed.name,
        segments: parsed.segments,
        prompt_mode: parsed.promptMode,
      });
    } else {
      profileStore.update(ctx.userId, existing.id, {
        name: parsed.name,
        ...parsed.segments,
        prompt_mode: parsed.promptMode,
      });
    }
  }
}

// --- helpers ---------------------------------------------------------------

function toSegments(s: z.infer<typeof segmentsSchema>): ProfileSegments {
  return {
    identity_prompt: s.identity,
    soul_prompt: s.soul,
    agents_prompt: s.agents,
    tools_prompt: s.tools,
  };
}

function toSegmentPatch(
  s: { identity?: string; soul?: string; agents?: string; tools?: string } | undefined,
): Partial<ProfileSegments> {
  if (s === undefined) return {};
  return {
    ...(s.identity !== undefined ? { identity_prompt: s.identity } : {}),
    ...(s.soul !== undefined ? { soul_prompt: s.soul } : {}),
    ...(s.agents !== undefined ? { agents_prompt: s.agents } : {}),
    ...(s.tools !== undefined ? { tools_prompt: s.tools } : {}),
  };
}

function zodParseDraft(json: string):
  | {
      ok: true;
      name: string;
      segments: ProfileSegments;
      promptMode: PromptMode;
      profileId?: string;
    }
  | { ok: false; error: string } {
  try {
    const raw = JSON.parse(json) as {
      name?: unknown;
      identity?: unknown;
      soul?: unknown;
      agents?: unknown;
      tools?: unknown;
      promptMode?: unknown;
      profileId?: unknown;
    };
    if (typeof raw.name !== 'string' || raw.name.length === 0)
      return { ok: false, error: 'missing name' };
    const str = (v: unknown) => (typeof v === 'string' ? v : '');
    return {
      ok: true,
      name: raw.name,
      segments: {
        identity_prompt: str(raw.identity),
        soul_prompt: str(raw.soul),
        agents_prompt: str(raw.agents),
        tools_prompt: str(raw.tools),
      },
      promptMode: raw.promptMode === 'replace' ? 'replace' : 'append',
      profileId: typeof raw.profileId === 'string' ? raw.profileId : undefined,
    };
  } catch {
    return { ok: false, error: 'not valid json' };
  }
}

function toApi(p: AgentProfile) {
  return {
    id: p.id,
    name: p.name,
    version: p.version,
    identityHash: p.identity_hash,
    isDefault: p.is_default === 1,
    status: p.status,
    promptMode: p.prompt_mode,
    identity: p.identity_prompt,
    soul: p.soul_prompt,
    agents: p.agents_prompt,
    tools: p.tools_prompt,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}
