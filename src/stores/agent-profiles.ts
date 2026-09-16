/**
 * R15 — agent profile store + two-stage publish pipeline.
 *
 * Source-of-truth note (spec §6.3 item 5): publish legitimacy is derived from
 * the EXECUTION CONTEXT, never from a client-supplied `source` field. That is
 * why no publish method here accepts a `source` argument at all: the route
 * layer constructs a `PublishContext` from the authenticated cookie session
 * (or, later, from the IM admission chain). Background/scheduled/sub-agent
 * callers have no such context and simply cannot call publish — there is no
 * API surface for them to reach, a structural gate rather than a parameter.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { AppDb } from '../db.js';
import { nowIso } from '../time.js';
import { profileIdentityHash, type ProfileSegments, type PromptMode } from '../prompt-plan.js';

export type ProfileStatus = 'active' | 'deleted';

export interface AgentProfile extends ProfileSegments {
  id: string;
  owner_user_id: string;
  name: string;
  prompt_mode: PromptMode;
  version: number;
  identity_hash: string;
  is_default: number;
  status: ProfileStatus;
  created_at: string;
  updated_at: string;
}

export interface DraftRecord {
  id: string;
  owner_user_id: string;
  draft_json: string;
  confirmation_phrase: string;
  expires_at: string;
  stage: 'draft' | 'confirmed' | 'expired' | 'aborted';
  created_at: string;
}

/**
 * Who may publish. Constructed ONLY by authenticated surfaces; carries no
 * free-form field, so a forged source cannot be smuggled in.
 */
export interface PublishContext {
  userId: string;
}

const DRAFT_TTL_SECONDS = 15 * 60;
const PHRASE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/0/1
const PHRASE_MIN = 6;
const PHRASE_MAX = 8;

export class AgentProfileStore {
  constructor(
    private readonly db: AppDb,
    private readonly now: () => string = nowIso,
  ) {}

  // ---- profiles -----------------------------------------------------------

  create(
    ownerUserId: string,
    input: { name: string; segments: ProfileSegments; prompt_mode: PromptMode },
  ): AgentProfile {
    const { name, segments, prompt_mode } = input;
    const id = randomBytes(16).toString('hex');
    const ts = this.now();
    const first = this.countOwnerActive(ownerUserId) === 0;
    const identity_hash = profileIdentityHash(segments);
    this.db.db
      .prepare(
        `INSERT INTO agent_profiles
           (id, owner_user_id, name, identity_prompt, soul_prompt, agents_prompt, tools_prompt,
            prompt_mode, version, identity_hash, is_default, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, 'active', ?, ?)`,
      )
      .run(
        id,
        ownerUserId,
        name,
        segments.identity_prompt,
        segments.soul_prompt,
        segments.agents_prompt,
        segments.tools_prompt,
        prompt_mode,
        identity_hash,
        first ? 1 : 0,
        ts,
        ts,
      );
    return this.byId(id)!;
  }

