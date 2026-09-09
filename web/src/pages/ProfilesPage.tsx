/**
 * Profiles editor: four orthogonal segments (IDENTITY/SOUL/AGENTS/TOOLS),
 * immutable version history with restore, and the two-stage draft publish
 * (create draft → confirm phrase → publish). Single Anthropic profile per
 * user; promptMode controls append vs replace merge semantics.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Profile, type ProfileVersion } from '../api.js';
import { EmptyState } from '../components/Design.js';

const SEGMENTS = [
  { key: 'identity', label: 'IDENTITY — who am I' },
  { key: 'soul', label: 'SOUL — values & bottom lines' },
  { key: 'agents', label: 'AGENTS — working rules (declarative)' },
  { key: 'tools', label: 'TOOLS — tool policy' },
] as const;

type SegmentKey = (typeof SEGMENTS)[number]['key'];

export function ProfilesPage() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = profiles.find((p) => p.id === activeId) ?? null;

  const reload = useCallback(async () => {
    const { profiles: list } = await api.get<{ profiles: Profile[] }>('/profiles');
    setProfiles(list);
    setActiveId((prev) => prev ?? list[0]?.id ?? null);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className="split-page">
      <div className="list-panel">
        <div className="border-b border-slate-200 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          My profiles
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {profiles.map((p) => (
            <button
              key={p.id}
              onClick={() => setActiveId(p.id)}
              className={`block w-full px-3 py-2 text-left text-sm ${
                p.id === activeId ? 'bg-slate-100 font-medium' : 'hover:bg-slate-50'
              }`}
            >
              {p.name}
              {p.isDefault && <span className="ml-1 text-xs text-emerald-600">default</span>}
              <span className="block text-xs text-slate-400">
                v{p.version} · {p.promptMode}
              </span>
            </button>
          ))}
        </div>
        <div className="border-t border-slate-200 p-2">
          <NewProfileButton
            onCreated={(p) => {
              setProfiles((prev) => [...prev, p]);
              setActiveId(p.id);
            }}
          />
        </div>
      </div>
      {active !== null ? (
        <ProfileEditor
          profile={active}
          onSaved={(p) => setProfiles((prev) => prev.map((x) => (x.id === p.id ? p : x)))}
          onReload={reload}
        />
      ) : (
        <EmptyState title="Shape your digital worker.">
          Create a profile to define its identity, values, working rules, and tools.
        </EmptyState>
      )}
    </div>
  );
}

function NewProfileButton({ onCreated }: { onCreated: (p: Profile) => void }) {
  const [busy, setBusy] = useState(false);
  const create = async () => {
    setBusy(true);
    try {
      const n = Date.now() % 10000;
      const { profile } = await api.post<{ profile: Profile }>('/profiles', {
        name: `Profile ${n}`,
        segments: { identity: '', soul: '', agents: '', tools: '' },
        promptMode: 'append',
      });
      onCreated(profile);
    } finally {
      setBusy(false);
    }
  };
  return (
    <button
      onClick={() => void create()}
      disabled={busy}
      className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50"
    >
      + New profile
    </button>
  );
}

function ProfileEditor(props: {
  profile: Profile;
  onSaved: (p: Profile) => void;
  onReload: () => Promise<void>;
}) {
  const p = props.profile;
  const [name, setName] = useState(p.name);
  const [mode, setMode] = useState<'append' | 'replace'>(p.promptMode);
  const [segs, setSegs] = useState<Record<SegmentKey, string>>({
    identity: p.identity,
    soul: p.soul,
    agents: p.agents,
    tools: p.tools,
  });
  const [dirty, setDirty] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(p.name);
    setMode(p.promptMode);
    setSegs({ identity: p.identity, soul: p.soul, agents: p.agents, tools: p.tools });
    setDirty(false);
    setError(null);
  }, [p.id, p.updatedAt, p.name, p.promptMode, p.identity, p.soul, p.agents, p.tools]);

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const { profile } = await api.patch<{ profile: Profile }>(`/profiles/${p.id}`, {
        name,
        segments: segs,
        promptMode: mode,
      });
      props.onSaved(profile);
      setDirty(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="detail-panel">
      <div className="content-page space-y-4">
        <div className="editor-toolbar">
          <input
            value={name}
            aria-label="Profile name"
            onChange={(e) => {
              setName(e.target.value);
              setDirty(true);
            }}
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium"
          />
          <select
            value={mode}
            aria-label="Prompt mode"
            onChange={(e) => {
              setMode(e.target.value as 'append' | 'replace');
              setDirty(true);
            }}
            className="rounded-md border border-slate-300 px-2 py-2 text-sm"
          >
            <option value="append">append</option>
            <option value="replace">replace</option>
          </select>
          <button
            onClick={() => void save()}
            disabled={!dirty || busy}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save (new version)'}
          </button>
          <button
            onClick={() => void props.onReload()}
            disabled={!dirty}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-50"
          >
            Discard
          </button>
        </div>
        {error !== null && <p className="text-sm text-red-600">{error}</p>}
        {SEGMENTS.map((s) => (
          <div key={s.key} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {s.label}
            </div>
            <textarea
              value={segs[s.key]}
              aria-label={s.label}
              onChange={(e) => {
                setSegs((prev) => ({ ...prev, [s.key]: e.target.value }));
                setDirty(true);
              }}
              rows={4}
              className="w-full resize-y rounded-md border border-slate-300 px-3 py-2 font-mono text-sm focus:border-slate-500 focus:outline-none"
            />
          </div>
        ))}
        <VersionHistory profile={p} onRestored={(np) => props.onSaved(np)} />
        <DraftFlow profile={p} onPublished={() => void props.onReload()} />
      </div>
    </div>
  );
}

function VersionHistory(props: { profile: Profile; onRestored: (p: Profile) => void }) {
  const [versions, setVersions] = useState<ProfileVersion[] | null>(null);
  const [busyVersion, setBusyVersion] = useState<number | null>(null);
  const p = props.profile;

  const load = async () => {
    const { versions: v } = await api.get<{ versions: ProfileVersion[] }>(
      `/profiles/${p.id}/versions`,
    );
    setVersions(v);
  };

  const restore = async (version: number) => {
    setBusyVersion(version);
    try {
      const { profile } = await api.post<{ profile: Profile }>(`/profiles/${p.id}/restore`, {
        version,
      });
      props.onRestored(profile);
    } finally {
      setBusyVersion(null);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Version history (immutable — restore writes a new version)
        </span>
        <button onClick={() => void load()} className="text-xs text-slate-600 underline">
          {versions === null ? 'Show' : 'Refresh'}
        </button>
      </div>
      {versions !== null && (
        <ul className="space-y-1 text-sm">
          {versions.map((v) => (
            <li key={v.version} className="flex items-center justify-between">
              <span className="text-slate-700">
                v{v.version} — {v.created_at}
              </span>
              <button
                onClick={() => void restore(v.version)}
                disabled={busyVersion !== null}
                className="rounded border border-slate-300 px-2 py-0.5 text-xs hover:bg-slate-100 disabled:opacity-50"
              >
                Restore
              </button>
            </li>
          ))}
          {versions.length === 0 && <li className="text-slate-400">No history yet.</li>}
        </ul>
      )}
    </div>
  );
}

/**
 * Two-stage publish: stage 1 creates a draft (nothing takes effect) and gets
 * a confirmation phrase; stage 2 publishes only on the exact phrase. A wrong
 * phrase aborts the draft — the user starts over.
 */
