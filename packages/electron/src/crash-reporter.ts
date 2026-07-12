// Native crash capture (E5, reworked to harvest-and-bundle — docs/design/electron-native-crashes.md). Electron
// ships a built-in `crashReporter` (Crashpad/Breakpad) that writes a minidump for EVERY process (main,
// renderer, GPU, child) with no per-OS native code from us. We start it with `uploadToServer: false` so
// Crashpad writes dumps to its local database but NEVER uploads them — the SDK harvests the `.dmp`s on the
// next launch and packs each into a normal Bugsee bundle (stitched to the crashed session), which the worker
// stackwalks. Session-correlation params (`session_id`/`app_token`) still ride inside the dump as `extra`.
// `electron` is taken as an arg (no dependency; fully testable).

export interface CrashReporterStartOptions {
  submitURL?: string;
  uploadToServer?: boolean;
  extra?: Record<string, string>;
  /** Other Electron crashReporter.start options (companyName/productName/globalExtra/…) pass through. */
  [key: string]: unknown;
}

/** The subset of Electron's `crashReporter` we use. */
export interface CrashReporterLike {
  start(options: CrashReporterStartOptions): void;
  /** Electron's crash-dumps directory (Crashpad DB). Present on Electron's real crashReporter; the harvest
   *  reads pending `.dmp`s from here. */
  getCrashesDirectory?(): string;
}

export interface InstallNativeCrashReporterOptions {
  crashReporter: CrashReporterLike;
  appToken: string;
  /** The client-minted session id — rides inside every minidump as `extra.session_id`. */
  sessionId: string;
  /** Extra crash params (merged UNDER the session correlation, which always wins). */
  extra?: Record<string, string>;
  /** Additional Electron `crashReporter.start` options (companyName, productName, compress, …). */
  startOptions?: Omit<CrashReporterStartOptions, 'uploadToServer' | 'extra'>;
}

/**
 * Start Electron's native crash reporter in HARVEST mode: `uploadToServer: false` (Crashpad writes dumps
 * locally but never uploads — the SDK harvests + bundles them), stamped with the session-correlation params.
 * Call once in the main process (covers all processes).
 */
export function installNativeCrashReporter(options: InstallNativeCrashReporterOptions): void {
  options.crashReporter.start({
    ...options.startOptions,
    // Crashpad writes the dump to its local database; the SDK harvests it on next launch (never a direct
    // Crashpad upload — the backend ingests only bundle-embedded minidumps).
    uploadToServer: false,
    extra: {
      // Caller extras first; the correlation params always win (never overridable).
      ...options.extra,
      session_id: options.sessionId,
      app_token: options.appToken,
    },
  });
}

/** The Crashpad crash-dumps directory the harvest reads (`.dmp`s land here); undefined when unavailable. */
export function getCrashDumpsDirectory(crashReporter: CrashReporterLike): string | undefined {
  return crashReporter.getCrashesDirectory?.();
}
