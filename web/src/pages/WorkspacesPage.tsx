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

  const reload = useCallback(async () => {
    const { workspaces: list } = await api.get<{ workspaces: Workspace[] }>('/workspaces');
    setWorkspaces(list);
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  const create = async () => {
    setError(null);
    try {
      await api.post('/workspaces', { displayName });
      setDisplayName('');
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'create failed');
    }
  };

  const rename = async (id: string) => {
    setError(null);
    try {
      await api.patch(`/workspaces/${id}`, { displayName: renameValue });
      setRenaming(null);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'rename failed');
    }
  };

  const remove = async (ws: Workspace) => {
    if (ws.isHome) return;
    setError(null);
    try {
      await api.delete(`/workspaces/${ws.id}`);
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'delete failed');
    }
  };

  return (
    <div className="content-page space-y-4">
      <h1>A place for every pursuit.</h1>
      <p className="text-sm text-slate-500">
        Keep conversations and scheduled work organized in their own spaces.
      </p>
      {error !== null && <p className="text-sm text-red-600">{error}</p>}
      <div className="workspace-list">
        {workspaces.map((ws) => (
          <div
            key={ws.id}
            className="flex items-center gap-3 rounded-lg border border-slate-200 bg-white p-3"
          >
            <div className="min-w-0 flex-1">
              {renaming === ws.id ? (
                <div className="flex gap-2">
                  <input
                    value={renameValue}
                    onChange={(e) => setRenameValue(e.target.value)}
                    className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
                  />
                  <button
                    onClick={() => void rename(ws.id)}
                    className="rounded-md bg-slate-900 px-2 py-1 text-xs text-white"
                  >
                    Save
                  </button>
                  <button
                    onClick={() => setRenaming(null)}
                    className="rounded-md border border-slate-300 px-2 py-1 text-xs"
                  >
                    Cancel
                  </button>
                </div>
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
                    {ws.folder} · created {ws.createdAt}
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
                  disabled={ws.isHome}
                  title={ws.isHome ? 'Rename not offered for Home' : undefined}
                  className="rounded-md border border-slate-300 px-2 py-1 text-xs hover:bg-slate-100 disabled:opacity-40"
                >
                  Rename
                </button>
                <ConfirmAction
                  title={`Delete ${ws.displayName}?`}
                  onConfirm={() => remove(ws)}
                  disabled={ws.isHome}
                  className="rounded-md border border-red-200 px-2 py-1 text-xs text-red-700 hover:bg-red-50 disabled:opacity-40"
                >
                  This workspace will be removed. Home workspaces are protected.
                </ConfirmAction>
              </div>
            )}
          </div>
        ))}
      </div>
      <div className="flex gap-2">
        <input
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          placeholder="New workspace name"
          className="min-w-0 flex-1 rounded-md border border-slate-300 px-3 py-2 text-sm"
        />
        <button
          onClick={() => void create()}
          disabled={displayName.trim().length === 0}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          Create workspace
        </button>
      </div>
    </div>
  );
}
