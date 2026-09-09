/**
 * Workspaces: RBAC list (auto-filtered server-side), create, rename, delete.
 * Home workspaces are marked and undeletable — the API rejects with 403 and
 * the UI explains why instead of showing a dead button.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Workspace } from '../api.js';
import { ConfirmAction } from '../components/Design.js';

export function WorkspacesPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const { workspaces: list } = await api.get<{ workspaces: Workspace[] }>('/workspaces');
      setWorkspaces(list);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void reload().catch(() => setError('Could not load workspaces. Please try again.'));
  }, [reload]);

  const create = async () => {
    if (busy || !displayName.trim()) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await api.post('/workspaces', { displayName: displayName.trim() });
      setDisplayName('');
      await reload();
      setQuery('');
      setNotice('Workspace created.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'create failed');
    } finally {
      setBusy(false);
    }
  };

  const rename = async (id: string) => {
    if (busy || !renameValue.trim()) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await api.patch(`/workspaces/${id}`, { displayName: renameValue.trim() });
      setRenaming(null);
      await reload();
      setNotice('Workspace renamed.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'rename failed');
    } finally {
      setBusy(false);
    }
  };

  const remove = async (ws: Workspace) => {
    if (ws.isHome || busy) return;
    setBusy(true);
    setNotice(null);
    setError(null);
    try {
      await api.delete(`/workspaces/${ws.id}`);
      await reload();
      setNotice('Workspace deleted.');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'delete failed');
      throw err;
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="content-page space-y-4">
      <h1>A place for every pursuit.</h1>
      <p className="text-sm text-slate-500">
        Keep conversations and scheduled work organized in their own spaces.
      </p>
      <div className="workspace-toolbar">
        <input
          type="search"
          aria-label="Find workspaces"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Find a workspace…"
        />
        <span className="session-help">{workspaces.length} workspaces</span>
      </div>
      {error !== null && (
        <p role="alert" className="text-sm text-red-600">
          {error}{' '}
          <button
            disabled={busy}
            className="underline"
            onClick={() => {
              setError(null);
              void reload().catch(() =>
                setError('Could not load workspaces. Please try again.'),
              );
            }}
          >
            Retry
          </button>
        </p>
      )}
      {notice && (
        <p role="status" className="text-sm text-emerald-700">
          {notice}
        </p>
      )}
      {loading && (
        <p role="status" className="session-help">
          Loading workspaces…
        </p>
      )}
      <div className="workspace-list">
        {workspaces
          .filter((ws) => ws.displayName.toLowerCase().includes(query.trim().toLowerCase()))
          .map((ws) => (
            <div
              key={ws.id}
              className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3"
            >
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
                      aria-label="Rename workspace"
                      maxLength={120}
                      disabled={busy}
                      onChange={(e) => setRenameValue(e.target.value)}
                      className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
                    />
                    <button
                      type="submit"
                      disabled={busy || !renameValue.trim()}
                      className="rounded-md bg-slate-900 px-2 py-1 text-xs text-white"
                    >
                      Save
                    </button>
                    <button
                      onClick={() => setRenaming(null)}
                      type="button"
                      disabled={busy}
                      className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                    >
                      Cancel
                    </button>
                  </form>
                ) : (
                  <>
                    <div className="truncate text-sm font-medium">
                      {ws.displayName}
                      {ws.isHome && (
                        <span className="ml-2 rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-600">
                          Home — cannot be deleted
                        </span>
                      )}
                    </div>
                    <div className="truncate text-xs text-slate-400">
                      {ws.folder} · created {new Date(ws.createdAt).toLocaleDateString()}
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
                    disabled={ws.isHome || busy}
                    title={ws.isHome ? 'Rename not offered for Home' : undefined}
                    className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-40"
                  >
                    Rename
                  </button>
                  <ConfirmAction
                    title={`Delete ${ws.displayName}?`}
                    onConfirm={() => remove(ws)}
                    disabled={ws.isHome || busy}
                    className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-40"
                  >
                    This workspace will be removed. Home workspaces are protected.
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
            {query ? 'No matching workspaces.' : 'Create your first workspace below.'}
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
          aria-label="New workspace name"
          maxLength={120}
          disabled={busy}
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="New workspace name"
          className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <button
          type="submit"
          disabled={busy || displayName.trim().length === 0}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          Create workspace
        </button>
      </form>
    </div>
  );
}
