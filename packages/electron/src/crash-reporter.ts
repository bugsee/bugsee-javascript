// Native crash capture (E5). Electron ships a built-in `crashReporter` (Crashpad/Breakpad) that captures
// minidumps in EVERY process (main, renderer, GPU, child) with no per-OS native code from us. We start it
// with the Bugsee minidump submit URL and, crucially, session-correlation params (`session_id`/`app_token`)
// as global `extra` — Crashpad attaches them to every minidump, so the backend joins the native crash to the
// JS session (Android's model). `electron` is taken as an arg (no dependency; fully testable).

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
}

export interface InstallNativeCrashReporterOptions {
  crashReporter: CrashReporterLike;
  appToken: string;
  /** The client-minted session id — correlates the native minidump with the JS session. */
  sessionId: string;
  /** The Bugsee minidump submit endpoint (Crashpad POSTs the dump here). */
  submitURL: string;
  /** Extra crash params (merged UNDER the session correlation, which always wins). */
  extra?: Record<string, string>;
  /** Auto-upload minidumps via Crashpad (default `true`). */
  uploadToServer?: boolean;
  /** Additional Electron `crashReporter.start` options (companyName, productName, compress, …). */
  startOptions?: Omit<CrashReporterStartOptions, 'submitURL' | 'uploadToServer' | 'extra'>;
}

/**
 * Start Electron's native crash reporter, pointed at Bugsee and stamped with the session-correlation params.
 * Call once in the main process (covers all processes). See {@link deriveMinidumpUrl} for the default URL.
 */
export function installNativeCrashReporter(options: InstallNativeCrashReporterOptions): void {
  options.crashReporter.start({
    ...options.startOptions,
    submitURL: options.submitURL,
    uploadToServer: options.uploadToServer ?? true,
    extra: {
      // Caller extras first; the correlation params always win (never overridable).
      ...options.extra,
      session_id: options.sessionId,
      app_token: options.appToken,
    },
  });
}

/**
 * Default Bugsee minidump submit URL from the API base + app token (Android-parity `/v2/apps/{token}/…`
 * shape). The exact path is a backend detail — override via `submitURL` when it's confirmed.
 */
export function deriveMinidumpUrl(baseUrl: string, appToken: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/v2/apps/${appToken}/minidumps`;
}
