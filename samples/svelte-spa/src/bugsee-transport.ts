// A "tee" transport (same pattern as samples/fastify-api/src/bugsee-transport.ts and
// samples/webpack-sourcemaps/src/bugsee-transport.ts): forwards every SDK network call to the REAL
// staging endpoint verbatim, via the browser's own `fetch`, while recording a parsed summary of each
// call locally. That local record is what lets scripts/verify.mjs assert on things the MCP surface
// does not expose — the exact UPLOADED bundle contents (redaction, labels, dedupe) — the "wire"
// verification depth from docs/samples/PLAN.md §4/§6.6, instead of only asserting on the Scenario
// panel's OWN filter-callback log having run (which proves the callback fired, not that the SDK
// actually applied its return value to what got uploaded — see FINDINGS.md's S8 note).
//
// It rewrites nothing — every call is forwarded byte-for-byte to the real endpoint, and the response is
// returned to the SDK unmodified. The one way it is not invisible: recording costs work. The unzip +
// JSON.parse of each uploaded bundle is therefore deliberately deferred OFF the awaited path (see
// `scheduleParse` below) so the SDK's upload promise resolves on the same schedule it would with the
// real transport; doing it inline made ~100 synchronous unzips run on the main thread during the S4
// storm, delaying every resolve.
import { gunzipSync, strFromU8, unzipSync } from '@bugsee/util';

// Structurally identical to @bugsee/core's HttpTransport (not re-exported from the browser umbrella,
// so defined locally here — same approach the fastify-api/webpack-sourcemaps sibling transports take).
export interface HttpRequestOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
  timeoutMs?: number;
}
export interface HttpResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Uint8Array;
}
export type HttpTransport = (url: string, options?: HttpRequestOptions) => Promise<HttpResponse>;

export interface ParsedBundleSummary {
  files: string[];
  /** Compressed size of `replay.bin` when the bundle carries one (S11 wire evidence). Cheap: this is the
   *  entry length off the unzip, NOT a gunzip — decoding is deferred to `inspectReplay` so a 200-report
   *  storm does not pay for ~100 gunzip+JSON.parse round trips it will never be asked about. */
  replayBytes?: number;
  request?: Record<string, unknown>;
  logMessages?: string[];
  breadcrumbs?: Array<{ message?: string; data?: Record<string, unknown> }>;
  /** Network ring entries, verbatim off `network.json`. The declared fields are the ones verify.mjs
   *  actually reads — `id` pairs an interceptor's stages (a sendBeacon `before` and its `complete` share
   *  one), `mechanism`/`type` identify which interceptor emitted what, and `status` is deliberately
   *  optional: a sendBeacon entry has none at all, because a beacon has no response. */
  network?: Array<{
    id?: string;
    mechanism?: string;
    type?: string;
    method?: string;
    url?: string;
    status?: number;
    direction?: string;
    custom?: { headers?: Record<string, string>; body?: unknown };
  }>;
}

export interface CapturedCall {
  seq: number;
  kind: 'bundle-upload' | 'other';
  method: string;
  url: string;
  status: number;
  bundle?: ParsedBundleSummary;
}

// Generous headroom — the S4 storm alone can produce well over a hundred admitted reports in one sweep.
const MAX_RECORDS = 2000;
const records: CapturedCall[] = [];
let seq = 0;

function classify(method: string): CapturedCall['kind'] {
  return method === 'PUT' ? 'bundle-upload' : 'other';
}

/** Compressed `replay.bin` bytes, keyed by the record's `seq`, kept for on-demand decoding by
 *  `inspectReplay`. Capped hard: a full sweep uploads well over a hundred bundles and each replay is
 *  several KB compressed / tens of KB decoded, so holding them all would be a real memory cost inside the
 *  page under test — which is exactly the kind of observer effect this tee must not introduce. */
const REPLAY_KEEP = 24;
const replayBlobs = new Map<number, Uint8Array>();

