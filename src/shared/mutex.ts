/**
 * Keyed async mutex: serializes async work per key. Used to make workflow
 * sidecar writes safe under the flagship parallel-orchestration path, where
 * multiple `updateRow` calls (and the panel's debounced save) would otherwise
 * race on the same load-modify-write cycle and silently drop runs.
 */
export class KeyedMutex {
  private tails = new Map<string, Promise<void>>();

  /** Run `fn` after every previously queued task for `key` has settled. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const task = prev.then(fn, fn);
    const tail = task.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return task;
  }
}
