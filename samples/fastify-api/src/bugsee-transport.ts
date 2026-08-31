// A "tee" transport: forwards every SDK network call to the REAL staging endpoint verbatim, while
// recording a parsed summary of each call locally. That local record is what lets `pnpm verify` and
// the agent assert on things the MCP surface does not expose (redacted network bodies, the exact
// bundle contents, per-request attributes) — the "wire" verification depth from
// docs/samples/PLAN.md §4.
//
// It rewrites no REQUEST the SDK makes. samples/express-api found three wire-contract SDK defects (a
// hardcoded `x-client-type: web`, the unparsed `{ok, result}` response envelope, and an
// `x-amz-checksum-sha256` header the presigned S3 url was never signed for) that once required
// workarounds here; all three are fixed in @bugsee/core (see samples/FINDINGS.md F-X2/F-X10 and
// packages/core/src/bugsee-api.ts / bundle-uploader.ts) and this sample was built AFTER those fixes
// landed, so it never carried them. If a request rewrite is ever needed here, that is itself a new
// finding — this sample has stopped testing what a customer actually runs.
//
// "Rewrites nothing" is NOT the same claim as "behaves identically to the transport it replaces", and
// the earlier version of this header conflated the two: it rewrote no request while still leaving
// every SDK upload unbounded (no timeout) and charging the SDK's own request for a synchronous
// bundle unzip. See the block above createTeeTransport() for the parity contract this now holds to.
//
// This is a real HttpTransport (the shape @bugsee/node's `transport` launch option expects), built on
// the Node global `fetch` — no @bugsee/node-utils import needed.
import { strFromU8, unzipSync } from '@bugsee/util';

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

export interface CapturedCall {
  seq: number;
  at: string;
  kind: 'session' | 'issue' | 'bundle-upload' | 'performance' | 'other';
  method: string;
  url: string;
  status: number;
  requestHeaders: Record<string, string>;
  /** Parsed bundle contents (bundle-upload calls only) — file list + the fields verification cares about. */
  bundle?: ParsedBundleSummary;
  /** Parsed /v2/performance/transactions body (performance calls only) — the wire-only S9 evidence. */
  transactions?: Array<{ name: string; op?: string; status?: string; spanCount?: number }>;
}

export interface ParsedBundleSummary {
  files: string[];
  request?: Record<string, unknown>;
  logCount?: number;
  logMessages?: string[];
  breadcrumbCount?: number;
  breadcrumbs?: unknown[];
  network?: unknown[];
  /** manifest.json `attrs` — where setAttribute()/per-request attributes actually land on the wire. */
  attrs?: Record<string, unknown>;
}

// Generous headroom: a single verify.ts run can produce well over a hundred issues (the S4 storm
// scenario alone logs 200), each worth ~2 HTTP calls (issue create + bundle PUT) plus periodic
// performance/session calls.
const MAX_RECORDS = 5000;
const records: CapturedCall[] = [];
let seq = 0;

function classify(url: string, method: string): CapturedCall['kind'] {
  if (url.endsWith('/v2/sessions')) return 'session';
  if (url.endsWith('/v2/issues')) return 'issue';
  if (url.endsWith('/v2/performance/transactions')) return 'performance';
  if (method === 'PUT') return 'bundle-upload';
  return 'other';
}

interface TransactionWireLike {
  name: string;
  op?: string;
  operation?: string;
  status?: string;
  spans?: unknown[];
}

function parsePerformanceBody(
  bodyBytes: Uint8Array,
): Array<{ name: string; op?: string; status?: string; spanCount?: number }> | undefined {
  try {
    const text = new TextDecoder().decode(bodyBytes);
    const parsed = JSON.parse(text) as { transactions?: TransactionWireLike[] };
    return (parsed.transactions ?? []).map((t) => ({
      name: t.name,
      op: t.op ?? t.operation,
      status: t.status,
      spanCount: Array.isArray(t.spans) ? t.spans.length : undefined,
    }));
  } catch {
    return undefined;
  }
}

