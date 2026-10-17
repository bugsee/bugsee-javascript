// `hostRead`: any host read that may throw (a property of a cross-origin/torn-down window) → undefined, reported.
// `hostGlobal`: the host's global, or undefined when it is absent OR when reading it throws (a blocked or torn-down frame, a
// cross-origin proxy, a hostile getter). Building a capture source runs inside launch(), so a throwing global
// read must cost only that surface — never the customer's app.
export function hostRead<T>(read: () => T, onError?: (error: unknown) => void): T | undefined {
  try {
    return read();
  } catch (error) {
    try {
      onError?.(error);
    } catch {
      /* the reporter itself failed */
    }
    return undefined;
  }
}

export function hostGlobal<T = never>(
  name: 'window' | 'document' | 'screen',
  onError?: (error: unknown) => void,
): T | undefined {
  return hostRead(() => (globalThis as unknown as Record<string, T | undefined>)[name], onError);
}
