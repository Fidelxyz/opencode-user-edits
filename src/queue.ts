/** Runs tasks with the same key in submission order; a failing task does not stop later ones. */
export interface KeyedQueue {
  run<T>(key: string, task: () => Promise<T>): Promise<T>;
  /** Resolves once every task already submitted for the key has settled. */
  idle(key: string): Promise<void>;
}

export function createKeyedQueue(): KeyedQueue {
  const tails = new Map<string, Promise<void>>();

  return {
    run(key, task) {
      const previous = tails.get(key) ?? Promise.resolve();
      const result = previous.then(task);
      const tail = result.then(
        () => undefined,
        () => undefined,
      );

      tails.set(key, tail);
      void tail.then(() => {
        if (tails.get(key) === tail) tails.delete(key);
      });

      return result;
    },

    idle(key) {
      return tails.get(key) ?? Promise.resolve();
    },
  };
}
