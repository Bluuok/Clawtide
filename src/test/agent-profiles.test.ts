/**
 * R15 — profile store (spec §6.3 必备测试): per-owner default index, version
 * bump + immutable history, restore = new version, orthogonal segment update,
 * two-stage draft/confirmation with phrase mismatch/expiry.
 */
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../db.js';
import { AgentProfileStore, type PublishContext } from '../stores/agent-profiles.js';
import { makeTestConfig, testLogger, cleanupDir } from '../test-support/harness.js';

function makeStore(now?: () => string) {
  const config = makeTestConfig();
  const db = openDatabase({ config, logger: testLogger() });
  db.db
    .prepare(
      "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u1', 'alice', 'h', 'member', '2026-01-01T00:00:00.000Z')",
    )
    .run();
  db.db
    .prepare(
      "INSERT INTO users (id, username, password_hash, role, created_at) VALUES ('u2', 'bob', 'h', 'member', '2026-01-01T00:00:00.000Z')",
    )
    .run();
  return {
    db,
    config,
    store: new AgentProfileStore(db, now),
    close: () => {
      db.close();
      cleanupDir(config.dataDir);
    },
  };
}

const segs = {
  identity_prompt: 'identity',
  soul_prompt: 'soul',
  agents_prompt: 'agents',
  tools_prompt: 'tools',
};

describe('agent profile store', () => {
  it('first profile becomes default; second does not', () => {
    const { store, close } = makeStore();
    try {
      const a = store.create('u1', { name: 'Phi', segments: segs, prompt_mode: 'append' });
      expect(a.is_default).toBe(1);
      const b = store.create('u1', { name: 'Beta', segments: segs, prompt_mode: 'replace' });
      expect(b.is_default).toBe(0);
      expect(store.defaultFor('u1')!.id).toBe(a.id);
    } finally {
      close();
    }
  });

  it('per-owner partial unique index rejects a second active default', () => {
    const { db, close } = makeStore();
    try {
      const insert = (id: string) =>
        db.db
          .prepare(
            `INSERT INTO agent_profiles (id, owner_user_id, name, identity_prompt, soul_prompt, agents_prompt, tools_prompt, prompt_mode, version, identity_hash, is_default, status, created_at, updated_at)
             VALUES (?, 'u1','x','','','','','append',1,'h',1,'active','t','t')`,
          )
          .run(id);
      insert('p1');
      expect(() => insert('p2')).toThrowError(/UNIQUE constraint failed/);
    } finally {
      close();
    }
  });

  it('setDefault moves the default without violating the index', () => {
    const { store, close } = makeStore();
    try {
      const a = store.create('u1', { name: 'A', segments: segs, prompt_mode: 'append' });
      const b = store.create('u1', { name: 'B', segments: segs, prompt_mode: 'append' });
      store.setDefault('u1', b.id);
      expect(store.byId(a.id)!.is_default).toBe(0);
      expect(store.byId(b.id)!.is_default).toBe(1);
      expect(store.defaultFor('u1')!.id).toBe(b.id);
    } finally {
      close();
    }
  });

  it('update bumps version, snapshots history immutably, and changes only touched segments', () => {
    const { db, store, close } = makeStore();
    try {
      const a = store.create('u1', { name: 'P', segments: segs, prompt_mode: 'append' });
      const updated = store.update('u1', a.id, { soul_prompt: 'new soul' });
      expect(updated.version).toBe(2);
      expect(updated.identity_prompt).toBe('identity'); // untouched
      expect(updated.soul_prompt).toBe('new soul');
      // History row for v1 exists with original segments.
      const versions = store.versions(a.id);
      expect(versions).toHaveLength(1);
      const v1 = db.db
        .prepare(
          'SELECT identity_prompt FROM agent_profile_versions WHERE agent_profile_id = ? AND version = 1',
        )
        .get(a.id) as { identity_prompt: string };
      expect(v1.identity_prompt).toBe('identity');

      // Restoring from v1 (restore = new version, history untouched).
      const restored = store.restore('u1', a.id, 1);
      expect(restored.version).toBe(3);
      expect(restored.soul_prompt).toBe('soul'); // back to v1 content
      expect(store.versions(a.id)).toHaveLength(2);
    } finally {
      close();
    }
  });

  it('two-stage draft/confirmation: mismatch aborts, expiry rejects, correct phrase publishes', () => {
    let now = new Date('2026-01-01T00:00:00.000Z').toISOString();
    const { store, close } = makeStore(() => now);
    try {
      const draftJson = JSON.stringify({ name: 'Drafted', ...segs, promptMode: 'append' });
      const draft = store.createDraft('u1', draftJson);
      expect(draft.confirmationPhrase.length).toBeGreaterThanOrEqual(6);
      expect(draft.confirmationPhrase.length).toBeLessThanOrEqual(8);
      expect(draft.stage).toBe('draft');

      const published: string[] = [];
      const publish = (_ctx: PublishContext, json: string) => published.push(json);

      // Wrong phrase aborts and voids the draft.
      const mismatch = store.confirmDraft({ userId: 'u1' }, draft.draftId, 'XXXXXXXX', publish);
      expect(mismatch.status).toBe('aborted');
      expect((mismatch as { status: string }).status === 'aborted' && published.length).toBe(0);
      const afterMiss = store.confirmDraft(
        { userId: 'u1' },
        draft.draftId,
        draft.confirmationPhrase,
        publish,
      );
      expect(afterMiss.status).toBe('aborted'); // already aborted — 作废重来
      expect(published.length).toBe(0);

      // Correct phrase: publishes.
      const draft2 = store.createDraft('u1', draftJson);
      const ok = store.confirmDraft(
        { userId: 'u1' },
        draft2.draftId,
        draft2.confirmationPhrase,
        publish,
      );
      expect(ok.status).toBe('published');
      expect(published).toHaveLength(1);

      // Expiry: force clock past TTL (15 min) on a fresh draft.
      const draft3 = store.createDraft('u1', draftJson);
      now = new Date('2026-01-01T00:16:00.000Z').toISOString();
      const expired = store.confirmDraft(
        { userId: 'u1' },
        draft3.draftId,
        draft3.confirmationPhrase,
        publish,
      );
      expect(expired).toEqual({ status: 'aborted', reason: 'draft expired' });
      expect(published).toHaveLength(1); // no additional publish
    } finally {
      close();
    }
  });
});