function parseBundle(body: Uint8Array): ParsedBundleSummary | undefined {
  try {
    const files = unzipSync(body) as Record<string, Uint8Array>;
    const summary: ParsedBundleSummary = { files: Object.keys(files) };
    const requestFile = files['request.json'];
    if (requestFile !== undefined) {
      summary.request = JSON.parse(strFromU8(requestFile)) as Record<string, unknown>;
    }
    const logsFile = files['logs.json'];
    if (logsFile !== undefined) {
      const logs = JSON.parse(strFromU8(logsFile)) as Array<{ message?: string }>;
      summary.logCount = logs.length;
      summary.logMessages = logs.map((l) => l.message ?? '').slice(0, 100);
    }
    // NB: the wire filename has no .json extension for breadcrumbs — mobile contract (protocol
    // constants.ts DEFAULT_FILENAMES). Getting this wrong here would silently show 0 breadcrumbs.
    const breadcrumbsFile = files['breadcrumbs'];
    if (breadcrumbsFile !== undefined) {
      const crumbs = JSON.parse(strFromU8(breadcrumbsFile)) as unknown[];
      summary.breadcrumbCount = crumbs.length;
      summary.breadcrumbs = crumbs;
    }
    const networkFile = files['network.json'];
    if (networkFile !== undefined) {
      summary.network = JSON.parse(strFromU8(networkFile)) as unknown[];
    }
    const manifestFile = files['manifest.json'];
    if (manifestFile !== undefined) {
      const manifest = JSON.parse(strFromU8(manifestFile)) as { attrs?: Record<string, unknown> };
      summary.attrs = manifest.attrs;
    }
    return summary;
  } catch {
    // Not every PUT necessarily carries a zip (defensive — never let recording break the real upload).
    return undefined;
  }
}

