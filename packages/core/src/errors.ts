// Canonical SDK error (design §10). `cause` chains the underlying error. Carried on UploadResult.error
// and thrown from hard-fail paths.
//
// TWO DISJOINT NUMERIC NAMESPACES, and conflating them is a data-loss bug: `code` is the HTTP STATUS
// (`0` when none was reached), while `serverCode` is the COLLECTOR's own code from a `{ ok: false,
// error: { code } }` envelope — the mobile-parity codes such as 12003/12004 (§7.7) and 14019. The
// collector answers HTTP 200 with an error envelope, so the two never arrive together and a collector
// code must never be read as a status.

export interface BugseeErrorOptions {
  /** The underlying error this one wraps, surfaced as the standard `Error.cause`. */
  cause?: unknown;
  /**
   * The app token itself has been switched off — collector code `KILL_SDK` (99099), and ONLY that. The
   * client enters its kill-state. Default false.
   *
   * NOT an invalid app token: that arrives as `14019` and classifies as `permanent` (drop this bundle),
   * because a bad token is a per-payload verdict, not a reason to stop capturing. And NOT an HTTP
   * 401/403, which is an infrastructure answer — a proxy, a WAF, a session expiring mid-upload.
   */
  fatal?: boolean;
  /**
   * The COLLECTOR's own error code, from a `/v2/*` `{ ok: false, error: { code } }` envelope.
   *
   * A SEPARATE numeric namespace from `code`, and it has to be: a v2 rejection arrives with **HTTP
   * 200**, so there is no status to report, and the collector's codes overlap HTTP statuses by pure
   * accident (a collector code of `403` is not an auth failure). Carrying one in `code` meant the
   * upload pipeline read it as a status — retrying Android's permanent codes forever, and disabling the
   * SDK on a transient rejection that merely happened to be numbered 401 or 403.
   *
   * Read it through {@link classifyServerErrorCode}, never by comparing it to a status.
   */
  serverCode?: number;
  /**
   * This failure will not succeed on a retry — the payload is refused, not delayed. Becomes
   * `UploadResult.permanent`, which frees the bundle instead of carrying it to the next launch.
   */
  permanent?: boolean;
}

export class BugseeError extends Error {
  /**
   * Numeric error code (mobile-parity). For a transport failure this is the HTTP STATUS, or `0` when
   * no status was reached (a throw, a rejection inside a 200 envelope, an assembly failure). NEVER a
   * collector error code — see {@link BugseeErrorOptions.serverCode}.
   */
  readonly code: number;
  /** True only for the collector's KILL_SDK (99099) verdict: the app token has been switched off. */
  readonly fatal: boolean;
  /** The collector's own error code, when the failure came from a `/v2/*` envelope. */
  readonly serverCode?: number;
  /** True when a retry cannot help — the payload itself was refused. */
  readonly permanent: boolean;

  constructor(message: string, code: number, options?: BugseeErrorOptions) {
    super(message, options);
    this.name = 'BugseeError';
    this.code = code;
    this.fatal = options?.fatal ?? false;
    this.permanent = options?.permanent ?? false;
    if (options?.serverCode !== undefined) {
      this.serverCode = options.serverCode;
    }
  }
}
