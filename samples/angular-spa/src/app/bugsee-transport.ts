// A "tee" transport (same pattern as samples/webpack-sourcemaps/src/bugsee-transport.ts and
// samples/fastify-api/src/bugsee-transport.ts): forwards every SDK network call to the REAL staging
// endpoint verbatim, via the browser's own `fetch`, while recording a parsed summary of each call
// locally. That local record is what lets `scripts/verify.mjs` assert on things the MCP surface does
// not expose — the exact UPLOADED bundle contents (redaction, masking file presence, dropped over-cap
// bodies) — the "wire" verification depth from `docs/samples/PLAN.md` §4/§6.6, instead of only
// asserting that the Scenario panel's OWN filter callback ran (which proves the callback fired, not
// that the SDK actually applied its return value to what got uploaded — see FINDINGS.md / scenarios.md
// item 2/3).
//
// It rewrites nothing ON THE WIRE: every call is forwarded byte-for-byte to the real endpoint this
// sample already launches against (`ENDPOINT`, staging), with the same method/headers/body and the same
// 30s timeout default the transport it stands in for applies.
//
// It IS a deviation in one respect, stated honestly rather than papered over: recording a parsed copy
// means `unzipSync` + `JSON.parse` over every uploaded bundle, which is real main-thread CPU an app
// running the stock transport would never spend. That work is deliberately deferred off the SDK's
// timing path (see `createTeeTransport` below — the response is returned first and the bundle is parsed
// afterwards in a macrotask), so it cannot inflate the upload latency the SDK measures, but it does
// still run on the same thread as the app. This tee exists only in the sample's verification build.
import { gunzipSync, strFromU8, unzipSync } from '@bugsee/util';

// Structurally identical to @bugsee/core's HttpTransport (not re-exported from the browser umbrella,
// so defined locally here — same approach the peer samples take).
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
  request?: Record<string, unknown>;
  logMessages?: string[];
  // `logMessages` is the message-only view every existing check reads; `logs` keeps the numeric wire
  // `level` alongside it, so `s3-log` can assert the level MAPPING (error=1 … verbose=5), not just that
  // five messages arrived.
  logs?: Array<{ message?: string; level?: number }>;
  breadcrumbs?: Array<{
    message?: string;
    data?: Record<string, unknown>;
    type?: string;
    category?: string;
    level?: string;
  }>;
  // `mechanism`/`method`/`type` were DECLARED in round 7 (the parse below has always passed the wire
  // entries through verbatim, so these fields were already crossing the CDP boundary — they were simply
  // not in the type, and so not reachable from a check without an unsound cast). They are needed because
  // `url` + `custom` alone cannot tell one capture SOURCE from another: the substrate gained a
  // `sendBeacon` interceptor, and a beacon's wire entry differs from a fetch's only by
  // `mechanism: 'sendBeacon'` (`type` is the before/complete stage pair).
  network?: Array<{
    url?: string;
    mechanism?: string;
    method?: string;
    type?: string;
    custom?: { headers?: Record<string, string>; body?: unknown; no_body_reason?: string };
  }>;
  // S3's manual telemetry: `client.event()` writes an `events.user` capture entry and `client.trace()`
  // a `traces.user` one (`packages/core/src/client.ts:603-624`), which the bundle assembler serializes
  // as `events.user.json` / `traces.user.json` (`packages/protocol/src/constants.ts:39-42`, arrays of
  // the raw payloads). Parsed here so `s3-event`/`s3-trace` can assert on the UPLOADED bundle instead
  // of reducing to `isLaunched()` — the same gap `s6-console`'s wire half closed for S6.
  userEvents?: Array<{ name?: string; params?: Record<string, unknown> }>;
  userTraces?: Array<{ name?: string; value?: unknown }>;
}

export interface CapturedCall {
  seq: number;
  kind: 'bundle-upload' | 'other';
  method: string;
  url: string;
  status: number;
  bundle?: ParsedBundleSummary;
}

// Generous headroom — the S4 storm alone can produce dozens of admitted reports in one sweep.
const MAX_RECORDS = 2000;
const records: CapturedCall[] = [];
let seq = 0;

