import {
  type Clock,
  type CrashJson,
  createRateLimiter,
  createSystemClock,
  type DetectionProvider,
  DetectionProviderBase,
  neverThrow,
  type RateLimiterOptions,
} from '@bugsee/core';
import {
  BugseeOption,
  type NetworkEvent,
  type NetworkMechanism,
  sanitizeErrorMessage,
  sanitizeUrl,
} from '@bugsee/protocol';

import { sanitizeDetectorUrl } from './detector-url-sanitizer';
import type { NetworkSource } from './network-provider';

// `detectHttpErrors` (Android `DetectAndReportHttpErrors`, iOS `BGSDetectionProviderHttpError`): an HTTP
// SERVER error — a response with status 500-599 — becomes an `error` report with mechanism `http-error`.
// Matches mobile:
//  - 4xx is NOT reported (validation, auth challenges and conditional requests are routinely expected), and
//    neither is a transport failure or an aborted request (no HTTP status);
//  - once per (method, normalized URL, status) per session — retries and polling do not re-file;
//  - severity High, set EXPLICITLY so `reportDefaultErrorPriority` does not override it;
//  - domain `HttpError::Server`; grouping is pinned to endpoint + exact status through one frame whose
//    label is `<METHOD> <normalized URL> <status>`;
//  - attributes `http_status_code` / `http_method` / `http_url` (+ `http_status_text`); the text carries
//    only `HTTP <status> <statusText>`.
// It is a detection provider that SUBSCRIBES to the network sources (pub/sub design), so it adds no hook of
// its own and sees exactly what network capture sees (the SDK's own traffic is already skipped by the
// interceptors). Off by default, as on mobile.

/** Request/response transports. ws/sse/webtransport have no status; sendBeacon is fire-and-forget. */
const HTTP_MECHANISMS: ReadonlySet<NetworkMechanism> = new Set(['fetch', 'xhr', 'http']);

const MIN_SERVER_ERROR = 500;
const MAX_SERVER_ERROR = 599;
const DOMAIN = 'HttpError::Server';
const FRAME_CLASS = 'HttpError';

// A BACKSTOP behind the per-session de-duplication: a storm of DISTINCT failing endpoints must not exhaust
// the client's capture budget for real crashes. 20 per minute: enough to see the pattern, far from a flood.
const DEFAULT_RATE_LIMIT: RateLimiterOptions = { limit: 20, windowMs: 60_000 };
// Bounds the de-duplication set (memory). Templating keeps real apps far below this; once full, endpoints not
// yet seen are dropped rather than the set growing without limit.
const DEFAULT_MAX_ENDPOINTS = 1000;

export interface HttpErrorProviderOptions {
  /** Monotonic time source for the rate limiter; injectable. Default the system clock. */
  clock?: Clock;
  /** Reports per rolling window (a backstop behind the de-duplication). Default 20 per 60 s. */
  rateLimit?: RateLimiterOptions;
  /** Most distinct (method, URL, status) tuples remembered per session. Default 1000. */
  maxEndpoints?: number;
}

/** Scheme, host and templated path only (see `sanitizeDetectorUrl`), then the default URL redaction. */
const reportableUrl = (raw: unknown): string =>
  sanitizeUrl(sanitizeDetectorUrl(raw == null ? '' : String(raw)));

class HttpErrorDetectionProvider extends DetectionProviderBase {
  readonly name = 'http-error';
  readonly controllingOption = BugseeOption.DetectHttpErrors;
  readonly #source: NetworkSource;
  readonly #limiter: { tryAcquire(): boolean };
  readonly #maxEndpoints: number;
  readonly #reported = new Set<string>();
  #off: (() => void) | null = null;

  constructor(source: NetworkSource, options: HttpErrorProviderOptions) {
    super();
    this.#source = source;
    this.#maxEndpoints = options.maxEndpoints ?? DEFAULT_MAX_ENDPOINTS;
    this.#limiter = createRateLimiter(
      options.clock ?? createSystemClock(),
      options.rateLimit ?? DEFAULT_RATE_LIMIT,
    );
  }

  protected onStart(): void {
    this.#off = this.#source.onAny((stage, event) => {
      // Contained: this runs inside the network interceptor's emit, which is the application's request.
      neverThrow(() => this.#onNetwork(stage, event));
    });
  }

  protected override onStop(): void {
    this.#off?.();
    this.#off = null;
    this.#reported.clear();
  }

  #onNetwork(stage: string, event: NetworkEvent): void {
    // Android accepts both the completed and the errored stage (a 5xx can arrive on either) and relies on
    // the status gate to exclude transport failures; every other stage never carries a response.
    if (!HTTP_MECHANISMS.has(event.mechanism) || (stage !== 'complete' && stage !== 'error')) {
      return;
    }
    const status = event.status ?? 0;
    if (status < MIN_SERVER_ERROR || status > MAX_SERVER_ERROR) {
      return;
    }
    const method = event.method;
    const url = reportableUrl(event.url);
    const label = `${method || 'HTTP'} ${url} ${status}`;
    if (this.#reported.has(label) || this.#reported.size >= this.#maxEndpoints) {
      return;
    }
    // Only after the cheap gates, and BEFORE consuming the slot: a failure the backstop drops stays
    // reportable once the window reopens.
    if (!this.#limiter.tryAcquire()) {
      return;
    }
    this.#reported.add(label);

    const statusText = event.statusText ? sanitizeErrorMessage(event.statusText) : '';
    const summary = statusText === '' ? `HTTP ${status}` : `HTTP ${status} ${statusText}`;
    const crash: CrashJson = {
      exception_type: 'error',
      ndkCrash: false,
      handled: true,
      exception: {
        name: FRAME_CLASS,
        reason: summary,
        domain: DOMAIN,
        // One synthetic frame pins grouping to endpoint + exact status (Android's frame-method slot).
        frames: [{ trace: `${FRAME_CLASS}.${label}`, user: false }],
      },
    };
    const request = this.createErrorReport({
      mechanism: 'http-error',
      severity: 'high',
      summary,
      description: '',
      crash,
    });
    const attributes = request.report.attributes;
    attributes.http_status_code = status;
    if (method) {
      attributes.http_method = method;
    }
    if (url !== '') {
      attributes.http_url = url;
    }
    if (statusText !== '') {
      attributes.http_status_text = statusText;
    }
    this.handleReportingRequest(request);
  }
}

/** The HTTP-error detection provider: network sources → `error` reports. Gated by `detectHttpErrors`. */
export function createHttpErrorDetectionProvider(
  source: NetworkSource,
  options: HttpErrorProviderOptions = {},
): DetectionProvider {
  return new HttpErrorDetectionProvider(source, options);
}
