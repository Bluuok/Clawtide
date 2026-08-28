/**
 * SerialQueue (spec §2): same-key tasks run strictly in order and never
 * overlap; different keys interleave concurrently.
 */
import { describe, expect, it } from 'vitest';
import { SerialQueue } from '../group-queue.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('SerialQueue', () => {
  it('runs same-key tasks sequentially with no overlap', async () => {
    const q = new SerialQueue();
    const order: string[] = [];
    const active = { n: 0, max: 0 };

    const task = async (name: string) => {
      return q.enqueue('session-1', async () => {
        active.n++;
        active.max = Math.max(active.max, active.n);
        await sleep(10);
        order.push(name);
        active.n--;
      });
    };

    await Promise.all([task('a'), task('b'), task('c')]);
    expect(order).toEqual(['a', 'b', 'c']);
    expect(active.max).toBe(1); // never two running for the same key
  });

  it('a failing same-key task does not wedge later tasks', async () => {
    const q = new SerialQueue();
    const results: string[] = [];
    await Promise.all([
      q
        .enqueue('k', async () => {
          throw new Error('boom');
        })
        .catch(() => results.push('fail')),
      q.enqueue('k', async () => results.push('ok2')),
      q.enqueue('k', async () => results.push('ok3')),
    ]);
    expect(results).toEqual(['fail', 'ok2', 'ok3']);
  });

  it('different keys run concurrently', async () => {
    const q = new SerialQueue();
    let concurrent = 0;
    let maxConcurrent = 0;
    const run = (key: string, ms: number) =>
      q.enqueue(key, async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await sleep(ms);
        concurrent--;
      });
    await Promise.all([run('k1', 40), run('k2', 40), run('k3', 40)]);
    expect(maxConcurrent).toBeGreaterThan(1);
  });
});