// ---------------------------------------------------------------------------------------------
// Parity with the transport this tee REPLACES.
//
// fastify-api is a NODE sample, so `transport:` here stands in for @bugsee/node-utils' `httpRequest`
// (packages/node-utils/src/http-request.ts) — that is what packages/node/src/launch.ts:415-417 wires
// when no `transport` option is given (`options.transport ?? httpRequest`). NOT the browser fetch
// transport. Both happen to use the same 30s figure, but the node one is the contract that binds
// here, and it was checked rather than assumed.
//
// 1. TIMEOUT. `httpRequest` destructures `timeoutMs = DEFAULT_TIMEOUT_MS` (http-request.ts:12,31) and
//    arms `req.setTimeout(timeoutMs)` (:72-74) on EVERY call. Core never passes `timeoutMs`: it is
//    declared on HttpRequestOptions (packages/core/src/transport.ts:27) but omitted at every call
//    site (bundle-uploader.ts:21-34, bugsee-api.ts:81-85 and :108-112) — the transport itself is
//    expected to supply the default. A tee that bounds only calls which happen to pass one
//    explicitly therefore bounds NOTHING: every SDK upload becomes unbounded, a hung request never
//    converts into a retryable failure for the durable bundle queue, and it holds an `inFlight` slot
//    in the upload pipeline forever. That is a behaviour change introduced by this sample's own
//    interception — the "interceptors must not alter app behaviour" hazard the sample exists to
//    catch, turned on ourselves. So: always arm the timeout, defaulting to the same 30s.
//
//    Error shape: node's transport rejects with `new Error(`request to ${url} timed out after
//    ${timeoutMs}ms`)` (http-request.ts:73). `AbortSignal.timeout` would instead surface a
//    `TimeoutError` DOMException, so the abort is caught here and re-thrown with node's exact
//    message — a caller (or a future assertion) cannot tell the two transports apart. That claim is
//    stated absolutely, so it has to hold for the WHOLE request: both awaited stages (`fetch()` AND
//    the body read) are inside the normalizing try/catch. An earlier version wrapped only `fetch()`,
//    which left the body read rejecting with the raw `TimeoutError` — reproduced against a server
//    that sends headers and then stalls the body. Harmless in practice today (core inspects no error
//    message, only whether the promise rejected), fixed because the claim admits no exception.
//
//    Known, deliberate residual difference: `req.setTimeout` is an IDLE-SOCKET timeout (fires after
//    30s of no socket activity) whereas `AbortSignal.timeout` is a TOTAL-REQUEST deadline (30s wall
//    clock including the body transfer), so the abort-based bound is strictly tighter. The two can
//    only diverge for a body whose transfer takes >30s while never idling for 30s. The ground for
//    treating that as out of reach here is MEASURED THROUGHPUT, not bundle size (bundle size was the
//    earlier justification and it was never measured — and every incident bundle in this sample in
//    fact carries a `profile.json`, `profiling: true` in src/bugsee.ts:59): the 2026-08-26 sweep
//    drained 101 bundles to real staging through this transport, its 5s polling ticks advancing by
//    6-9 bundles each at steady state — ~0.6s per upload end to end, ~50x under the 30s bound. A
//    sample that ever uploads a body taking >30s must revisit this rather than assume parity.
//
// 2. CONTENT ENCODING. `httpRequest` adds `accept-encoding: gzip, deflate` when the caller set none
//    (:35-39) and gunzip/inflates the response itself (:19-27). Undici's `fetch` does its own
//    content negotiation and transparently decodes, so the DECODED body core receives is the same;
//    what differs is that undici strips `content-encoding` from the headers it exposes while node's
//    transport leaves the original header on the object it returns. Core never reads a RESPONSE
//    header (bugsee-api.ts / bundle-uploader.ts only ever read `status` and `body`), so this is
//    invisible to the SDK. Recorded here rather than papered over.
//
// 3. RECORDING MUST NOT SIT ON THE TIMING PATH. Parsing a bundle means a synchronous `unzipSync`
//    plus several `JSON.parse`s. Doing that BEFORE resolving the transport promise charges the SDK's
//    own upload for work no real transport does: it inflates the measured request, delays the upload
//    pipeline's `inFlight` release, and blocks the event loop inside the call the SDK is awaiting.
//    The parse is therefore deferred with `setImmediate`, after the response has been handed back.
//    It is still main-thread work in this process — this is a sample, not a profiler harness — it is
//    simply no longer inside the call the SDK waits on. `getCapturedBundles()` filters on
//    `bundle !== undefined`, so a record stays invisible to the wire checks until its parse lands;
//    `pnpm verify` polls for bundle-count stability, which absorbs the one-tick lag.
//
// 4. REDIRECTS. Fetch's default `redirect` mode is `'follow'`: undici transparently chases up to 20
//    3xx hops and hands back the FINAL response, so the SDK would only ever see the 2xx (or the
//    error) at the end of the chain. `httpRequest` is built on `http.request`
//    (packages/node-utils/src/http-request.ts:51), which does NOT follow anything — a 3xx resolves
//    as `{ status: 3xx, body: <the redirect body> }` and is handed to core verbatim. That difference
//    is not cosmetic: `packages/core/src/bundle-uploader.ts:42-45` maps any non-2xx below 500 to
//    `{ ok:false, retryable:false }`, so under the REAL transport a 3xx from the collector — or a
//    region-redirecting S3 presigned PUT — is a PERMANENT, non-retryable upload failure, while a
//    following tee would quietly turn the same response into a success and hide the bug this sample
//    exists to catch. `redirect: 'manual'` is therefore set explicitly: undici then resolves the 3xx
//    itself, status and all, matching `http.request`. (Not observed against staging — no hop in this
//    sweep has ever answered 3xx — which is exactly why it is pinned rather than left to the default:
//    the day one does, the tee must report it the way the shipping transport would.)
const DEFAULT_TIMEOUT_MS = 30_000;

/** Build the transport used by the launched client. Every call is forwarded to the real staging
 *  endpoint verbatim; the tee only RECORDS a parsed copy, so wire-level assertions (redaction,
 *  attributes, route names, dedupe) can be made on exactly what the SDK sent. It rewrites no
 *  request, and (see the block above) matches `httpRequest`'s timeout bound and error shape. */
