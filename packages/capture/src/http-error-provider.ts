import {
  type Clock,
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

import type { NetworkSource } from './network-provider';

// `detectHttpErrors` (Android `DetectAndReportHttpErrors`): a failed HTTP exchange — a response with
// status >= 400, or a request that never got a response — becomes an `error` report with mechanism
// `http-error`. It is a detection provider that SUBSCRIBES to the network sources (pub/sub design), so it
// adds no hook of its own and sees exactly what network capture sees (the SDK's own traffic is already
// skipped by the interceptors). Off by default, as on mobile.

/** Request/response transports. ws/sse/webtransport have no status; sendBeacon is fire-and-forget. */
const HTTP_MECHANISMS: ReadonlySet<NetworkMechanism> = new Set(['fetch', 'xhr', 'http']);

// A failing endpoint that is polled, or a page that retries in a loop, would otherwise file a report per
// attempt. This is a budget of its own, so that such a storm cannot also exhaust the client's capture
// budget for real crashes. 20 per minute: enough to see the pattern, far from a flood.
const DEFAULT_RATE_LIMIT: RateLimiterOptions = { limit: 20, windowMs: 60_000 };

export interface HttpErrorProviderOptions {
  /** Monotonic time source for the rate limiter; injectable. Default the system clock. */
  clock?: Clock;
  /** Reports per rolling window. Default 20 per 60 s. */
  rateLimit?: RateLimiterOptions;
}

/**
 * The request target for a report's text: scheme, host and path only. The query string and fragment are
 * dropped entirely (that is where tokens and ids live, and keeping them would also make every request its
 * own issue), credentials are dropped, and the remainder is passed through the default URL redaction.
 */
const reportableUrl = (raw: unknown): string => {
  const url = String(raw);
  const match = /^([a-z][a-z0-9+.-]*:\/\/)(?:[^/?#]*@)?([^/?#]*)([^?#]*)/i.exec(url);
  const stripped =
    match !== null ? `${match[1]}${match[2]}${match[3]}` : (url.split(/[?#]/)[0] ?? '');
  return sanitizeUrl(stripped);
};

class HttpErrorDetectionProvider extends DetectionProviderBase {
  readonly name = 'http-error';
  readonly controllingOption = BugseeOption.DetectHttpErrors;
  readonly #source: NetworkSource;
  readonly #limiter: { tryAcquire(): boolean };
  #off: (() => void) | null = null;

  constructor(source: NetworkSource, options: HttpErrorProviderOptions) {
    super();
    this.#source = source;
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
  }

  #onNetwork(stage: string, event: NetworkEvent): void {
    if (!HTTP_MECHANISMS.has(event.mechanism)) {
      return;
    }
    const failedResponse = stage === 'complete' && (event.status ?? 0) >= 400;
    if (!failedResponse && stage !== 'error') {
      return;
    }
    if (!this.#limiter.tryAcquire()) {
      return;
    }
    const target = `${event.method} ${reportableUrl(event.url)}`;
    if (failedResponse) {
      const statusText = event.statusText ? ` ${sanitizeErrorMessage(event.statusText)}` : '';
      this.handleReportingRequest(
        this.createErrorReport({
          mechanism: 'http-error',
          summary: `HTTP ${event.status} ${target}`,
          description: `${target} -> ${event.status}${statusText}`,
        }),
      );
      return;
    }
    const cause =
      typeof event.customError === 'string' && event.customError !== ''
        ? `: ${sanitizeErrorMessage(event.customError)}`
        : '';
    this.handleReportingRequest(
      this.createErrorReport({
        mechanism: 'http-error',
        summary: `HTTP request failed: ${target}`,
        description: `${target} failed${cause}`,
      }),
    );
  }
}

/** The HTTP-error detection provider: network sources → `error` reports. Gated by `detectHttpErrors`. */
export function createHttpErrorDetectionProvider(
  source: NetworkSource,
  options: HttpErrorProviderOptions = {},
): DetectionProvider {
  return new HttpErrorDetectionProvider(source, options);
}
