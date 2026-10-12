/**
 * Hand an option warning to the host's `onError` sink without ever letting the sink break launch. A sink
 * that throws is swallowed; one that returns a rejected promise has the rejection absorbed (an unhandled rejection
 * would crash a Node process under `--unhandled-rejections=strict`). The warning is advice: losing it is better
 * than losing the host application's startup.
 */
export function reportGuarded<E = unknown>(
  onError: ((error: E) => unknown) | undefined,
  error: E,
): void {
  try {
    const result = onError?.(error);
    if (result instanceof Promise) {
      result.catch(() => undefined);
    }
  } catch {
    /* the host's own sink threw: nothing left to tell */
  }
}
