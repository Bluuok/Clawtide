/**
 * Tasks: per-workspace list, create (cron/interval/once × group/isolated),
 * pause/resume/delete, run-now (202 + runId, idempotent), and the runs
 * history of the selected task.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Task, type TaskRun, type Workspace } from '../api.js';
import { ConfirmAction, EmptyState } from '../components/Design.js';

export function TasksPage() {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [workspaceId, setWorkspaceId] = useState<string>('');
  const [tasks, setTasks] = useState<Task[]>([]);
  const [selected, setSelected] = useState<Task | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState('all');
  const requestId = useRef(0);
  const visibleTasks = tasks.filter(
    (t) =>
      (filter === 'all' || t.status === filter) &&
      t.prompt.toLowerCase().includes(query.toLowerCase().trim()),
  );

  useEffect(() => {
    void (async () => {
      const { workspaces: ws } = await api.get<{ workspaces: Workspace[] }>('/workspaces');
      setWorkspaces(ws);
      if (ws.length > 0) setWorkspaceId((prev) => prev || ws[0]!.id);
    })().catch(() => {
      setError('Could not load workspaces. Please refresh to retry.');
      setLoading(false);
    });
  }, []);

  const reload = useCallback(async () => {
    if (workspaceId === '') {
      setLoading(false);
      return;
    }
    const request = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const { tasks: list } = await api.get<{ tasks: Task[] }>(
        `/tasks?workspaceId=${encodeURIComponent(workspaceId)}`,
      );
      if (request !== requestId.current) return;
      setTasks(list);
      setSelected((prev) =>
        prev === null ? null : (list.find((t) => t.id === prev.id) ?? null),
      );
    } catch (err) {
      if (request === requestId.current)
        setError(err instanceof ApiError ? err.message : 'Could not load tasks.');
    } finally {
      if (request === requestId.current) setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'action failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="split-page tasks-page">
      <div className="list-panel tasks-sidebar">
        <div className="task-filters">
          <span className="eyebrow">Scheduled work</span>
          <select
            value={workspaceId}
            aria-label="Task workspace"
            disabled={busy}
            onChange={(e) => {
              requestId.current++;
              setTasks([]);
              setSelected(null);
              setWorkspaceId(e.target.value);
            }}
            className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm"
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.displayName}
              </option>
            ))}
          </select>
          <input
            type="search"
            aria-label="Find tasks"
            placeholder="Find a task…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            aria-label="Filter tasks by status"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All tasks</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
          </select>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && (
            <p className="session-help" role="status">
              Loading tasks…
            </p>
          )}
          {visibleTasks.map((t) => (
            <button
              key={t.id}
              onClick={() => setSelected(t)}
              aria-pressed={selected?.id === t.id}
              disabled={busy}
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
          {!loading && visibleTasks.length === 0 && (
            <div className="p-4 text-center text-sm text-slate-400">
              {tasks.length === 0
                ? 'No tasks in this workspace.'
                : 'No tasks match your filters.'}
            </div>
          )}
        </div>
        <div className="border-t border-slate-200 p-2">
          <NewTaskButton
            key={workspaceId}
            workspaceId={workspaceId}
            onCreated={(task) => {
              setTasks((prev) => [...prev, task]);
              setSelected(task);
              setQuery('');
              setFilter('all');
            }}
          />
        </div>
      </div>
      <div className="detail-panel">
        {error !== null && (
          <p role="alert" className="mb-3 text-sm text-red-600">
            {error}{' '}
            <button className="underline" onClick={() => void reload()}>
              Retry
            </button>
          </p>
        )}
        {selected !== null ? (
          <TaskDetail
            key={selected.id}
            task={selected}
            onAct={act}
            busy={busy}
            onDelete={async () => {
              await api.delete(`/tasks/${selected.id}`);
              await reload();
            }}
          />
        ) : (
          <EmptyState title="Give good work a rhythm." art="stones">
            Select a task to see its schedule and run history, or create something new.
          </EmptyState>
        )}
      </div>
    </div>
  );
}

function NewTaskButton(props: { workspaceId: string; onCreated: (task: Task) => void }) {
  const [open, setOpen] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [prompt, setPrompt] = useState('');
  const [scheduleType, setScheduleType] = useState<'cron' | 'interval' | 'once'>('interval');
  const [cronExpr, setCronExpr] = useState('0 9 * * *');
  const [intervalSeconds, setIntervalSeconds] = useState(3600);
  const [runAt, setRunAt] = useState('');
  const [contextMode, setContextMode] = useState<'group' | 'isolated'>('isolated');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) dialog.current?.showModal();
    else dialog.current?.close();
  }, [open]);

  const create = async () => {
    if (busy) return;
    setError(null);
    if (!prompt.trim()) {
      setError('Describe what this task should do.');
      return;
    }
    if (
      scheduleType === 'interval' &&
      (!Number.isInteger(intervalSeconds) || intervalSeconds < 60)
    ) {
      setError('Choose an interval of at least 60 whole seconds.');
      return;
    }
    if (scheduleType === 'cron' && ![5, 6].includes(cronExpr.trim().split(/\s+/).length)) {
      setError('Enter a cron expression with 5 or 6 fields.');
      return;
    }
    if (
      scheduleType === 'once' &&
      (!runAt ||
        !Number.isFinite(new Date(runAt).getTime()) ||
        new Date(runAt).getTime() <= Date.now())
    ) {
      setError('Choose a date and time in the future.');
      return;
    }
    setBusy(true);
    try {
      const { task } = await api.post<{ task: Task }>('/tasks', {
        workspaceId: props.workspaceId,
        prompt: prompt.trim(),
        scheduleType,
        ...(scheduleType === 'cron' ? { cronExpr } : {}),
        ...(scheduleType === 'interval' ? { intervalSeconds } : {}),
        ...(scheduleType === 'once' ? { runAt: new Date(runAt).toISOString() } : {}),
        contextMode,
      });
      setOpen(false);
      setPrompt('');
      props.onCreated(task);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'create failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        onClick={() => {
          setError(null);
          setOpen(true);
        }}
        disabled={props.workspaceId === ''}
        className="w-full rounded-md bg-slate-900 px-3 py-2 text-sm text-white disabled:opacity-50"
      >
        + New task
      </button>
      <dialog
        ref={dialog}
        className="task-dialog"
        aria-labelledby="new-task-heading"
        onCancel={(e) => {
          if (busy) e.preventDefault();
          else setOpen(false);
        }}
        onClose={() => setOpen(false)}
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <span className="eyebrow">Make progress a habit</span>
          <h2 id="new-task-heading">Create a task.</h2>
          <p className="session-help">Describe the work and choose when it should happen.</p>
          <fieldset disabled={busy} className="task-fields">
            <label htmlFor="task-prompt">What should your worker do?</label>
            <textarea
              id="task-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="Prompt to execute"
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
            <div className="flex gap-2">
              <select
                aria-label="Schedule type"
                value={scheduleType}
                onChange={(e) => {
                  setScheduleType(e.target.value as typeof scheduleType);
                  setError(null);
                }}
                className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-xs"
              >
                <option value="interval">Repeat at an interval</option>
                <option value="cron">Cron schedule (UTC)</option>
                <option value="once">Run once</option>
              </select>
              <select
                aria-label="Task context"
                value={contextMode}
                onChange={(e) => setContextMode(e.target.value as typeof contextMode)}
                className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-xs"
              >
                <option value="isolated">Fresh context</option>
                <option value="group">Workspace context</option>
              </select>
            </div>
            <p className="session-help">
              {contextMode === 'isolated'
                ? 'Each run starts with a fresh conversation.'
                : 'Runs use the workspace conversation context.'}
            </p>
            {scheduleType === 'cron' && (
              <input
                aria-label="Cron expression (UTC)"
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
              <label>
                Run at (your local time)
                <input
                  type="datetime-local"
                  value={runAt}
                  onChange={(e) => setRunAt(e.target.value)}
                  className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-xs"
                />
              </label>
            )}
            {scheduleType === 'cron' && (
              <p className="session-help">
                Cron uses UTC. Example: 0 9 * * * runs daily at 09:00 UTC.
              </p>
            )}
          </fieldset>
          {error !== null && (
            <p role="alert" className="text-sm text-red-600">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <button
              type="submit"
              disabled={busy || prompt.trim().length === 0}
              className="flex-1 rounded-md bg-slate-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-slate-800 disabled:opacity-50"
            >
              {busy ? 'Creating…' : 'Create'}
            </button>
            <button
              onClick={() => setOpen(false)}
              type="button"
              disabled={busy}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-100"
            >
              Cancel
            </button>
          </div>
        </form>
      </dialog>
    </>
  );
}

function TaskDetail(props: {
  task: Task;
  onAct: (fn: () => Promise<unknown>) => Promise<void>;
  busy: boolean;
  onDelete: () => Promise<void>;
}) {
  const t = props.task;
  const [runs, setRuns] = useState<TaskRun[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [runsError, setRunsError] = useState(false);

  const loadRuns = useCallback(async () => {
    setRunsError(false);
    try {
      const { runs: r } = await api.get<{ runs: TaskRun[] }>(`/tasks/${t.id}`);
      setRuns(r);
    } catch {
      setRunsError(true);
    }
  }, [t.id]);

  useEffect(() => {
    setRuns(null);
    setNotice(null);
    void loadRuns();
  }, [loadRuns]);

  return (
    <div className="content-page space-y-4">
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-2 flex items-center justify-between">
          <h2 className="task-title">{t.prompt}</h2>
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
                  : t.runAt
                    ? new Date(t.runAt).toLocaleString()
                    : '—'}
              {t.scheduleType === 'cron'
                ? ' UTC'
                : t.scheduleType === 'once'
                  ? ' local time'
                  : ''}
              )
            </dd>
          </div>
          <div>
            <dt className="inline font-medium">context: </dt>
            <dd className="inline">{t.contextMode}</dd>
          </div>
          <div className="col-span-2">
            <dt className="inline font-medium">created: </dt>
            <dd className="inline">{new Date(t.createdAt).toLocaleString()}</dd>
          </div>
        </dl>
        <div className="mt-3 flex flex-wrap gap-2">
          {t.status === 'active' ? (
            <button
              disabled={props.busy}
              onClick={() => void props.onAct(() => api.post(`/tasks/${t.id}/pause`))}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
            >
              Pause
            </button>
          ) : (
            <button
              disabled={props.busy}
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
                    setNotice(
                      res.queued ? `Queued (run ${res.runId ?? ''})` : 'Task not active',
                    );
                  }),
              )
            }
            disabled={props.busy || t.status !== 'active'}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            Run now
          </button>
          <ConfirmAction
            title="Delete this task?"
            onConfirm={props.onDelete}
            disabled={props.busy}
            className="rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
          >
            This task will be removed. This action cannot be undone.
          </ConfirmAction>
          <button
            onClick={() => void loadRuns()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
          >
            Refresh runs
          </button>
        </div>
        {notice && (
          <p role="status" className="mt-3 text-sm text-slate-600">
            {notice}
          </p>
        )}
      </div>
      <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white p-4">
        <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
          Runs history
        </div>
        {runsError ? (
          <p role="alert" className="text-sm text-red-700">
            Could not load run history.{' '}
            <button className="underline" onClick={() => void loadRuns()}>
              Retry history
            </button>
          </p>
        ) : runs === null ? (
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
                  <td className="py-1.5 pr-2 text-xs text-slate-500">
                    {new Date(r.availableAt).toLocaleString()}
                  </td>
                  <td className="py-1.5 pr-2 text-xs text-slate-500">
                    {r.finishedAt ? new Date(r.finishedAt).toLocaleString() : '—'}
                  </td>
                  <td className="break-words py-1.5 text-xs text-slate-600">
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
