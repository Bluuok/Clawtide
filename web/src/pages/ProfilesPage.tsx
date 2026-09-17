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
import { useSession } from '../stores/session.js';
import { useMemoryDrafts } from '../stores/memoryDrafts.js';

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
          onDefaultChanged={(updated) =>
            setProfiles((prev) =>
              prev.map((x) => (x.id === updated.id ? updated : { ...x, isDefault: false })),
            )
          }
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
  onDefaultChanged: (updated: Profile) => void;
}) {
  const p = props.profile;

  // Stable store action selectors (never whole-store objects in deps).
  const userId = useSession((s) => s.user?.id);
  const getProfileDraft = useMemoryDrafts((s) => s.getProfileDraft);
  const setProfileDraft = useMemoryDrafts((s) => s.setProfileDraft);
  const clearProfileDraft = useMemoryDrafts((s) => s.clearProfileDraft);
  const getAuthEpoch = useCallback(() => useMemoryDrafts.getState().authEpoch, []);
  const epochAtMount = useRef(getAuthEpoch());
  const baseline = useRef(p);

  // Initialise from memory draft if one exists for this profile/user.
  const [name, setName] = useState(() => {
    const mem = getProfileDraft(userId, p.id);
    return (mem ?? null) ? mem!.name : p.name;
  });
  const [mode, setMode] = useState<'append' | 'replace'>(() => {
    const mem = getProfileDraft(userId, p.id);
    return (mem ?? null) ? mem!.promptMode : p.promptMode;
  });
  const [segs, setSegs] = useState<Record<SegmentKey, string>>(() => {
    const mem = getProfileDraft(userId, p.id);
    if (mem) {
      return {
        identity: mem.segs.identity ?? p.identity,
        soul: mem.segs.soul ?? p.soul,
        agents: mem.segs.agents ?? p.agents,
        tools: mem.segs.tools ?? p.tools,
      };
    }
    return { identity: p.identity, soul: p.soul, agents: p.agents, tools: p.tools };
  });
  const [baseVersion, setBaseVersion] = useState(() => {
    const mem = getProfileDraft(userId, p.id);
    return mem?.baseVersion ?? p.version;
  });

  // Warn when incoming profile version is newer than what the draft is based on.
  const [staleWarning, setStaleWarning] = useState<string | null>(null);

  const dirty =
    name !== baseline.current.name ||
    mode !== baseline.current.promptMode ||
    SEGMENTS.some((s) => segs[s.key] !== baseline.current[s.key]);
  const [section, setSection] = useState<SegmentKey>('identity');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [defaultBusy, setDefaultBusy] = useState(false);
  const [defaultError, setDefaultError] = useState<string | null>(null);

  // When server-side profile metadata changes (e.g. after setDefault or restore),
  // update name/mode/segs only when there is no unsaved draft; otherwise warn.
  useEffect(() => {
    // Detect a new incoming version that differs from what the draft is based on.
    if (p.version !== baseVersion) {
      if (dirty) {
        // Draft is based on a stale version — warn but do NOT replace text.
        setStaleWarning(
          `The profile was updated to v${p.version} externally. ` +
            `Your draft is still based on v${baseVersion}. ` +
            `Discard your draft to load the latest version.`,
        );
        return;
      }
      // No unsaved edits — safe to absorb the new server state.
      baseline.current = p;
      setName(p.name);
      setMode(p.promptMode);
      setSegs({ identity: p.identity, soul: p.soul, agents: p.agents, tools: p.tools });
      setBaseVersion(p.version);
      setStaleWarning(null);
      setError(null);
    } else {
      // Same version — absorb metadata-only changes (name/promptMode) unless dirty.
      if (!dirty) {
        setName(p.name);
        setMode(p.promptMode);
        setSegs({ identity: p.identity, soul: p.soul, agents: p.agents, tools: p.tools });
        setStaleWarning(null);
        setError(null);
      }
    }
    // p.id guards remounting; only react to server-pushed field changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    p.id,
    p.updatedAt,
    p.name,
    p.promptMode,
    p.identity,
    p.soul,
    p.agents,
    p.tools,
    p.version,
  ]);

  // Also persist while the component is mounted on every change (survives same-session nav).
  useEffect(() => {
    if (getAuthEpoch() !== epochAtMount.current || useSession.getState().user?.id !== userId)
      return;
    if (dirty) {
      setProfileDraft(userId, p.id, { name, promptMode: mode, segs, baseVersion });
    } else {
      clearProfileDraft(userId, p.id);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, mode, segs, baseVersion, dirty]);

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
    baseline.current = p;
    setName(p.name);
    setMode(p.promptMode);
    setSegs({ identity: p.identity, soul: p.soul, agents: p.agents, tools: p.tools });
    setBaseVersion(p.version);
    setError(null);
    setSaved(false);
    setStaleWarning(null);
    clearProfileDraft(userId, p.id);
  };

  const save = async () => {
    if (busy || !dirty || !name.trim()) return;
    setSaved(false);
    setBusy(true);
    setError(null);
    const epochAtCall = getAuthEpoch();
    try {
      const { profile } = await api.patch<{ profile: Profile }>(`/profiles/${p.id}`, {
        name,
        segments: segs,
        promptMode: mode,
      });
      if (getAuthEpoch() !== epochAtCall) return;
      baseline.current = profile;
      setName(profile.name);
      setMode(profile.promptMode);
      setSegs({
        identity: profile.identity,
        soul: profile.soul,
        agents: profile.agents,
        tools: profile.tools,
      });
      props.onSaved(profile);
      setBaseVersion(profile.version);
      clearProfileDraft(userId, p.id);
      setSaved(true);
      setStaleWarning(null);
    } catch (err) {
      if (getAuthEpoch() !== epochAtCall) return;
      setError(err instanceof ApiError ? err.message : 'save failed');
    } finally {
      if (getAuthEpoch() === epochAtCall) setBusy(false);
    }
  };

  const setAsDefault = async () => {
    if (defaultBusy || p.isDefault) return;
    setDefaultBusy(true);
    setDefaultError(null);
    const epochAtCall = getAuthEpoch();
    try {
      const { profile: updated } = await api.post<{ profile: Profile }>(
        `/profiles/${p.id}/default`,
      );
      if (getAuthEpoch() !== epochAtCall) return;
      // Update all badges: mark this profile default, clear others.
      props.onDefaultChanged(updated);
    } catch (err) {
      if (getAuthEpoch() !== epochAtCall) return;
      setDefaultError(err instanceof ApiError ? err.message : 'Could not set default profile.');
    } finally {
      if (getAuthEpoch() === epochAtCall) setDefaultBusy(false);
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
        {staleWarning !== null && (
          <p role="alert" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
            {staleWarning}
          </p>
        )}
        {error !== null && <p className="text-sm text-red-600">{error}</p>}
        {/* Set as default */}
        <div className="flex items-center gap-3">
          {p.isDefault ? (
            <span className="text-sm text-emerald-700 font-medium">
              ✓ This is the default profile
            </span>
          ) : (
            <>
              <button
                onClick={() => void setAsDefault()}
                disabled={defaultBusy}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50"
              >
                {defaultBusy ? 'Setting…' : 'Set as default'}
              </button>
              {defaultError !== null && (
                <span className="text-sm text-red-600">{defaultError}</span>
              )}
            </>
          )}
        </div>
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
  const userId = useSession((s) => s.user?.id);
  const getDraftFlow = useMemoryDrafts((s) => s.getDraftFlow);
  const setDraftFlow = useMemoryDrafts((s) => s.setDraftFlow);
  const clearDraftFlow = useMemoryDrafts((s) => s.clearDraftFlow);
  const getAuthEpoch = useCallback(() => useMemoryDrafts.getState().authEpoch, []);
  const epochAtMount = useRef(getAuthEpoch());

  const profileId = props.profile.id;

  // Restore persisted state from memory (survives route navigation).
  const [draftJson, setDraftJson] = useState(
    () => getDraftFlow(userId, profileId)?.draftJson ?? '',
  );
  const [phrase, setPhrase] = useState<string | null>(
    () => getDraftFlow(userId, profileId)?.phrase ?? null,
  );
  const [draftId, setDraftId] = useState<string | null>(
    () => getDraftFlow(userId, profileId)?.draftId ?? null,
  );
  const [confirm, setConfirm] = useState(() => getDraftFlow(userId, profileId)?.confirm ?? '');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Persist to memory on every relevant change.
  useEffect(() => {
    if (getAuthEpoch() !== epochAtMount.current || useSession.getState().user?.id !== userId)
      return;
    setDraftFlow(userId, profileId, { draftId, phrase, confirm, draftJson });
  }, [draftId, phrase, confirm, draftJson, setDraftFlow, userId, profileId]);

  // Warn before unload when a pending draft or unsubmitted draftJson exists.
  const hasPending = draftId !== null || draftJson.trim().length > 0;
  useEffect(() => {
    if (!hasPending) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasPending]);

  // Clear memory on unmount only if no pending draft (i.e. after successful publish).
  // We persist intentionally on ordinary unmount so state survives navigation.

  const createDraft = async () => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const epochAtCall = getAuthEpoch();
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
      if (getAuthEpoch() !== epochAtCall) return;
      setDraftJson(body);
      setDraftId(res.draftId);
      setPhrase(res.confirmationPhrase);
      setConfirm('');
    } catch (err) {
      if (getAuthEpoch() !== epochAtCall) return;
      // TypeError (network failure) surfaces the same as ApiError — do not silently swallow.
      setError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'draft failed',
      );
    } finally {
      if (getAuthEpoch() === epochAtCall) setBusy(false);
    }
  };

  const confirmPublish = async () => {
    if (draftId === null || busy) return;
    setBusy(true);
    setError(null);
    const epochAtCall = getAuthEpoch();
    try {
      await api.post(`/drafts/${draftId}/confirm`, { phrase: confirm });
      if (getAuthEpoch() !== epochAtCall) return;
      setDraftId(null);
      setPhrase(null);
      setConfirm('');
      setDraftJson('');
      clearDraftFlow(userId, profileId);
      props.onPublished();
    } catch (err) {
      if (getAuthEpoch() !== epochAtCall) return;
      if (err instanceof ApiError) {
        setError(err.message);
        // A mismatched phrase (400) aborts the draft — restart the flow.
        // All other API errors retain the unconfirmed draftId/phrase/confirm.
        if (err.status === 400) {
          setDraftId(null);
          setPhrase(null);
          setConfirm('');
          // draftJson is preserved so the user can recreate without retyping.
        }
        // For non-400 ApiErrors we intentionally do NOT reset draftId/phrase/confirm.
      } else {
        // Network TypeError or other unexpected error — show message, retain all state.
        setError(
          'Publish status unconfirmed. Your draft and confirmation are retained. Check the profile before trying again.',
        );
      }
    } finally {
      if (getAuthEpoch() === epochAtCall) setBusy(false);
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
            {busy ? 'Creating…' : 'Stage 1: Create draft'}
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
            {busy ? 'Publishing…' : 'Stage 2: Publish'}
          </button>
        </div>
      )}
      {error !== null && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
