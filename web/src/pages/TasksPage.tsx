/**
 * Tasks: per-workspace list, create (cron/interval/once × group/isolated),
 * pause/resume/delete, run-now (202 + runId, idempotent), and the runs
 * history of the selected task.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, ApiError, type Task, type TaskRun, type Workspace } from '../api.js';

export function TasksPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      const { workspaces: ws } = await api.get<{ workspaces: Workspace[] }>('/workspaces');
      setWorkspaces(ws);
      if (ws.length > 0) setWorkspaceId((prev) => prev || ws[0]!.id);
    })();
  }, []);

  const reload = useCallback(async () => {
    if (workspaceId === '') return;
    setError(null);
    try {
      const { tasks: list } = await api.get<{ tasks: Task[] }>(
        `/tasks?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      setTasks(list);
      setSelected((prev) =>
        prev === null ? null : (list.find((t) => t.id === prev.id) ?? null),
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'load failed');
    }
  }, [workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'action failed');
    }
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-96 flex-col border-r border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-200 px-3 py-2">
          <select
            value={workspaceId}
            onChange={(e) => setWorkspaceId(e.target.value)}
            className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.displayName}
              </option>
            ))}
          </select>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {tasks.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelected(t)}
              className={`block w-full px-3 py-2 text-left text-sm ${
                selected?.id === t.id ? 'bg-slate-100 font-medium' : 'hover:bg-slate-50'
              }`}
            >
              <span className="block truncate">{t.prompt}</span>
              <span className="block text-xs text-slate-400">
                {t.scheduleType} · {t.contextMode} ·{' '}
                <span className={t.status === 'active' ? 'text-emerald-600' : 'text-amber-600'}>
                  {t.status}
                </span>
              </span>
            </button>
          ))}
          {tasks.length === 0 && (
            <div className="p-4 text-center text-sm text-slate-400">
              No tasks in this workspace.
            </div>
          )}
        </div>
        <div className="border-t border-slate-200 p-2">
          <NewTaskButton workspaceId={workspaceId} onCreated={() => void reload()} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-6">
        {error !== null && <p className="mb-3 text-sm text-red-600">{error}</p>}
        {selected !== null ? (
          <TaskDetail task={selected} onAct={act} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-slate-500">
            Select a task to see details and run history.
          </div>
        )}
      </div>
    </div>
  );
}

function NewTaskButton(props: { workspaceId: string; onCreated: () => void }) {
  const [open, setOpen] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [scheduleType, setScheduleType] = useState<'cron' | 'interval' | 'once'>('interval');
  const [cronExpr, setCronExpr] = useState('0 9 * * *');
  const [intervalSeconds, setIntervalSeconds] = useState(3600);
  const [runAt, setRunAt] = useState('');
  const [contextMode, setContextMode] = useState<'group' | 'isolated'>('isolated');
  const [error, setError] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        disabled={props.workspaceId === ''}
        className="w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100 disabled:opacity-50"
      >
        + New task
      </button>
    );
  }

  const create = async () => {
    setError(null);
    try {
      await api.post('/tasks', {
        workspaceId: props.workspaceId,
        prompt,
        scheduleType,
        ...(scheduleType === 'cron' ? { cronExpr } : {}),
        ...(scheduleType === 'interval' ? { intervalSeconds } : {}),
        ...(scheduleType === 'once' ? { runAt: new Date(runAt).toISOString() } : {}),
        contextMode,
      });
      setOpen(false);
      setPrompt('');
      props.onCreated();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'create failed');
    }
  };

  return (
    <div className="space-y-2 rounded-md border border-slate-200 bg-slate-50 p-2">
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        rows={2}
        placeholder="Prompt to execute"
        className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
      />
      <div className="flex gap-2">
        <select
          value={scheduleType}
          onChange={(e) => setScheduleType(e.target.value as typeof scheduleType)}
          className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-xs"
        >
          <option value="interval">interval</option>
          <option value="cron">cron</option>
          <option value="once">once</option>
        </select>
        <select
          value={contextMode}
          onChange={(e) => setContextMode(e.target.value as typeof contextMode)}
          className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-xs"
        >
          <option value="isolated">isolated</option>
          <option value="group">group</option>
        </select>
      </div>
      {scheduleType === 'cron' && (
        <input
          value={cronExpr}
          onChange={(e) => setCronExpr(e.target.value)}
          placeholder="cron expression (UTC)"
          className="w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-xs"
        />
      )}
      {scheduleType === 'interval' && (
        <label className="block text-xs text-slate-600">
          Interval seconds (≥ 60)
          <input
            type="number"
            min={60}
            value={intervalSeconds}
            onChange={(e) => setIntervalSeconds(Number(e.target.value))}
            className="mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
          />
        </label>
      )}
      {scheduleType === 'once' && (
        <input
          type="datetime-local"
          value={runAt}
          onChange={(e) => setRunAt(e.target.value)}
          className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
        />
      )}
      {error !== null && <p className="text-xs text-red-600">{error}</p>}
      <div className="flex gap-2">
        <button
          onClick={() => void create()}
          disabled={prompt.trim().length === 0}
          className="flex-1 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
        >
          Create
        </button>
        <button
          onClick={() => setOpen(false)}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-100"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

function TaskDetail(props: {
  task: Task;
  onAct: (fn: () => Promise<unknown>) => Promise<void>;
}) {
  const t = props.task;
  const [runs, setRuns] = useState<TaskRun[] | null>(null);

  const loadRuns = useCallback(async () => {
    const { runs: r } = await api.get<{ runs: TaskRun[] }>(`/tasks/${t.id}`);
    setRuns(r);
  }, [t.id]);

  useEffect(() => {
    setRuns(null);
    void loadRuns();
  }, [loadRuns]);

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-semibold">{t.prompt}</h2>
          <span
            className={`rounded-full px-2 py-0.5 text-xs ${
              t.status === 'active'
                ? 'bg-emerald-100 text-emerald-800'
                : 'bg-amber-100 text-amber-800'
            }`}
          >
            {t.status}
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-slate-600">
          <div>
            <dt className="inline font-medium">schedule: </dt>
            <dd className="inline">
              {t.scheduleType} (
              {t.scheduleType === 'cron'
                ? t.cronExpr
                : t.scheduleType === 'interval'
                  ? `${t.intervalSeconds}s`
                  : t.runAt}
              )
            </dd>
          </div>
          <div>
            <dt className="inline font-medium">context: </dt>
            <dd className="inline">{t.contextMode}</dd>
          </div>
          <div className="col-span-2">
            <dt className="inline font-medium">created: </dt>
            <dd className="inline">{t.createdAt}</dd>
          </div>
        </dl>
        <div className="mt-3 flex flex-wrap gap-2">
          {t.status === 'active' ? (
            <button
              onClick={() => void props.onAct(() => api.post(`/tasks/${t.id}/pause`))}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
            >
              Pause
            </button>
          ) : (
            <button
              onClick={() => void props.onAct(() => api.post(`/tasks/${t.id}/resume`))}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
            >
              Resume
            </button>
          )}
          <button
            onClick={() =>
              void props.onAct(() =>
                api
                  .post<{ queued: boolean; runId?: string }>(`/tasks/${t.id}/run`)
                  .then((res) => {
                    window.alert(
                      res.queued ? `Queued (run ${res.runId ?? ''})` : 'Task not active',
                    );
                  }),
              )
            }
            disabled={t.status !== 'active'}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            Run now
          </button>
          <button
            onClick={() => {
              if (window.confirm('Delete this task?')) {
                void props.onAct(() => api.delete(`/tasks/${t.id}`));
              }
            }}
            className="rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
          >
            Delete
          </button>
          <button
            onClick={() => void loadRuns()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
          >
            Refresh runs
          </button>
        </div>
      </div>
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Runs history
        </div>
        {runs === null ? (
          <div className="text-sm text-slate-400">Loading…</div>
        ) : runs.length === 0 ? (
          <div className="text-sm text-slate-400">No runs yet.</div>
        ) : (
          <table className="w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
                <th className="py-1 pr-2">status</th>
                <th className="py-1 pr-2">attempt</th>
                <th className="py-1 pr-2">available</th>
                <th className="py-1 pr-2">finished</th>
                <th className="py-1">result / error</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 align-top">
                  <td className="py-1.5 pr-2">
                    <span
                      className={`rounded px-1.5 py-0.5 text-xs ${
                        r.status === 'success'
                          ? 'bg-emerald-100 text-emerald-800'
                          : r.status === 'failed'
                            ? 'bg-red-100 text-red-800'
                            : r.status === 'running'
                              ? 'bg-blue-100 text-blue-800'
                              : 'bg-slate-100 text-slate-700'
                      }`}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="py-1.5 pr-2">{r.attempt}</td>
                  <td className="py-1.5 pr-2 text-xs text-slate-500">{r.availableAt}</td>
                  <td className="py-1.5 pr-2 text-xs text-slate-500">{r.finishedAt ?? '—'}</td>
                  <td className="py-1.5 text-xs text-slate-600">
                    {r.error ?? r.result ?? '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
