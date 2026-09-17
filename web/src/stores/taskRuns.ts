import { api, type TaskRun } from '../api.js';

/** One task's visible run history: coalesced requests and a single follow-up timer. */
export function followTaskRuns(
  taskId: string,
  onData: (runs: TaskRun[]) => void,
  onError: (message: string) => void,
  isVisible: () => boolean,
) {
  let stopped = false;
  let request: AbortController | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let refreshPending = false;
  let failures = 0;
  let expected: { id: string; until: number } | undefined;
  const pause = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const refresh = (runId?: string) => {
    if (stopped) return;
    if (runId) expected = { id: runId, until: Date.now() + 60_000 };
    pause();
    if (request) {
      refreshPending = true;
      return;
    }
    const controller = new AbortController();
    request = controller;
    void (async () => {
      let nextDelay: number | undefined;
      try {
        const { runs } = await api.get<{ runs: TaskRun[] }>(`/tasks/${taskId}`, {
          signal: controller.signal,
        });
        if (stopped || controller.signal.aborted) return;
        failures = 0;
        onData(runs);
        if (expected && runs.some((r) => r.id === expected!.id)) expected = undefined;
        if (expected && Date.now() >= expected.until) {
          expected = undefined;
          onError('The queued run is not visible yet. Refresh runs to check again.');
        }
        if (
          expected ||
          runs.some((r) => ['queued', 'retry_wait', 'running'].includes(r.status))
        ) {
          nextDelay = 1500;
        }
      } catch (err) {
        if (stopped || controller.signal.aborted) return;
        onError(err instanceof Error ? err.message : 'Could not load run history.');
        nextDelay = Math.min(1500 * 2 ** Math.min(failures++, 5), 30_000);
      } finally {
        request = undefined;
        if (stopped) return;
        if (refreshPending) {
          refreshPending = false;
          if (isVisible()) refresh();
        } else if (nextDelay !== undefined && isVisible()) {
          timer = setTimeout(() => refresh(), nextDelay);
        }
      }
    })();
  };
  return {
    refresh,
    pause,
    stop: () => {
      stopped = true;
      pause();
      request?.abort();
    },
  };
}
