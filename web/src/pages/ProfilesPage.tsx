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
    label: '身份',
    description: '设定数字员工的身份、职责和自我介绍。',
  },
  {
    key: 'soul',
    label: '价值观',
    description: '描述它的原则、语气和行为边界。',
  },
  {
    key: 'agents',
    label: '工作规则',
    description: '设定优先级、协作习惯和工作方式。',
  },
  {
    key: 'tools',
    label: '工具',
    description: '说明何时以及如何使用可用工具。',
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
      setError('无法加载数字员工，请重试。');
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
          我的数字员工 <span className="session-count">{profiles.length}</span>
        </span>
        <span>{sidebar.open ? '收起 −' : '浏览 +'}</span>
      </button>
      {sidebar.open && (
        <button
          type="button"
          className="sidebar-backdrop"
          aria-label="关闭数字员工列表"
          onClick={() => sidebar.close()}
        />
      )}
      <div ref={sidebar.panelRef} className="list-panel profiles-sidebar" id="profiles-sidebar">
        <div className="task-filters">
          <span className="eyebrow">我的数字员工</span>
          <input
            ref={sidebar.primaryFocusRef as React.RefObject<HTMLInputElement | null>}
            type="search"
            aria-label="搜索数字员工"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索数字员工…"
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
                  editing && p.id !== activeId ? '切换数字员工前，请先保存或放弃更改。' : p.name
                }
                className={`block w-full px-3 py-2 text-left text-sm ${
                  p.id === activeId ? 'bg-slate-100 font-medium' : 'hover:bg-slate-50'
                }`}
              >
                {p.name}
                {p.isDefault && <span className="ml-1 text-xs text-emerald-600">默认</span>}
                <span className="block text-xs text-slate-400">
                  v{p.version} · {p.promptMode === 'append' ? '追加' : '替换'}
                </span>
              </button>
            ))}
          {!loading &&
            profiles.filter((p) => p.name.toLowerCase().includes(query.toLowerCase().trim()))
              .length === 0 && (
              <p className="session-help">
                {query ? '没有匹配的数字员工。' : '在下方创建你的第一个数字员工。'}
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
            重试
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
          正在加载数字员工…
        </div>
      ) : (
        <div className="empty-action">
          <EmptyState title="打造你的数字员工。" art="linen">
            创建数字员工，定义身份、价值观、工作规则和工具。
          </EmptyState>
          <button
            className="min-h-11 rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white"
            onClick={() => sidebar.openAndFocus(newProfileRef.current)}
          >
            创建数字员工
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
      setError(err instanceof ApiError ? err.message : '创建数字员工失败。');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <input
        ref={inputRef}
        aria-label="新数字员工名称"
        placeholder="给数字员工起个名字"
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
        {busy ? '创建中…' : '+ 新建数字员工'}
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
          `数字员工已在其他位置更新到 v${p.version}。` +
            `你的草稿仍基于 v${baseVersion}。` +
            '放弃当前草稿即可加载最新版本。',
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
      setError(err instanceof ApiError ? err.message : '保存失败');
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
      setDefaultError(err instanceof ApiError ? err.message : '设置默认数字员工失败。');
    } finally {
      if (getAuthEpoch() === epochAtCall) setDefaultBusy(false);
    }
  };

  return (
    <div className="detail-panel profile-detail">
      <div className="content-page space-y-4">
        <div className="profile-intro">
          <ArtImage kind="linen" className="profile-art" />
          <span className="eyebrow">数字员工 / 版本 {p.version}</span>
          <h2>赋予数字员工鲜明的个性。</h2>
          <p>用四项设定，形成一致的工作方式。</p>
        </div>
        <div className="editor-toolbar profile-toolbar">
          <input
            value={name}
            aria-label="数字员工名称"
            disabled={busy}
            onChange={(e) => {
              setName(e.target.value);
            }}
            className="flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm font-medium"
          />
          <select
            value={mode}
            aria-label="提示词模式"
            disabled={busy}
            onChange={(e) => {
              setMode(e.target.value as 'append' | 'replace');
            }}
            className="rounded-md border border-slate-300 px-2 py-2 text-sm"
          >
            <option value="append">追加</option>
            <option value="replace">替换</option>
          </select>
          <button
            onClick={() => void save()}
            disabled={!dirty || busy || !name.trim()}
            className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? '保存中…' : '保存为新版本'}
          </button>
          <button
            onClick={discard}
            disabled={!dirty || busy}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-50"
          >
            放弃更改
          </button>
        </div>
        <p className={`profile-save-state ${dirty ? 'is-dirty' : ''}`} role="status">
          {dirty
            ? '有未保存的更改，请先保存或放弃后再切换。'
            : saved
              ? '已保存为新版本。'
              : '所有更改已保存。'}
        </p>
        <p className="session-help">
          {mode === 'append'
            ? '追加模式：在基础设定后添加这些指令。'
            : '替换模式：替换可编辑的基础指令，平台规则仍然生效。'}
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
            <span className="text-sm text-emerald-700 font-medium">✓ 当前默认数字员工</span>
          ) : (
            <>
              <button
                onClick={() => void setAsDefault()}
                disabled={defaultBusy}
                className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50"
              >
                {defaultBusy ? '设置中…' : '设为默认'}
              </button>
              {defaultError !== null && (
                <span className="text-sm text-red-600">{defaultError}</span>
              )}
            </>
          )}
        </div>
        <div className="profile-sections" aria-label="数字员工设置分区">
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
              {segs[s.key].length.toLocaleString()} 字 · {s.key.toUpperCase()}
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
          <summary>高级：发布草稿</summary>
          <fieldset disabled={dirty || busy}>
            <DraftFlow key={p.id} profile={p} onPublished={() => void props.onReload()} />
          </fieldset>
          {dirty && <p className="session-help">发布草稿前，请先保存或放弃更改。</p>}
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
      setError('无法加载版本历史，请重试。');
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
      setError('恢复此版本失败，请重试。');
    } finally {
      setBusyVersion(null);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">
          版本历史
        </span>
        <button
          disabled={loading}
          onClick={() => void load()}
          className="text-xs text-slate-600 underline"
        >
          {loading ? '加载中…' : versions === null ? '查看历史' : '刷新历史'}
        </button>
      </div>
      <p className="session-help">恢复时会保留现有版本，并创建一个新版本。</p>
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
                恢复
              </button>
            </li>
          ))}
          {versions.length === 0 && <li className="text-slate-400">暂无版本历史。</li>}
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
            : '创建草稿失败',
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
        setError('发布状态未确认，草稿和确认短语已保留。请检查数字员工设置后再重试。');
      }
    } finally {
      if (getAuthEpoch() === epochAtCall) setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-4">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
        分两步发布 AI 草稿（创建草稿 → 输入确认短语 → 发布）
      </div>
      {draftId === null ? (
        <div className="space-y-2">
          <textarea
            value={draftJson}
            onChange={(e) => setDraftJson(e.target.value)}
            rows={5}
            placeholder={
              '可选的草稿 JSON，留空则使用当前数字员工设置：\n{"name": …, "identity": …, "soul": …, "agents": …, "tools": …, "promptMode": "append"|"replace"}'
            }
            className="w-full resize-y rounded-md border border-slate-300 px-3 py-2 font-mono text-xs"
          />
          <button
            onClick={() => void createDraft()}
            disabled={busy}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50"
          >
            {busy ? '创建中…' : '第一步：创建草稿'}
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          <div className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">
            草稿已创建，确认短语： <span className="font-mono font-semibold">{phrase}</span>
            <span className="block text-xs text-amber-700">
              请完整输入确认短语后发布，输入不一致将终止草稿。
            </span>
          </div>
          <input
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder="输入确认短语"
            className="w-full rounded-md border border-slate-300 px-3 py-2 font-mono text-sm"
          />
          <button
            onClick={() => void confirmPublish()}
            disabled={busy || confirm.length === 0}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            {busy ? '发布中…' : '第二步：发布'}
          </button>
        </div>
      )}
      {error !== null && <p className="mt-2 text-sm text-red-600">{error}</p>}
    </div>
  );
}