  /** For modified fields, preserves unmodified segments (four-段 orthogonal). */
  update(
    ownerUserId: string,
    profileId: string,
    patch: Partial<ProfileSegments> & { name?: string; prompt_mode?: PromptMode },
  ): AgentProfile {
    const existing = this.byIdFor(ownerUserId, profileId);
    if (existing === undefined) return this.notFound();
    const segments: ProfileSegments = {
      identity_prompt: patch.identity_prompt ?? existing.identity_prompt,
      soul_prompt: patch.soul_prompt ?? existing.soul_prompt,
      agents_prompt: patch.agents_prompt ?? existing.agents_prompt,
      tools_prompt: patch.tools_prompt ?? existing.tools_prompt,
    };
    this.snapshot(existing);
    const ts = this.now();
    const version = existing.version + 1;
    const identity_hash = profileIdentityHash(segments);
    this.db.db
      .prepare(
        `UPDATE agent_profiles SET
           name = ?, identity_prompt = ?, soul_prompt = ?, agents_prompt = ?, tools_prompt = ?,
           prompt_mode = ?, version = ?, identity_hash = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        patch.name ?? existing.name,
        segments.identity_prompt,
        segments.soul_prompt,
        segments.agents_prompt,
        segments.tools_prompt,
        patch.prompt_mode ?? existing.prompt_mode,
        version,
        identity_hash,
        ts,
        profileId,
      );
    return this.byId(profileId)!;
  }

  /** Immutable history: `version` becomes a new row with a fresh version number. */
  restore(ownerUserId: string, profileId: string, fromVersion: number): AgentProfile {
    const existing = this.byIdFor(ownerUserId, profileId);
    if (existing === undefined) return this.notFound();
    const snapshot = this.db.db
      .prepare(
        'SELECT identity_prompt, soul_prompt, agents_prompt, tools_prompt FROM agent_profile_versions WHERE agent_profile_id = ? AND version = ?',
      )
      .get(profileId, fromVersion) as
      | {
          identity_prompt: string;
          soul_prompt: string;
          agents_prompt: string;
          tools_prompt: string;
        }
      | undefined;
    if (snapshot === undefined) {
      throw new Error('restore: version not found in history');
    }
    this.snapshot(existing);
    const ts = this.now();
    const version = existing.version + 1;
    const identity_hash = profileIdentityHash(snapshot);
    this.db.db
      .prepare(
        `UPDATE agent_profiles SET
           identity_prompt = ?, soul_prompt = ?, agents_prompt = ?, tools_prompt = ?,
           version = ?, identity_hash = ?, updated_at = ?
         WHERE id = ?`,
      )
      .run(
        snapshot.identity_prompt,
        snapshot.soul_prompt,
        snapshot.agents_prompt,
        snapshot.tools_prompt,
        version,
        identity_hash,
        ts,
        profileId,
      );
    return this.byId(profileId)!;
  }

  setDefault(ownerUserId: string, profileId: string): AgentProfile {
    const existing = this.byIdFor(ownerUserId, profileId);
    if (existing === undefined) return this.notFound();
    const ts = this.now();
    const move = this.db.db.transaction(() => {
      // Unset any prior default for this owner, then claim the new one. The
      // partial-unique index would reject a second active default otherwise.
      this.db.db
        .prepare(
          'UPDATE agent_profiles SET is_default = 0 WHERE owner_user_id = ? AND is_default = 1',
        )
        .run(ownerUserId);
      this.db.db
        .prepare('UPDATE agent_profiles SET is_default = 1, updated_at = ? WHERE id = ?')
        .run(ts, profileId);
    });
    move();
    return this.byId(profileId)!;
  }

  list(ownerUserId: string): AgentProfile[] {
    return this.db.db
      .prepare('SELECT * FROM agent_profiles WHERE owner_user_id = ? ORDER BY created_at')
      .all(ownerUserId) as AgentProfile[];
  }

  byId(profileId: string): AgentProfile | undefined {
    return this.db.db.prepare('SELECT * FROM agent_profiles WHERE id = ?').get(profileId) as
      AgentProfile | undefined;
  }

  byIdFor(ownerUserId: string, profileId: string): AgentProfile | undefined {
    return this.db.db
      .prepare(
        "SELECT * FROM agent_profiles WHERE id = ? AND owner_user_id = ? AND status = 'active'",
      )
      .get(profileId, ownerUserId) as AgentProfile | undefined;
  }

  defaultFor(ownerUserId: string): AgentProfile | undefined {
    return this.db.db
      .prepare(
        "SELECT * FROM agent_profiles WHERE owner_user_id = ? AND is_default = 1 AND status = 'active'",
      )
      .get(ownerUserId) as AgentProfile | undefined;
  }

  versions(profileId: string): Array<{ version: number; created_at: string }> {
    return this.db.db
      .prepare(
        'SELECT version, created_at FROM agent_profile_versions WHERE agent_profile_id = ? ORDER BY version',
      )
      .all(profileId) as Array<{ version: number; created_at: string }>;
  }

  // ---- two-stage draft / confirmation (spec §6.3 item 5) ------------------

  /**
   * Stage 1: AI drafts a proposed profile. Nothing is published; the user
   * must reply with the confirmation phrase to stage-2 publish it.
   */
  createDraft(
    ownerUserId: string,
    draftJson: string,
  ): { draftId: string; confirmationPhrase: string; expiresAt: string; stage: string } {
    const id = randomBytes(16).toString('hex');
    const phrase = this.phrase();
    // Expiry rides the same injectable clock as everywhere else (15 min TTL).
    const expiresAt = new Date(Date.parse(this.now()) + DRAFT_TTL_SECONDS * 1000).toISOString();
    this.db.db
      .prepare(
        "INSERT INTO profile_drafts (id, owner_user_id, draft_json, confirmation_phrase, expires_at, stage, created_at) VALUES (?, ?, ?, ?, ?, 'draft', ?)",
      )
      .run(id, ownerUserId, draftJson, phrase, expiresAt, this.now());
    return { draftId: id, confirmationPhrase: phrase, expiresAt, stage: 'draft' };
  }

  getDraft(ownerUserId: string, draftId: string): DraftRecord | undefined {
    return this.db.db
      .prepare('SELECT * FROM profile_drafts WHERE id = ? AND owner_user_id = ?')
      .get(draftId, ownerUserId) as DraftRecord | undefined;
  }

  /**
   * Stage 2: confirm with the exact phrase. Mismatch aborts (作废重来); expiry
   * invalidates. On success the draft is published via publishFromDraft.
   */
  confirmDraft(
    ctx: PublishContext,
    draftId: string,
    phrase: string,
    publish: (ctx: PublishContext, draftJson: string) => void,
  ): { status: 'published' } | { status: 'not_found' } | { status: 'aborted'; reason: string } {
    const draft = this.getDraft(ctx.userId, draftId);
    if (draft === undefined) return { status: 'not_found' };
    if (draft.stage !== 'draft') return { status: 'aborted', reason: 'draft already resolved' };
    const now = this.now();
    if (draft.expires_at <= now) {
      this.db.db
        .prepare("UPDATE profile_drafts SET stage = 'expired' WHERE id = ?")
        .run(draftId);
      return { status: 'aborted', reason: 'draft expired' };
    }
    if (!this.phrasesEqual(draft.confirmation_phrase, phrase)) {
      this.db.db
        .prepare("UPDATE profile_drafts SET stage = 'aborted' WHERE id = ?")
        .run(draftId);
      return { status: 'aborted', reason: 'confirmation phrase mismatch — draft aborted' };
    }
    this.db.db
      .prepare("UPDATE profile_drafts SET stage = 'confirmed' WHERE id = ?")
      .run(draftId);
    publish(ctx, draft.draft_json);
    return { status: 'published' };
  }

  // ---- internals ----------------------------------------------------------

  private snapshot(profile: AgentProfile): void {
    this.db.db
      .prepare(
        'INSERT INTO agent_profile_versions (id, agent_profile_id, version, identity_prompt, soul_prompt, agents_prompt, tools_prompt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        randomBytes(16).toString('hex'),
        profile.id,
        profile.version,
        profile.identity_prompt,
        profile.soul_prompt,
        profile.agents_prompt,
        profile.tools_prompt,
        nowIso(),
      );
  }

  private countOwnerActive(ownerUserId: string): number {
    return (
      this.db.db
        .prepare(
          "SELECT COUNT(*) AS n FROM agent_profiles WHERE owner_user_id = ? AND status = 'active'",
        )
        .get(ownerUserId) as { n: number }
    ).n;
  }

  private notFound(): never {
    throw new Error('profile not found');
  }

  private phrase(): string {
    const len = PHRASE_MIN + Math.floor(Math.random() * (PHRASE_MAX - PHRASE_MIN + 1));
    let out = '';
    for (let i = 0; i < len; i++) {
      out += PHRASE_ALPHABET[Math.floor(Math.random() * PHRASE_ALPHABET.length)];
    }
    return out;
  }

  /** Constant-time comparison (we can't leak which characters matched). */
  private phrasesEqual(a: string, b: string): boolean {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  }
}
