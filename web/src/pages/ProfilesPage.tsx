/**
 * Profiles editor: four orthogonal segments (IDENTITY/SOUL/AGENTS/TOOLS),
 * immutable version history with restore, and the two-stage draft publish
 * (create draft → confirm phrase → publish). Single Anthropic profile per
 * user; promptMode controls append vs replace merge semantics.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Profile, type ProfileVersion } from '../api.js';
import { ArtImage, EmptyState } from '../components/Design.js';
import { useMobileSidebar } from '../hooks/useMobileSidebar.js';

const SEGMENTS = [
  {
    key: 'identity',
    label: 'Identity',
    description: 'Define who your worker is, its role, and how it introduces itself.',
  },
  {
    key: 'soul',
    label: 'Values',
    description: 'Describe its principles, tone, and boundaries.',
  },
  {
    key: 'agents',
    label: 'Working rules',
    description: 'Set priorities, collaboration habits, and how work should be approached.',
  },
  {
    key: 'tools',
    label: 'Tools',
    description: 'Explain when and how available tools should be used.',
  },
] as const;

type SegmentKey = (typeof SEGMENTS)[number]['key'];

export function ProfilesPage() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const active = profiles.find((p) => p.id === activeId) ?? null;
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const sidebar = useMobileSidebar();
  const newProfileRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const { profiles: list } = await api.get<{ profiles: Profile[] }>('/profiles');
      setProfiles(list);
      setActiveId((prev) => prev ?? list[0]?.id ?? null);
    } catch {
      setError('Could not load profiles. Please try again.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return (
    <div className={`split-page profiles-page ${sidebar.open ? 'profiles-open' : ''}`}>
      <button
        ref={sidebar.toggleRef}
        className="session-toggle"
        aria-expanded={sidebar.open}
        aria-controls="profiles-sidebar"
        onClick={sidebar.toggle}
      >
        <span>
          Your workers <span className="session-count">{profiles.length}</span>
        </span>
        <span>{sidebar.open ? 'Close −' : 'Browse +'}</span>
      </button>
      {sidebar.open && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="Close profiles panel"
          onClick={() => sidebar.close()}
        />
      )}
      <div ref={sidebar.panelRef} className="list-panel profiles-sidebar" id="profiles-sidebar">
        <div className="task-filters">
          <span className="eyebrow">Your digital workers</span>
          <input
            ref={sidebar.primaryFocusRef as React.RefObject<HTMLInputElement | null>}
            type="search"
            aria-label="Find profiles"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Find a profile…"
          />
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {profiles
            .filter((p) => p.name.toLowerCase().includes(query.toLowerCase().trim()))
            .map((p) => (
              <button
                key={p.id}
                onClick={() => {
                  setActiveId(p.id);
                  sidebar.close();
                }}
                disabled={editing && p.id !== activeId}
                aria-pressed={p.id === activeId}
                title={
                  editing && p.id !== activeId
                    ? 'Save or discard your changes before switching profiles.'
                    : p.name
                }
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
          {!loading &&
            profiles.filter((p) => p.name.toLowerCase().includes(query.toLowerCase().trim()))
              .length === 0 && (
              <p className="session-help">
                {query ? 'No matching profiles.' : 'Create your first digital worker below.'}
              </p>
            )}
        </div>
        <div className="border-t border-slate-200 p-2">
          <NewProfileButton
            inputRef={newProfileRef}
            disabled={editing}
            onCreated={(p) => {
              setProfiles((prev) => [...prev, p]);
              setActiveId(p.id);
              sidebar.close();
            }}
          />
        </div>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}{' '}
          <button className="underline" onClick={() => void reload()}>
            Retry
          </button>
        </p>
      )}
      {active !== null ? (
        <ProfileEditor
          key={active.id}
          profile={active}
          onEditing={setEditing}
          onSaved={(p) => setProfiles((prev) => prev.map((x) => (x.id === p.id ? p : x)))}
          onReload={reload}
        />
      ) : loading ? (
        <div className="chat-loading" role="status">
          Loading profiles…
        </div>
      ) : (
        <div className="empty-action">
          <EmptyState title="Shape your digital worker." art="linen">
            Create a profile to define its identity, values, working rules, and tools.
          </EmptyState>
          <button
            className="min-h-11 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white"
            onClick={() => sidebar.openAndFocus(newProfileRef.current)}
          >
            Create a profile
          </button>
        </div>
      )}
    </div>
  );
}

function NewProfileButton({
  onCreated,
  disabled,
  inputRef,
}: {
  onCreated: (p: Profile) => void;
  disabled: boolean;
  inputRef: React.RefObject<HTMLInputElement | null>;
}) {
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    if (busy || disabled || !name.trim()) return;
    setError(null);
    setBusy(true);
    try {
      const { profile } = await api.post<{ profile: Profile }>('/profiles', {
        name: name.trim(),
        segments: { identity: '', soul: '', agents: '', tools: '' },
        promptMode: 'append',
      });
      onCreated(profile);
      setName('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create profile.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <input
        ref={inputRef}
        aria-label="New profile name"
        placeholder="Give your worker a name"
        maxLength={120}
        value={name}
        disabled={disabled || busy}
        onChange={(e) => setName(e.target.value)}
        className="mb-2 w-full rounded-md border border-slate-300 px-3 py-2 text-sm"
      />
      {error && (
        <p role="alert" className="mb-2 text-xs text-red-700">
          {error}
        </p>
      )}
      <button
        onClick={() => void create()}
        disabled={busy || disabled || !name.trim()}
        className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50"
      >
        {busy ? 'Creating…' : '+ New profile'}
      </button>
    </>
  );
}

function ProfileEditor(props: {
  profile: Profile;
  onSaved: (p: Profile) => void;
  onReload: () => Promise<void>;
  onEditing: (editing: boolean) => void;
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
  const dirty =
    name !== p.name || mode !== p.promptMode || SEGMENTS.some((s) => segs[s.key] !== p[s.key]);
  const [section, setSection] = useState<SegmentKey>('identity');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setName(p.name);
    setMode(p.promptMode);
    setSegs({ identity: p.identity, soul: p.soul, agents: p.agents, tools: p.tools });
    setError(null);
  }, [p.id, p.updatedAt, p.name, p.promptMode, p.identity, p.soul, p.agents, p.tools]);
  useEffect(() => {
    props.onEditing(dirty || busy);
  }, [dirty, busy, props.onEditing]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);
  const discard = () => {
    setName(p.name);
    setMode(p.promptMode);
    setSegs({ identity: p.identity, soul: p.soul, agents: p.agents, tools: p.tools });
    setError(null);
    setSaved(false);
  };

  const save = async () => {
    if (busy || !dirty || !name.trim()) return;
    setSaved(false);
    setBusy(true);
    setError(null);
    try {
      const { profile } = await api.patch<{ profile: Profile }>(`/profiles/${p.id}`, {
        name,
        segments: segs,
        promptMode: mode,
      });
      props.onSaved(profile);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'save failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="detail-panel profile-detail">
      <div className="content-page space-y-4">
        <div className="profile-intro">
          <ArtImage kind="linen" className="profile-art" />
          <span className="eyebrow">Profile / Version {p.version}</span>
          <h2>Give your worker character.</h2>
          <p>Four thoughtful pieces, one consistent way of working.</p>
        </div>
        <div className="editor-toolbar profile-toolbar">
          <input
            value={name}
            aria-label="Profile name"
            disabled={busy}
            onChange={(e) => {
              setName(e.target.value);
            }}
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium"
          />
          <select
            value={mode}
            aria-label="Prompt mode"
            disabled={busy}
            onChange={(e) => {
              setMode(e.target.value as 'append' | 'replace');
            }}
            className="rounded-md border border-slate-300 px-2 py-2 text-sm"
          >
            <option value="append">append</option>
            <option value="replace">replace</option>
          </select>
          <button
            onClick={() => void save()}
            disabled={!dirty || busy || !name.trim()}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Save (new version)'}
          </button>
          <button
            onClick={discard}
            disabled={!dirty || busy}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-50"
          >
            Discard
          </button>
        </div>
        <p className={`profile-save-state ${dirty ? 'is-dirty' : ''}`} role="status">
          {dirty
            ? 'Unsaved changes — save or discard before switching profiles.'
            : saved
              ? 'Saved as a new version.'
              : 'All changes saved.'}
        </p>
        <p className="session-help">
          {mode === 'append'
            ? 'Append adds these instructions to the base profile.'
            : 'Replace replaces the editable base instructions. Platform rules still apply.'}
        </p>
        {error !== null && <p className="text-sm text-red-600">{error}</p>}
        <div className="profile-sections" aria-label="Profile sections">
          {SEGMENTS.map((s) => (
            <button
              key={s.key}
              aria-pressed={section === s.key}
              onClick={() => setSection(s.key)}
            >
              {s.label}
              <span>{segs[s.key].trim() ? '●' : '○'}</span>
            </button>
          ))}
        </div>
        {SEGMENTS.filter((s) => s.key === section).map((s) => (
          <div key={s.key} className="rounded-lg border border-slate-200 bg-white p-4">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
              {s.label}
            </div>
            <p className="session-help">{s.description}</p>
            <textarea
              value={segs[s.key]}
              aria-label={s.label}
              disabled={busy}
              placeholder={s.description}
              onChange={(e) => {
                setSegs((prev) => ({ ...prev, [s.key]: e.target.value }));
              }}
              rows={10}
              className="w-full resize-y rounded-md border border-slate-300 px-3 py-2 font-mono text-sm focus:border-slate-500 focus:outline-none"
            />
            <p className="profile-character-count">
              {segs[s.key].length.toLocaleString()} characters · {s.key.toUpperCase()}
            </p>
          </div>
        ))}
        <VersionHistory
          key={`${p.id}-${p.version}`}
          profile={p}
          disabled={dirty || busy}
          onRestored={(np) => props.onSaved(np)}
        />
        <details className="profile-advanced">
          <summary>Advanced: publish a draft</summary>
          <fieldset disabled={dirty || busy}>
            <DraftFlow key={p.id} profile={p} onPublished={() => void props.onReload()} />
          </fieldset>
          {dirty && (
            <p className="session-help">
              Save or discard your changes before publishing a draft.
            </p>
          )}
        </details>
      </div>
    </div>
  );
}

function VersionHistory(props: {
  profile: Profile;
  onRestored: (p: Profile) => void;
  disabled: boolean;
}) {
  const [versions, setVersions] = useState<ProfileVersion[] | null>(null);
  const [busyVersion, setBusyVersion] = useState<number | null>(null);
  const p = props.profile;
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setError(null);
    setLoading(true);
    try {
      const { versions: v } = await api.get<{ versions: ProfileVersion[] }>(
        `/profiles/${p.id}/versions`,
      );
      setVersions(v);
    } catch {
      setError('Could not load version history. Please retry.');
    } finally {
      setLoading(false);
    }
  };

  const restore = async (version: number) => {
    if (props.disabled || busyVersion !== null) return;
    setError(null);
    setBusyVersion(version);
    try {
      const { profile } = await api.post<{ profile: Profile }>(`/profiles/${p.id}/restore`, {
        version,
      });
      props.onRestored(profile);
    } catch {
      setError('Could not restore this version. Please try again.');
    } finally {
      setBusyVersion(null);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          Version history
        </span>
        <button
          disabled={loading}
          onClick={() => void load()}
          className="text-xs text-slate-600 underline"
        >
          {loading ? 'Loading…' : versions === null ? 'Show history' : 'Refresh history'}
        </button>
      </div>
      <p className="session-help">Restoring keeps existing versions and creates a new one.</p>
      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}
      {versions !== null && (
        <ul className="space-y-1 text-sm">
          {versions.map((v) => (
            <li key={v.version} className="flex items-center justify-between">
              <span className="text-slate-700">
                v{v.version} — {new Date(v.created_at).toLocaleString()}
              </span>
              <button
                onClick={() => void restore(v.version)}
                disabled={props.disabled || busyVersion !== null}
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
