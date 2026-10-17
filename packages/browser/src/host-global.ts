// The host's global, or undefined when it is absent OR when reading it throws (a blocked or torn-down frame, a
// cross-origin proxy, a hostile getter). Building a capture source runs inside launch(), so a throwing global
// read must cost only that surface — never the customer's app.
export function hostGlobal<T = never>(
  name: 'window' | 'document' | 'screen',
  onError?: (error: unknown) => void,
): T | undefined {
  try {
    return (globalThis as unknown as Record<string, T | undefined>)[name];
  } catch (error) {
    try {
      onError?.(error);
    } catch {
      /* the reporter itself failed */
    }
    return undefined;
  }
}