function parseBundle(seq: number, body: Uint8Array): ParsedBundleSummary | undefined {
  try {
    const files = unzipSync(body) as Record<string, Uint8Array>;
    const summary: ParsedBundleSummary = { files: Object.keys(files) };
    // S11 (session replay). `replay.bin` is the gzipped rrweb event stream
    // (packages/replay/src/encoder.ts). Recorded here so verify.mjs can assert on the RECORDING — that it
    // exists, that it decodes to real rrweb events, and what text those events do and do not contain —
    // instead of stopping at "the relaunch didn't throw", which is all five S11 checks used to assert and
    // which stays green with replay recording entirely dead.
    const replayFile = files['replay.bin'];
    if (replayFile !== undefined) {
      summary.replayBytes = replayFile.length;
      replayBlobs.set(seq, replayFile);
      while (replayBlobs.size > REPLAY_KEEP) {
        const oldest = replayBlobs.keys().next();
        if (oldest.done === true) break;
        replayBlobs.delete(oldest.value);
      }
    }
    const requestFile = files['request.json'];
    if (requestFile !== undefined) {
      summary.request = JSON.parse(strFromU8(requestFile)) as Record<string, unknown>;
    }
    const logsFile = files['logs.json'];
    if (logsFile !== undefined) {
      const logs = JSON.parse(strFromU8(logsFile)) as Array<{ message?: string }>;
      summary.logMessages = logs.map((l) => l.message ?? '');
    }
    // NB: the wire filename has no `.json` extension for breadcrumbs (mobile contract, protocol
    // constants.ts DEFAULT_FILENAMES) — getting this wrong here would silently show 0 breadcrumbs.
    const breadcrumbsFile = files['breadcrumbs'];
    if (breadcrumbsFile !== undefined) {
      summary.breadcrumbs = JSON.parse(strFromU8(breadcrumbsFile)) as ParsedBundleSummary['breadcrumbs'];
    }
    const networkFile = files['network.json'];
    if (networkFile !== undefined) {
      summary.network = JSON.parse(strFromU8(networkFile)) as ParsedBundleSummary['network'];
    }
    return summary;
  } catch {
    // Not every PUT necessarily carries a zip we can parse — never let recording break the real upload.
    return undefined;
  }
}

/** Build the transport the launched client uses. Every call is forwarded to the real staging endpoint
 *  verbatim; the tee only RECORDS a parsed copy, so wire-level assertions (redaction, labels, dedupe)
 *  can be made on exactly what the SDK sent, not on the scenario panel's own filter-callback log.
 *
 *  Timeout handling mirrors @bugsee/browser-utils's real `createFetchTransport`
 *  (packages/browser-utils/src/fetch-transport.ts): the same 30s default, the same error shape, and —
 *  since the second review pass — the same SCOPE. The real transport keeps the abort timer armed across
 *  `await response.arrayBuffer()` (its `clearTimeout` is in a `finally` that wraps the body read too),
 *  so a response whose BODY stalls still times out there. An earlier version of this tee cleared the
 *  timer as soon as the headers arrived and then read the body unbounded, which is a strictly weaker
 *  bound than the transport it replaces — the same class of app-behaviour change as the bug before it.
 *  Core never actually passes `timeoutMs` (it's declared on `HttpRequestOptions` but every call site
 *  omits it — `bundle-uploader.ts`/`bugsee-api.ts`), so an EARLIER version of this tee that only applied
 *  a timeout when `timeoutMs !== undefined` silently made every SDK call through it UNBOUNDED — a
 *  half-open socket would wedge `flush()`/`stop()` forever. That is exactly the kind of app-behavior
 *  change these samples exist to catch (see the "interceptors must not alter app behaviour" principle),
 *  so this tee must apply the SAME default the real transport does, not skip the bound entirely. */
