/** Console warning sink for launch-time diagnostics; never throws into the host. */
export const warnToConsole = (message: string): void => {
  (globalThis as unknown as { console?: { warn?: (m: string) => void } }).console?.warn?.(message);
};

/** How a worker is told its version: it has no page to read and no process environment at runtime. */
export const WORKER_APP_VERSION_HINT =
  'Pass `appVersion` (and `appBuild`) to launch(), use the Bugsee Vite or webpack plugin (it defines `__BUGSEE_APP_VERSION__`), or set that constant yourself.';
