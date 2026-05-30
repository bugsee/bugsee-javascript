// Canonical SDK error (design §10). A numeric `code` mirrors the mobile SDKs' error codes (e.g. the
// INVALID_APP_TOKEN kill-state, server dedup 12003/12004 referenced in §7.7); `cause` chains the
// underlying error. Carried on UploadResult.error and thrown from hard-fail paths.

export interface BugseeErrorOptions {
  /** The underlying error this one wraps, surfaced as the standard `Error.cause`. */
  cause?: unknown;
  /** Unrecoverable auth failure (invalid app token): the client enters its kill-state. Default false. */
  fatal?: boolean;
}

export class BugseeError extends Error {
  /** Numeric error code (mobile-parity). */
  readonly code: number;
  /** True for an unrecoverable auth failure (invalid app token) that should disable the SDK. */
  readonly fatal: boolean;

  constructor(message: string, code: number, options?: BugseeErrorOptions) {
    super(message, options);
    this.name = 'BugseeError';
    this.code = code;
    this.fatal = options?.fatal ?? false;
  }
}
