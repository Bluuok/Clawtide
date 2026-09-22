const taskLabels = {
  active: '已启用',
  paused: '已暂停',
  queued: '排队中',
  retry_wait: '等待重试',
  running: '执行中',
  success: '已完成',
  failed: '失败',
  missed: '已错过',
  cancelled: '已取消',
  cron: 'Cron 定时',
  interval: '间隔重复',
  once: '单次执行',
  isolated: '独立上下文',
  group: '工作区上下文',
};

/**
 * Tasks: per-workspace list, create (cron/interval/once × group/isolated),
 * pause/resume/delete, run-now (202 + runId, idempotent), and the runs
 * history of the selected task.
 *
 * PR3 – TaskDetail smart polling:
 *   • Run Now → GET /tasks/:id immediately, then controlled setTimeout loop
 *     that continues while any run is queued/retry_wait/running.
 *   • Coalesced manual + visibility-focus requests: a pending request absorbs
 *     duplicates; only one in-flight at a time.
 *   • Failures use bounded exponential back-off (cap 30 s).
 *   • Abort + ignore stale results on unmount or task switch (key={id}).
 *   • Missing runId after Run Now: up to MAX_MISSING_POLLS follow-up polls.
 *   • Last good runs preserved; stale-banner + last-update time shown.
 *   • Run cards (responsive) replace the five-column table.
 *   • result/error: capped 300-char preview, expand/collapse, Copy full.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, type Task, type TaskRun, type Workspace } from '../api.js';
import { ConfirmAction, EmptyState } from '../components/Design.js';
import { followTaskRuns } from '../stores/taskRuns.js';

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
  const [tasksLastUpdated, setTasksLastUpdated] = useState<Date | null>(null);
  const requestId = useRef(0);
  const reloadAbortRef = useRef<AbortController | null>(null);
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
      setError('无法加载工作区，请刷新重试。');
      setLoading(false);
    });
  }, []);

  const reload = useCallback(async () => {
    if (workspaceId === '') {
      setLoading(false);
      return;
    }
    const request = ++requestId.current;
    if (reloadAbortRef.current) {
      reloadAbortRef.current.abort();
    }
    const controller = new AbortController();
    reloadAbortRef.current = controller;

    setLoading(true);
    setError(null);
    try {
      const { tasks: list } = await api.get<{ tasks: Task[] }>(
        `/tasks?workspaceId=${encodeURIComponent(workspaceId)}`,
        { signal: controller.signal },
      );
      if (controller.signal.aborted || request !== requestId.current) return;
      setTasks(list);
      setTasksLastUpdated(new Date());
      setSelected((prev) =>
        prev === null ? null : (list.find((t) => t.id === prev.id) ?? null),
      );
    } catch (err) {
      if (controller.signal.aborted || request !== requestId.current) return;
      setError(err instanceof ApiError ? err.message : '无法加载任务。');
    } finally {
      if (!controller.signal.aborted && request === requestId.current) {
        setLoading(false);
      }
    }
  }, [workspaceId]);

  useEffect(() => {
    void reload();
    return () => {
      reloadAbortRef.current?.abort();
    };
  }, [reload]);

  const act = async (fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '操作失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="split-page tasks-page">
      <div className="list-panel tasks-sidebar">
        <div className="task-filters">
          <div className="flex items-center justify-between">
            <span className="eyebrow">计划任务</span>
            {tasksLastUpdated && (
              <span className="text-[10px] text-slate-400">
                更新于 {tasksLastUpdated.toLocaleTimeString()}
              </span>
            )}
          </div>
          <select
            value={workspaceId}
            aria-label="任务所属工作区"
            disabled={busy}
            onChange={(e) => {
              requestId.current++;
              reloadAbortRef.current?.abort();
              setTasks([]);
              setTasksLastUpdated(null);
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
            aria-label="搜索任务"
            placeholder="搜索任务…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <select
            aria-label="按状态筛选任务"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">全部任务</option>
            <option value="active">已启用</option>
            <option value="paused">已暂停</option>
          </select>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {loading && (
            <p className="session-help" role="status">
              正在加载任务…
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
                {taskLabels[t.scheduleType]} · {taskLabels[t.contextMode]} ·{' '}
                <span className={t.status === 'active' ? 'text-emerald-600' : 'text-amber-600'}>
                  {taskLabels[t.status]}
                </span>
              </span>
            </button>
          ))}
          {!loading && !error && visibleTasks.length === 0 && (
            <div className="p-4 text-center text-sm text-slate-400">
              {tasks.length === 0 ? '此工作区暂无任务。' : '没有符合筛选条件的任务。'}
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
          <div role="alert" className="mb-3 rounded-md bg-red-50 p-2 text-sm text-red-700">
            <div className="flex items-center justify-between">
              <span>{error}</span>
              <button
                className="font-medium underline hover:text-red-900"
                onClick={() => void reload()}
              >
                重试
              </button>
            </div>
            {tasksLastUpdated && (
              <p className="mt-1 text-xs text-red-600/80">
                当前显示的任务缓存时间为 {tasksLastUpdated.toLocaleTimeString()}.
              </p>
            )}
          </div>
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
          <div className={tasks.length === 0 ? 'tasks-empty-detail' : undefined}>
            <EmptyState title="让工作有条不紊。" art="stones">
              选择任务查看计划和执行历史，或创建一个新任务。
            </EmptyState>
          </div>
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
      setError('请描述任务需要完成的工作。');
      return;
    }
    if (
      scheduleType === 'interval' &&
      (!Number.isInteger(intervalSeconds) || intervalSeconds < 60)
    ) {
      setError('请输入至少 60 秒的整数间隔。');
      return;
    }
    if (scheduleType === 'cron' && ![5, 6].includes(cronExpr.trim().split(/\s+/).length)) {
      setError('请输入包含 5 或 6 个字段的 Cron 表达式。');
      return;
    }
    if (
      scheduleType === 'once' &&
      (!runAt ||
        !Number.isFinite(new Date(runAt).getTime()) ||
        new Date(runAt).getTime() <= Date.now())
    ) {
      setError('请选择未来的日期和时间。');
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
      setError(err instanceof ApiError ? err.message : '创建失败');
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
        + 新建任务
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
          <span className="eyebrow">让进步成为习惯</span>
          <h2 id="new-task-heading">创建任务。</h2>
          <p className="session-help">描述工作内容，并选择执行时间。</p>
          <fieldset disabled={busy} className="task-fields">
            <label htmlFor="task-prompt">你希望数字员工做什么？</label>
            <textarea
              id="task-prompt"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              placeholder="任务指令"
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
            <div className="flex gap-2">
              <select
                aria-label="执行计划"
                value={scheduleType}
                onChange={(e) => {
                  setScheduleType(e.target.value as typeof scheduleType);
                  setError(null);
                }}
                className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-xs"
              >
                <option value="interval">按间隔重复</option>
                <option value="cron">Cron 定时（UTC）</option>
                <option value="once">执行一次</option>
              </select>
              <select
                aria-label="会话上下文"
                value={contextMode}
                onChange={(e) => setContextMode(e.target.value as typeof contextMode)}
                className="min-w-0 flex-1 rounded-md border border-slate-300 px-2 py-1.5 text-xs"
              >
                <option value="isolated">独立上下文</option>
                <option value="group">工作区上下文</option>
              </select>
            </div>
            <p className="session-help">
              {contextMode === 'isolated'
                ? '每次执行都会开始一段新会话。'
                : '执行时使用工作区的会话上下文。'}
            </p>
            {scheduleType === 'cron' && (
              <input
                aria-label="Cron 表达式（UTC）"
                value={cronExpr}
                onChange={(e) => setCronExpr(e.target.value)}
                placeholder="Cron 表达式（UTC）"
                className="w-full rounded-md border border-slate-300 px-2 py-1.5 font-mono text-xs"
              />
            )}
            {scheduleType === 'interval' && (
              <label className="block text-xs text-slate-600">
                间隔秒数（≥ 60）
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
                执行时间（本地时间）
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
                Cron 使用 UTC 时区。例如：0 9 * * * 表示每天 UTC 09:00 执行。
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
              {busy ? '创建中…' : '创建'}
            </button>
            <button
              onClick={() => setOpen(false)}
              type="button"
              disabled={busy}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-xs hover:bg-slate-100"
            >
              取消
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
  const [runsError, setRunsError] = useState<string | null>(null);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const followerRef = useRef<ReturnType<typeof followTaskRuns> | null>(null);
  const loadRuns = () => followerRef.current?.refresh();

  useEffect(() => {
    setRuns(null);
    setNotice(null);
    setLastUpdated(null);
    const visible = () => document.visibilityState === 'visible';
    const follower = followTaskRuns(
      t.id,
      (next) => {
        setRuns(next);
        setLastUpdated(new Date());
        setRunsError(null);
      },
      setRunsError,
      visible,
    );
    followerRef.current = follower;
    follower.refresh();
    const focus = () => {
      if (visible()) follower.refresh();
    };
    const visibility = () => {
      if (visible()) follower.refresh();
      else follower.pause();
    };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visibility);
    return () => {
      follower.stop();
      followerRef.current = null;
      window.removeEventListener('focus', focus);
      document.removeEventListener('visibilitychange', visibility);
    };
  }, [t.id]);

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
            {taskLabels[t.status]}
          </span>
        </div>
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-slate-600">
          <div>
            <dt className="inline font-medium">执行计划： </dt>
            <dd className="inline">
              {taskLabels[t.scheduleType]} (
              {t.scheduleType === 'cron'
                ? t.cronExpr
                : t.scheduleType === 'interval'
                  ? `${t.intervalSeconds} 秒`
                  : t.runAt
                    ? new Date(t.runAt).toLocaleString()
                    : '—'}
              {t.scheduleType === 'cron'
                ? ' UTC'
                : t.scheduleType === 'once'
                  ? ' 本地时间'
                  : ''}
              )
            </dd>
          </div>
          <div>
            <dt className="inline font-medium">上下文： </dt>
            <dd className="inline">{taskLabels[t.contextMode]}</dd>
          </div>
          <div className="col-span-2">
            <dt className="inline font-medium">创建于： </dt>
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
              暂停
            </button>
          ) : (
            <button
              disabled={props.busy}
              onClick={() => void props.onAct(() => api.post(`/tasks/${t.id}/resume`))}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
            >
              恢复
            </button>
          )}
          <button
            onClick={() =>
              void props.onAct(() =>
                api
                  .post<{ queued: boolean; runId?: string }>(`/tasks/${t.id}/run`)
                  .then((res) => {
                    if (!followerRef.current) return;
                    setNotice(
                      res.queued ? `已排队（执行记录 ${res.runId ?? ''}）` : '任务未启用',
                    );
                    followerRef.current.refresh(res.runId);
                  }),
              )
            }
            disabled={props.busy || t.status !== 'active'}
            className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50"
          >
            立即执行
          </button>
          <ConfirmAction
            title="删除此任务？"
            onConfirm={props.onDelete}
            disabled={props.busy}
            className="rounded-md border border-red-200 px-3 py-1.5 text-sm text-red-700 hover:bg-red-50"
          >
            此任务将被删除，操作无法撤销。
          </ConfirmAction>
          <button
            onClick={() => void loadRuns()}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-sm hover:bg-slate-100"
          >
            刷新执行记录
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
          执行历史
        </div>
        {lastUpdated && (
          <p className="mb-2 text-xs text-slate-500">
            更新于 {lastUpdated.toLocaleTimeString()}
          </p>
        )}
        {runsError && (
          <p role="alert" className="text-sm text-red-700">
            {runsError}{' '}
            <button className="underline" onClick={() => void loadRuns()}>
              重新加载历史
            </button>
          </p>
        )}
        {runs === null ? (
          <div className="text-sm text-slate-400">加载中…</div>
        ) : runs.length === 0 ? (
          <div className="text-sm text-slate-400">暂无执行记录。</div>
        ) : (
          <table className="task-run-table w-full text-left text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-xs uppercase text-slate-500">
                <th className="py-1 pr-2">状态</th>
                <th className="py-1 pr-2">尝试次数</th>
                <th className="py-1 pr-2">可执行时间</th>
                <th className="py-1 pr-2">完成时间</th>
                <th className="py-1">结果 / 错误</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-slate-100 align-top">
                  <td data-label="状态" className="py-1.5 pr-2">
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
                      {taskLabels[r.status]}
                    </span>
                  </td>
                  <td data-label="尝试次数" className="py-1.5 pr-2">
                    {r.attempt}
                  </td>
                  <td data-label="可执行时间" className="py-1.5 pr-2 text-xs text-slate-500">
                    {new Date(r.availableAt).toLocaleString()}
                  </td>
                  <td data-label="完成时间" className="py-1.5 pr-2 text-xs text-slate-500">
                    {r.finishedAt ? new Date(r.finishedAt).toLocaleString() : '—'}
                  </td>
                  <td
                    data-label="结果 / 错误"
                    className="min-w-0 break-words py-1.5 text-xs text-slate-600"
                  >
                    <RunResult
                      key={`${r.id}-${taskLabels[r.status]}`}
                      text={r.error ?? r.result}
                    />
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

function RunResult({ text }: { text: string | null }) {
  const [expanded, setExpanded] = useState(false);
  const [copyState, setCopyState] = useState('复制结果');
  if (text === null) return <>—</>;
  return (
    <div className="task-result">
      <div className={expanded ? 'task-result-full' : 'task-result-preview'}>{text}</div>
      <div className="mt-1 flex flex-wrap gap-3">
        <button
          className="underline"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {expanded ? '收起结果' : '展开结果'}
        </button>
        <button
          className="underline"
          onClick={() => {
            void navigator.clipboard.writeText(text).then(
              () => setCopyState('已复制'),
              () => setCopyState('复制失败'),
            );
          }}
        >
          {copyState}
        </button>
        <span className="sr-only" role="status">
          {copyState === '复制结果' ? '' : copyState}
        </span>
      </div>
    </div>
  );
}
