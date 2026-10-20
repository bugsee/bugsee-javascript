// `hostRead`: any host read that may throw (a property of a cross-origin/torn-down window) → undefined, reported.
// Lives here (not in @bugsee/browser) because the trackers read host objects through it and @bugsee/trackers sits
// BELOW @bugsee/browser; @bugsee/browser's host-global re-exports this single definition.
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