/**
 * The GZIPPED `replay.bin` bytes of each bundle that carried one, keyed by `CapturedCall.seq`.
 *
 * Held OUT of `ParsedBundleSummary` on purpose. `verify.mjs` polls `getCapturedBundles()` every 150 ms
 * through `page.evaluate`, which structured-clones the whole array across the CDP boundary — putting a
 * ~5 KB byte array (or the ~38 KB string it inflates to) on every record would make every poll pay for
 * every bundle in the ring. Kept compressed here and inflated ON DEMAND by `getReplayText()`, which the
 * sweep calls exactly once per assertion.
 */
const replayBlobs = new Map<number, Uint8Array>();

function classify(method: string): CapturedCall['kind'] {
  return method === 'PUT' ? 'bundle-upload' : 'other';
}

function parseBundle(body: Uint8Array, recordSeq: number): ParsedBundleSummary | undefined {
  try {
    const files = unzipSync(body) as Record<string, Uint8Array>;
    const summary: ParsedBundleSummary = { files: Object.keys(files) };
    // `replay.bin` is NOT an opaque blob: `encodeReplay` (`packages/replay/src/encoder.ts:14-16`) is
    // literally `gzipSync(strToU8(JSON.stringify(payloads)))`, so `gunzipSync` + `strFromU8` — both
    // already exported by `@bugsee/util`, which this file already imports — recover the rrweb event
    // stream verbatim. Earlier rounds recorded "no rrweb decoder exists in this sample's tooling" as the
    // reason S11's masking CONTENT could not be verified; that was false, and it left the wave without
    // its positive control for masking. Stored gzipped, inflated on demand — see `replayBlobs`.
    const replayFile = files['replay.bin'];
    if (replayFile !== undefined) {
      replayBlobs.set(recordSeq, replayFile);
    }
    const requestFile = files['request.json'];
    if (requestFile !== undefined) {
      summary.request = JSON.parse(strFromU8(requestFile)) as Record<string, unknown>;
    }
    const logsFile = files['logs.json'];
    if (logsFile !== undefined) {
      const logs = JSON.parse(strFromU8(logsFile)) as Array<{ message?: string; level?: number }>;
      summary.logMessages = logs.map((l) => l.message ?? '');
      summary.logs = logs.map((l) => ({ message: l.message, level: l.level }));
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
    const userEventsFile = files['events.user.json'];
    if (userEventsFile !== undefined) {
      summary.userEvents = JSON.parse(strFromU8(userEventsFile)) as ParsedBundleSummary['userEvents'];
    }
    const userTracesFile = files['traces.user.json'];
    if (userTracesFile !== undefined) {
      summary.userTraces = JSON.parse(strFromU8(userTracesFile)) as ParsedBundleSummary['userTraces'];
    }
    return summary;
  } catch {
    // Not every PUT necessarily carries a zip we can parse — never let recording break the real upload.
    return undefined;
  }
}

/** Build the transport the launched client uses. Every call is forwarded to the real staging endpoint
 *  verbatim; the tee only RECORDS a parsed copy, so wire-level assertions (redaction, masking file
 *  presence, dropped over-cap bodies) can be made on exactly what the SDK sent, not on the scenario panel's
 *  own filter-callback log. */
// The transport this tee REPLACES (`packages/browser-utils/src/fetch-transport.ts:9`) supplies
// `DEFAULT_TIMEOUT_MS = 30_000` itself, and core never passes `timeoutMs` at any call site
// (bundle-uploader.ts / bugsee-api.ts rely on the transport's own default). Bounding only calls that
// happen to pass one explicitly — as an earlier revision of this file did, copied from the unfixed
// `samples/fastify-api` template — therefore left EVERY SDK call in this sample unbounded: a half-open
// socket would wedge `flush()`/`stop()` forever. That is precisely the "interceptors must not alter app
// behaviour" hazard this sample exists to verify, turned on our own tee.
const DEFAULT_TIMEOUT_MS = 30_000;

export function createTeeTransport(): HttpTransport {
  return async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const init: RequestInit = {
      method,
      headers: options.headers,
      signal: AbortSignal.timeout(timeoutMs),
    };
    if (options.body !== undefined) {
      // Pass the caller's buffer THROUGH, exactly as fetch-transport.ts:26-31 does (`init.body = body as
      // BodyInit`). An earlier revision wrapped it in `new Uint8Array(options.body)`, which COPIES every
      // byte of every bundle before the fetch — sub-millisecond, but squarely on the SDK's upload-timing
      // path that this file's header comment claims it keeps clear.
      init.body = options.body as BodyInit;
    }
    let res: Response;
    let rawBuf: Uint8Array;
    try {
      res = await fetch(url, init);
      // The body read belongs INSIDE this try, as it is in fetch-transport.ts:30-40 — an abort that
      // fires while the response body is still streaming has to surface as the SAME normalised Error
      // the catch below mints. Reading it outside (as an earlier revision did) let a timeout during the
      // body read escape as a raw `TimeoutError` from this tee while the real transport reported
      // `request to <url> timed out after <N>ms` — the exact divergence the next comment denies.
      rawBuf = new Uint8Array(await res.arrayBuffer());
    } catch (error) {
      // Match fetch-transport.ts:41-48's error shape so callers (and this sample's assertions) see the
      // same timeout signature regardless of which transport is wired in.
      if (init.signal?.aborted === true) {
        throw new Error(`request to ${url} timed out after ${timeoutMs}ms`);
      }
      throw error;
    }
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });

    const kind = classify(method);
    const record: CapturedCall = { seq: (seq += 1), kind, method, url, status: res.status };
    records.push(record);
    if (records.length > MAX_RECORDS) {
      const evicted = records.shift();
      // Evict the side map in lockstep, or a long sweep leaks every replay blob it ever saw.
      if (evicted !== undefined) replayBlobs.delete(evicted.seq);
    }
    if (kind === 'bundle-upload' && options.body !== undefined) {
      // The zip is the REQUEST body being PUT to the presigned S3 url, not the response (S3's PUT
      // response body is empty on success).
      const bodyBytes =
        typeof options.body === 'string' ? new TextEncoder().encode(options.body) : options.body;
      // DEFERRED off the SDK's timing path: `unzipSync` + `JSON.parse` on a multi-hundred-KB bundle is
      // milliseconds of synchronous main-thread work, and doing it before returning would charge that
      // cost to the upload the SDK is timing. `setTimeout(0)` lets the transport resolve first; the
      // record simply gains its `bundle` a tick later, which `getCapturedBundles()` (filtering on
      // `bundle !== undefined`) and verify.mjs's polling `waitForBundle` both already tolerate.
      setTimeout(() => {
        record.bundle = parseBundle(bodyBytes, record.seq);
      }, 0);
    }

    return { status: res.status, headers: resHeaders, body: rawBuf };
  };
}