export function createTeeTransport(): HttpTransport {
  return async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const timeoutMs = options.timeoutMs ?? 30_000;
    const init: RequestInit = { method, headers: options.headers };
    if (options.body !== undefined) {
      init.body = typeof options.body === 'string' ? options.body : new Uint8Array(options.body);
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    init.signal = controller.signal;

    let status: number;
    let rawBuf: Uint8Array;
    const resHeaders: Record<string, string> = {};
    try {
      const res = await fetch(url, init);
      // Inside the try, and BEFORE clearTimeout — same as the real transport: the bound covers the body
      // read, not just the headers.
      rawBuf = new Uint8Array(await res.arrayBuffer());
      status = res.status;
      res.headers.forEach((v, k) => {
        resHeaders[k] = v;
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`request to ${url} timed out after ${timeoutMs}ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }

    const kind = classify(method);
    const record: CapturedCall = { seq: (seq += 1), kind, method, url, status };
    records.push(record);
    if (records.length > MAX_RECORDS) records.shift();
    if (kind === 'bundle-upload' && options.body !== undefined) {
      // Parse the REQUEST body being PUT to the presigned S3 url, not the response — S3's PUT response
      // body is empty on success (a peer sample caught this: parsing the response silently produced 0
      // bundles, which is exactly the "everything still reads green" failure mode this wire-level check
      // exists to avoid).
      //
      // Deferred, not inline: unzipping + JSON.parsing every bundle synchronously here ran ~100 times on
      // the main thread during the S4 storm, BEFORE the SDK's own upload promise resolved — so every
      // upload resolved later under the tee than it would in production. `record` is pushed first and
      // its `bundle` filled in a moment later; `getCapturedBundles()` skips records that aren't parsed
      // yet and verify.mjs's `waitForBundle` polls, so the only visible effect is a slightly later match.
      const bodyBytes =
        typeof options.body === 'string' ? new TextEncoder().encode(options.body) : options.body;
      scheduleParse(record, bodyBytes);
    }

    return { status, headers: resHeaders, body: rawBuf };
  };
}

/** Parse one bundle off the awaited path (see `createTeeTransport`). Never throws into the caller. */
function scheduleParse(record: CapturedCall, bodyBytes: Uint8Array): void {
  setTimeout(() => {
    record.bundle = parseBundle(record.seq, bodyBytes);
  }, 0);
}

export function getCapturedBundles(): readonly CapturedCall[] {
  return records.filter((r) => r.kind === 'bundle-upload' && r.bundle !== undefined);
}

export interface ReplayInspection {
  /** Whether the bundle for this `seq` carried a `replay.bin` that is still held (see REPLAY_KEEP). */
  present: boolean;
  /** Compressed / decoded sizes — a replay that "exists" but decodes to `[]` is a dead recorder. */
  gzBytes: number;
  chars: number;
  /** Number of rrweb events, and the distinct `type` values among them (4 = Meta, 2 = FullSnapshot,
   *  3 = IncrementalSnapshot). A recording with no FullSnapshot cannot be replayed at all. */
  events: number;
  eventTypes: number[];
  /** For each needle: whether it appears anywhere in the decoded rrweb JSON. This is what turns S11 from
   *  "the option was accepted" into "the recording actually redacted the secret" — and, via the un-masked
   *  needles, into a discriminating check rather than a vacuous one (see verify.mjs's s11-replay-masking-wire). */
  hits: Record<string, boolean>;
  error?: string;
}

/**
 * Decode ONE bundle's `replay.bin` and report what it contains. Called on demand from verify.mjs, never
 * during capture — see `REPLAY_KEEP` and `parseBundle` for why the decode is deferred.
 *
 * Needle search is done on the decoded JSON TEXT rather than by walking the event tree: rrweb spreads user
 * text across text nodes, attribute values and incremental input mutations, so "does this string appear
 * anywhere in the recording at all" is both the strongest question to ask about a secret and the only one
 * that does not depend on rrweb's internal event shape.
 */
export function inspectReplay(seq: number, needles: readonly string[]): ReplayInspection {
  const blob = replayBlobs.get(seq);
  const empty: ReplayInspection = {
    present: false,
    gzBytes: 0,
    chars: 0,
    events: 0,
    eventTypes: [],
    hits: {},
  };
  if (blob === undefined) return empty;
  try {
    const text = strFromU8(gunzipSync(blob));
    const events = JSON.parse(text) as Array<{ type?: number }>;
    const hits: Record<string, boolean> = {};
    for (const needle of needles) hits[needle] = text.includes(needle);
    return {
      present: true,
      gzBytes: blob.length,
      chars: text.length,
      events: events.length,
      eventTypes: [...new Set(events.map((e) => e.type ?? -1))].sort((a, b) => a - b),
      hits,
    };
  } catch (error) {
    return { ...empty, present: true, gzBytes: blob.length, error: String(error) };
  }
}

export function clearCapturedCalls(): void {
  records.length = 0;
  replayBlobs.clear();
}