function DraftFlow(props: { profile: Profile; onPublished: () => void }) {
  const [draftJson, setDraftJson] = useState('');
  const [phrase, setPhrase] = useState<string | null>(null);
  const [draftId, setDraftId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const createDraft = async () => {
    setBusy(true);
    setError(null);
    try {
      // Prefill from the current profile so the flow is one click.
      const body =
        draftJson.trim() ||
        JSON.stringify(
          {
            profileId: props.profile.id,
            name: props.profile.name,
            identity: props.profile.identity,
            soul: props.profile.soul,
            agents: props.profile.agents,
            tools: props.profile.tools,
            promptMode: props.profile.promptMode,
          },
          null,
          2,
        );
      const res = await api.post<{ draftId: string; confirmationPhrase: string }>('/drafts', {
        draftJson: body,
      });
      setDraftJson(body);
      setDraftId(res.draftId);
      setPhrase(res.confirmationPhrase);
      setConfirm('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'draft failed');
    } finally {
      setBusy(false);
    }
  };

  const confirmPublish = async () => {
    if (draftId === null) return;
    setBusy(true);
    setError(null);
    try {
      await api.post(`/drafts/${draftId}/confirm`, { phrase: confirm });
      setDraftId(null);
      setPhrase(null);
      setConfirm('');
      props.onPublished();
    } catch (err) {
      if (err instanceof ApiError) {
        setError(err.message);
        // A mismatched phrase aborts the draft — restart the flow.
        if (err.status === 400) {
          setDraftId(null);
          setPhrase(null);
        }
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        Two-stage AI draft publish (draft → confirm phrase → publish)
      </div>
      {draftId === null ? (
        <div className="space-y-2">
          <textarea
            value={draftJson}
            onChange={(e) => setDraftJson(e.target.value)}
            rows={5}
            placeholder={
              'Optional draft JSON — empty uses the current profile:\n{"name": …, "identity": …, "soul": …, "agents": …, "tools": …, "promptMode": "append"|"replace"}'
            }
            className="w-full resize-y rounded-md border border-slate-300 px-3 py-2 font-mono text-xs"
          />
          <button
            onClick={() => void createDraft()}
            disabled={busy}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50"
          >
            Stage 1: Create draft
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
            Draft created. Confirm phrase:{' '}
            <span className="font-mono font-semibold">{phrase}</span>
            <span className="block text-xs text-amber-700">
              Type the phrase exactly to publish. A mismatch aborts the draft.
            </span>
          </div>
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="Type the confirmation phrase"
            className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
          />
          <button
            onClick={() => void confirmPublish()}
            disabled={busy || confirm.length === 0}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            Stage 2: Publish
          </button>
        </div>
      )}
      {error !== null && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
