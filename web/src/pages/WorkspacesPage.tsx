/**
 * Workspaces: RBAC list (auto-filtered server-side), create, rename, delete.
 * Home workspaces are marked and undeletable — the API rejects with 403 and
 * the UI explains why instead of showing a dead button.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Workspace } from '../api.js';
import { ArtImage, ConfirmAction } from '../components/Design.js';
import { WorkspaceLoadGuard } from '../stores/workspaceLoadGuard.js';

export function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [operationError, setOperationError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const busyRef = useRef(false);
  const loadingRef = useRef(false);
  const loadGuard = useRef(new WorkspaceLoadGuard());

  const reload = useCallback(async () => {
    if (busyRef.current || loadingRef.current) return;
    loadingRef.current = true;
    const loadToken = loadGuard.current.startLoad();
    setLoading(true);
    setLoadError(null);
    try {
      const { workspaces: list } = await api.get<{ workspaces: Workspace[] }>('/workspaces');
      if (loadGuard.current.isCurrent(loadToken)) setWorkspaces(list);
    } catch {
      if (loadGuard.current.isCurrent(loadToken)) {
        setLoadError('无法加载工作区，请重试。');
      }
    } finally {
      loadingRef.current = false;
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = async () => {
    if (busyRef.current || loadingRef.current || !displayName.trim()) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    setOperationError(null);
    try {
      const { workspace } = await api.post<{ workspace: Workspace }>('/workspaces', {
        displayName: displayName.trim(),
      });
      loadGuard.current.recordMutation();
      setWorkspaces((current) => [
        ...current.filter((item) => item.id !== workspace.id),
        workspace,
      ]);
      setDisplayName('');
      setQuery('');
      setNotice('工作区已创建。');
    } catch (err) {
      setOperationError(err instanceof ApiError ? err.message : '创建工作区失败。');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const rename = async (id: string) => {
    if (busyRef.current || loadingRef.current || !renameValue.trim()) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    setOperationError(null);
    try {
      const { workspace } = await api.patch<{ workspace: Workspace }>(`/workspaces/${id}`, {
        displayName: renameValue.trim(),
      });
      loadGuard.current.recordMutation();
      setWorkspaces((current) =>
        current.map((item) => (item.id === workspace.id ? workspace : item)),
      );
      setRenaming(null);
      setNotice('工作区已重命名。');
    } catch (err) {
      setOperationError(err instanceof ApiError ? err.message : '重命名工作区失败。');
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const remove = async (ws: Workspace) => {
    if (ws.isHome || busyRef.current || loadingRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setNotice(null);
    setOperationError(null);
    try {
      await api.delete(`/workspaces/${ws.id}`);
      loadGuard.current.recordMutation();
      setWorkspaces((current) => current.filter((item) => item.id !== ws.id));
      setNotice('工作区已删除。');
    } catch (err) {
      setOperationError(err instanceof ApiError ? err.message : '删除工作区失败。');
      throw err;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="content-page space-y-4">
      <h1>让每项工作各得其所。</h1>
      <p className="text-sm text-slate-500">用独立工作区整理会话和计划任务。</p>
      <div className="workspace-toolbar">
        <input
          type="search"
          aria-label="搜索工作区"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索工作区…"
        />
        <span className="session-help">{workspaces.length} 个工作区</span>
      </div>
      {loadError !== null && (
        <p role="alert" className="text-sm text-red-600">
          {loadError}{' '}
          <button disabled={loading} className="underline" onClick={() => void reload()}>
            {loading ? '重试中…' : '重试'}
          </button>
        </p>
      )}
      {operationError !== null && (
        <p role="alert" className="text-sm text-red-600">
          {operationError}
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-emerald-700">
          {notice}
        </p>
      )}
      {loading && (
        <p role="status" className="session-help">
          正在加载工作区…
        </p>
      )}
      <div className="workspace-list workspace-gallery">
        {workspaces
          .filter((ws) => ws.displayName.toLowerCase().includes(query.trim().toLowerCase()))
          .map((ws) => (
            <div key={ws.id} className="workspace-art-card">
              <ArtImage
                kind={
                  ws.isHome
                    ? 'coast'
                    : (['light', 'linen', 'stones'] as const)[
                        Array.from(ws.id).reduce(
                          (hash, char) => (hash * 31 + char.charCodeAt(0)) >>> 0,
                          0,
                        ) % 3
                      ]
                }
                className="workspace-cover"
              />
              <div className="min-w-0 flex-1">
                {renaming === ws.id ? (
                  <form
                    className="flex flex-wrap gap-2"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void rename(ws.id);
                    }}
                  >
                    <input
                      value={renameValue}
                      aria-label="重命名工作区"
                      maxLength={120}
                      disabled={busy || loading}
                      onChange={(e) => setRenameValue(e.target.value)}
                      className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
                    />
                    <button
                      type="submit"
                      disabled={busy || loading || !renameValue.trim()}
                      className="rounded-md bg-slate-900 px-2 py-1 text-xs text-white"
                    >
                      保存
                    </button>
                    <button
                      onClick={() => setRenaming(null)}
                      type="button"
                      disabled={busy || loading}
                      className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                    >
                      取消
                    </button>
                  </form>
                ) : (
                  <>
                    <div className="truncate text-sm font-medium">
                      {ws.displayName}
                      {ws.isHome && (
                        <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                          个人工作区，不可删除
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-slate-400">
                      {ws.folder} · 创建于 {new Date(ws.createdAt).toLocaleDateString()}
                    </div>
                  </>
                )}
              </div>
              {renaming !== ws.id && (
                <div className="flex shrink-0 gap-2">
                  <button
                    onClick={() => {
                      setRenaming(ws.id);
                      setRenameValue(ws.displayName);
                    }}
                    disabled={ws.isHome || busy || loading}
                    title={ws.isHome ? '个人工作区暂不支持重命名' : undefined}
                    className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-40"
                  >
                    重命名
                  </button>
                  <ConfirmAction
                    title={`删除“${ws.displayName}”？`}
                    onConfirm={() => remove(ws)}
                    disabled={ws.isHome || busy || loading}
                    className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-40"
                  >
                    此工作区将被删除，个人工作区不受影响。
                  </ConfirmAction>
                </div>
              )}
            </div>
          ))}
      </div>
      {!loading &&
        workspaces.filter((ws) =>
          ws.displayName.toLowerCase().includes(query.trim().toLowerCase()),
        ).length === 0 && (
          <p className="session-help">
            {query ? '没有匹配的工作区。' : '在下方创建你的第一个工作区。'}
          </p>
        )}
      <form
        className="workspace-create"
        onSubmit={(e) => {
          e.preventDefault();
          void create();
        }}
      >
        <input
          aria-label="新工作区名称"
          maxLength={120}
          disabled={busy || loading}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="新工作区名称"
          className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={busy || loading || displayName.trim().length === 0}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          创建工作区
        </button>
      </form>
    </div>
  );
}
