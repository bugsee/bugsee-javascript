/**
 * A promise paired with its `resolve`/`reject` controls and a `settled` flag.
 *
 * Used for late-registration (per-Client `ServiceContainer`, design §7.4) and the upload
 * pipeline, where a promise must be created before the code that settles it is reached.
 *
 * Native promises are already idempotent (only the first settlement is observable), so no
 * re-entrancy guard is needed; `settled` simply reflects whether a settlement has occurred.
 */
export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  readonly settled: boolean;
}

export function createDeferred<T>(): Deferred<T> {
  let resolveFn!: (value: T | PromiseLike<T>) => void;
  let rejectFn!: (reason?: unknown) => void;
  let settled = false;

  const promise = new Promise<T>((res, rej) => {
    resolveFn = res;
    rejectFn = rej;
  });

  return {
    promise,
    resolve(value) {
      settled = true;
      resolveFn(value);
    },
    reject(reason) {
      settled = true;
      rejectFn(reason);
    },
    get settled() {
      return settled;
    },
  };
}
