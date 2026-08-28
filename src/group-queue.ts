/**
 * Per-key serial queue. The same session key executes tasks strictly in
 * order, one at a time; different keys run concurrently. This is the
 * "same session executes sequentially" guarantee (spec §2 地基), and it is
 * the serialization point the R14 scheduler will also route through.
 */
export class SerialQueue {
  private tails = new Map<string, Promise<unknown>>();

  /**
   * Enqueue `task` for `key`. Returns the task's own promise. If `key` already
   * has queued work, this runs only after it resolves — for a session, every
   * user turn is applied to a fully-consistent prior state.
   */
  enqueue<T>(key: string, task: () => Promise<T>): Promise<T> {
    const prior = this.tails.get(key) ?? Promise.resolve();
    // Chain after the previous task, then always keep the tail aligned even if
    // task throws, so a failing turn does not wedge the queue for later turns.
    const run = prior.then(task, task);
    const tail = run.catch(() => undefined).then(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return run;
  }

  pending(key: string): number {
    return this.tails.has(key) ? 1 : 0;
  }
}