/**
 * Every parsed bundle-upload the tee saw, INCLUDING ones whose PUT was rejected.
 *
 * The `status` on each record is load-bearing and deliberately not filtered here. `record.bundle` is
 * parsed from the REQUEST body — the bytes handed to this transport — so it exists whether the upload
 * was stored or refused. A caller that reads a bundle and concludes "the uploaded bundle carries X" is
 * therefore only entitled to that claim once it has ALSO checked `status`: a 403 on the presigned PUT
 * would otherwise leave every wire assertion in the sweep green while nothing reached the backend.
 * Round 7 found exactly that hole — `status` was recorded here and read by ZERO checks — and closed it
 * in `verify.mjs` (`uploadStored()`, applied inside `waitForBundle`, plus the `wire-upload-status`
 * check that reports any non-2xx PUT for the whole run).
 *
 * The filtering stays out of this function on purpose: a check that asserts a bundle is ABSENT (the S8
 * veto pair) must be able to tell "never uploaded" from "uploaded and refused", and it cannot do that
 * if refused uploads are hidden at the source.
 */
export function getCapturedBundles(): readonly CapturedCall[] {
  return records.filter((r) => r.kind === 'bundle-upload' && r.bundle !== undefined);
}

export function clearCapturedCalls(): void {
  records.length = 0;
  replayBlobs.clear();
}

/**
 * The DECODED rrweb event stream of the uploaded bundle whose report summary is `summary`, as JSON text.
 *
 * Returns `undefined` when no such bundle was uploaded, or when it carried no `replay.bin` — the caller
 * must distinguish those from "the stream is present but does not contain X", which is why this returns
 * the text rather than a boolean. Inflates on call (never on the SDK's timing path, and never per poll).
 */
export function getReplayText(summary: string): string | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i];
    if (r.bundle?.request?.['summary'] !== summary) continue;
    const gz = replayBlobs.get(r.seq);
    return gz === undefined ? undefined : strFromU8(gunzipSync(gz));
  }
  return undefined;
}
