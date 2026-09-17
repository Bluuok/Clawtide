import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { api, type TaskRun } from '../api.js';
import { followTaskRuns } from './taskRuns.js';
const run = (status: TaskRun['status']): TaskRun => ({
  id: 'r',
  taskId: 't',
  status,
  attempt: 0,
  availableAt: '',
  startedAt: null,
  finishedAt: null,
  result: null,
  error: null,
});
beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('follows queued and running to success, then stops', async () => {
  const get = vi
    .spyOn(api, 'get')
    .mockResolvedValueOnce({ runs: [run('queued')] })
    .mockResolvedValueOnce({ runs: [run('running')] })
    .mockResolvedValue({ runs: [run('success')] });
  const data = vi.fn();
  const follower = followTaskRuns('t', data, vi.fn(), () => true);
  follower.refresh();
  await vi.advanceTimersByTimeAsync(3000);
  expect(data.mock.calls.map(([runs]) => runs[0].status)).toEqual([
    'queued',
    'running',
    'success',
  ]);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(get).toHaveBeenCalledTimes(3);
  follower.stop();
});
it('coalesces run-now and focus refresh while a request is in flight', async () => {
  let finish!: (value: { runs: TaskRun[] }) => void;
  const get = vi
    .spyOn(api, 'get')
    .mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    )
    .mockResolvedValue({ runs: [run('success')] });
  const follower = followTaskRuns('t', vi.fn(), vi.fn(), () => true);
  follower.refresh();
  follower.refresh('r');
  follower.refresh();
  expect(get).toHaveBeenCalledTimes(1);
  finish({ runs: [] });
  await vi.advanceTimersByTimeAsync(0);
  expect(get).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(get).toHaveBeenCalledTimes(2);
  follower.stop();
});
it('abort and disposal prevent old task data being displayed', async () => {
  let finish!: (value: { runs: TaskRun[] }) => void;
  const get = vi.spyOn(api, 'get').mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  const data = vi.fn();
  const follower = followTaskRuns('t', data, vi.fn(), () => true);
  follower.refresh();
  const signal = get.mock.calls[0][1]!.signal!;
  follower.stop();
  expect(signal.aborted).toBe(true);
  finish({ runs: [run('running')] });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(data).not.toHaveBeenCalled();
  expect(get).toHaveBeenCalledTimes(1);
});
it('keeps last good data on failure and backs off retries', async () => {
  const get = vi
    .spyOn(api, 'get')
    .mockResolvedValueOnce({ runs: [run('running')] })
    .mockRejectedValue(new Error('offline'));
  const data = vi.fn();
  const error = vi.fn();
  const follower = followTaskRuns('t', data, error, () => true);
  follower.refresh();
  await vi.advanceTimersByTimeAsync(3000);
  expect(data).toHaveBeenCalledTimes(1);
  expect(error).toHaveBeenCalledTimes(2);
  expect(get).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(2999);
  expect(get).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(get).toHaveBeenCalledTimes(4);
  follower.stop();
});
it('bounds follow-up when a returned run ID never appears', async () => {
  const get = vi.spyOn(api, 'get').mockResolvedValue({ runs: [] });
  const error = vi.fn();
  const follower = followTaskRuns('t', vi.fn(), error, () => true);
  follower.refresh('missing');
  await vi.advanceTimersByTimeAsync(61_000);
  expect(error).toHaveBeenCalledWith(expect.stringContaining('not visible'));
  const count = get.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(get).toHaveBeenCalledTimes(count);
  follower.stop();
});
it('pauses follow-up while hidden and permits a visible refresh', async () => {
  let visible = false;
  const get = vi.spyOn(api, 'get').mockResolvedValue({ runs: [run('running')] });
  const follower = followTaskRuns('t', vi.fn(), vi.fn(), () => visible);
  follower.refresh();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(get).toHaveBeenCalledTimes(1);
  visible = true;
  follower.refresh();
  await vi.advanceTimersByTimeAsync(1500);
  expect(get).toHaveBeenCalledTimes(3);
  follower.stop();
});