export function createTeeTransport(): HttpTransport {
  return async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const signal = AbortSignal.timeout(timeoutMs);
    // `redirect: 'manual'` is load-bearing, not a default restated — see parity point 4 above:
    // fetch would otherwise FOLLOW a 3xx and hide it, where `http.request` (the transport this tee
    // stands in for) surfaces it as a non-retryable non-2xx.
    const init: RequestInit = { method, headers: options.headers, signal, redirect: 'manual' };
    if (options.body !== undefined) {
      // Handed to fetch as-is: node's `httpRequest` does `req.write(body)` straight from the caller's
      // buffer, so copying it (`new Uint8Array(body)`) here would add a per-upload memcpy inside the
      // awaited call that the real transport never performs. The undici `RequestInit['body']` union
      // doesn't name the generic `Uint8Array<ArrayBufferLike>` shape, but a string and a Uint8Array
      // are both valid request bodies at runtime (same widening packages/browser-utils'
      // fetch-transport.ts:27-30 does).
      init.body = options.body as RequestInit['body'];
    }

    // BOTH awaited stages sit inside the timeout normalization. `AbortSignal.timeout` bounds the
    // whole request, so a server that sends headers and then stalls the BODY makes
    // `res.arrayBuffer()` reject — with a raw `TimeoutError` DOMException, where node's transport
    // rejects the same case with `request to <url> timed out after <ms>ms` (its `req.setTimeout`
    // handler calls `req.destroy(err)`, http-request.ts:72-74, which reaches the caller via
    // `req.on('error', fail)`, :71). Wrapping only `fetch()` normalized half the request.
    let status: number;
    let body: Uint8Array;
    const resHeaders: Record<string, string | string[] | undefined> = {};
    try {
      const res = await fetch(url, init);
      status = res.status;
      body = new Uint8Array(await res.arrayBuffer());
      res.headers.forEach((v, k) => {
        resHeaders[k] = v;
      });
    } catch (error) {
      // A genuine network error is rethrown untouched, exactly as `req.on('error', fail)` propagates it.
      if (signal.aborted) {
        throw new Error(`request to ${url} timed out after ${timeoutMs}ms`);
      }
      throw error;
    }

    const kind = classify(url, method);
    const record: CapturedCall = {
      seq: (seq += 1),
      at: new Date().toISOString(),
      kind,
      method,
      url,
      status,
      // A defensive copy: `records` outlives the call, and the headers object belongs to the caller
      // (launch.ts's `internalTagged` builds a fresh one per request, but the tee must not depend on
      // that, and must never hand a live reference back out through `_debug/calls`).
      requestHeaders: { ...options.headers },
    };
    records.push(record);
    if (records.length > MAX_RECORDS) records.shift();

    const bodyBytes =
      options.body === undefined
        ? undefined
        : typeof options.body === 'string'
          ? new TextEncoder().encode(options.body)
          : options.body;
    if (bodyBytes !== undefined && (kind === 'bundle-upload' || kind === 'performance')) {
      // Off the timing path — see note 3 above. `parseBundle`/`parsePerformanceBody` swallow their own
      // errors, so a malformed body can never surface as an unhandled exception on this tick.
      setImmediate(() => {
        if (kind === 'bundle-upload') {
          record.bundle = parseBundle(bodyBytes);
        } else {
          record.transactions = parsePerformanceBody(bodyBytes);
        }
      });
    }

    return { status, headers: resHeaders, body };
  };
}

export function getCapturedCalls(): readonly CapturedCall[] {
  return records;
}

export function getCapturedBundles(): readonly CapturedCall[] {
  return records.filter((r) => r.kind === 'bundle-upload' && r.bundle !== undefined);
}

export function getCapturedTransactions(): readonly CapturedCall[] {
  return records.filter((r) => r.kind === 'performance' && r.transactions !== undefined);
}

export function clearCapturedCalls(): void {
  records.length = 0;
}
