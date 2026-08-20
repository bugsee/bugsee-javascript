// A "tee" transport: forwards every SDK network call to the REAL staging endpoint (with three
// deliberate rewrites — see WORKAROUNDS below), so verification against the Bugsee backend over MCP
// is genuine, while also recording a parsed summary of each call locally. That local record is what
// lets `pnpm verify` and the dashboard assert on things the MCP surface does not expose (redacted
// network bodies, the exact bundle contents, the trace_id a report carried) — the "wire" verification
// depth from docs/samples/PLAN.md §4.
//
// WORKAROUNDS — see FINDINGS.md for the full diagnosis of each; NONE of them is "the bug fixed", they
// exist purely so the REST of this sample's verification can reach the real backend at all. Found in
// this order, each blocking delivery further along the same request:
//
//   F-1: `@bugsee/core`'s `createBugseeApi` (packages/core/src/bugsee-api.ts) hardcodes the
//   `x-client-type` header to the literal `'web'` regardless of the actual runtime. The staging
//   backend validates it against the application's registered `type` and rejects every non-web call
//   with `ApplicationTypeMismatchError` (code 11004) once the SDK version passes the version gate
//   (which itself rejects the real `sdkVersion: '0.0.0'` — see samples/FINDINGS.md F-X2). Rewritten
//   here on the wire.
//
//   F-2: `ensureSession()`/`postIssue()` in the same file decode the raw `/v2/sessions` and
//   `/v2/issues` response bodies directly as the DTO (`{access_token}`, `IssueCreateResult`) and only
//   check the HTTP status. The REAL backend wraps every response in an envelope — `{ok:true,
//   result:{access_token, ...}}` on success, `{ok:false, error:{type, message, code}}` on a REJECTED
//   request that still comes back HTTP 200. So even a fully successful session create leaves
//   `accessToken === undefined` (not the real token, and not `null` either — so the SDK's
//   `if (accessToken !== null)` memoization guard treats it as "already authenticated" FOREVER), and a
//   rejected request is silently treated as success. Unwrapped here on the wire.
//
//   F-3 (the one that actually blocks the BUNDLE, even past F-1/F-2): `createBundleUploader`
//   (packages/core/src/bundle-uploader.ts) sends a client-computed `x-amz-checksum-sha256` header on
//   the signed S3 PUT. Because that header name is `x-amz-*`, AWS's SigV2 signature verification folds
//   it into the request's canonicalized headers — but the Bugsee backend's presigned `Signature` query
//   parameter was computed WITHOUT it (the backend cannot know the checksum in advance), so S3 rejects
//   EVERY bundle PUT with `403 SignatureDoesNotMatch`. Confirmed by isolation: dropping only that one
//   header (the `fileName` header is harmless — not an `x-amz-*` name) makes the exact same PUT
//   succeed. Stripped here on the wire.
//
// This is a real HttpTransport (same shape @bugsee/node's `transport` launch option expects), built on
// the Node global `fetch` — no @bugsee/node-utils import needed.
import { strFromU8, unzipSync } from '@bugsee/util';

/** F-1 workaround: what a real customer would have to send for `x-client-type` to be accepted for a
 *  `type: "javascript"` staging application — the SDK sends the literal string `'web'` instead. */
const CLIENT_TYPE_WORKAROUND = 'javascript';

/** F-2 workaround: unwrap the real backend's `{ok, result|error}` envelope so the SDK's naive
 *  top-level DTO decode (packages/core/src/bugsee-api.ts) sees what it expects. Only applied to the
 *  two control-plane endpoints that are actually decoded by the SDK (sessions + issues) — the
 *  performance endpoint's body is never read on success, so it needs no unwrap. */
function unwrapEnvelope(url: string, status: number, buf: Uint8Array): { status: number; buf: Uint8Array } {
  if (!url.endsWith('/v2/sessions') && !url.endsWith('/v2/issues')) return { status, buf };
  try {
    const parsed = JSON.parse(new TextDecoder().decode(buf)) as {
      ok?: boolean;
      result?: unknown;
      error?: { message?: string };
    };
    if (parsed.ok === true && parsed.result !== undefined) {
      return { status, buf: new TextEncoder().encode(JSON.stringify(parsed.result)) };
    }
    if (parsed.ok === false) {
      // Surface the rejection as a real HTTP failure so the SDK's status-based error handling
      // (invalidateSession + retry) actually engages, instead of silently caching a broken session.
      return { status: 502, buf };
    }
    return { status, buf };
  } catch {
    return { status, buf }; // not JSON / not the envelope shape — forward unchanged
  }
}

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
  /** manifest.json `attrs` — where setAttribute()/per-request attributes actually land on the wire
   *  (NOT on request.json — see samples/express-api/FINDINGS.md). */
  attrs?: Record<string, unknown>;
}

// Generous headroom: a single verify.ts run can produce >250 issues (the S4 storm scenario alone logs
// 200), each worth ~2 HTTP calls (issue create + bundle PUT) plus periodic performance/session calls.
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

/** Build the real transport used by the launched client. Every call is forwarded to the real staging
 *  endpoint, with the F-1 `x-client-type` rewrite, the F-2 envelope-unwrap and the F-3
 *  checksum-header strip applied so the round trip actually succeeds — see the module doc comment. */
export function createTeeTransport(): HttpTransport {
  return async (url, options = {}) => {
    const method = options.method ?? 'GET';
    // F-1 WORKAROUND: rewrite the SDK's hardcoded 'web' to what the backend expects for a
    // `type: "javascript"` application.
    let headers =
      options.headers?.['x-client-type'] !== undefined
        ? { ...options.headers, 'x-client-type': CLIENT_TYPE_WORKAROUND }
        : options.headers;
    // F-3 WORKAROUND: the signed S3 PUT's Signature was computed without x-amz-checksum-sha256, so
    // sending it makes S3 reject the request — strip it before it ever reaches the wire.
    if (method === 'PUT' && headers?.['x-amz-checksum-sha256'] !== undefined) {
      const { 'x-amz-checksum-sha256': _dropped, ...rest } = headers;
      headers = rest;
    }
    const init: RequestInit = { method, headers };
    if (options.body !== undefined) {
      init.body = typeof options.body === 'string' ? options.body : new Uint8Array(options.body);
    }
    if (options.timeoutMs !== undefined) {
      init.signal = AbortSignal.timeout(options.timeoutMs);
    }
    const res = await fetch(url, init);
    const rawBuf = new Uint8Array(await res.arrayBuffer());
    const resHeaders: Record<string, string | string[] | undefined> = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });

    // F-2 WORKAROUND: unwrap the real backend's {ok, result|error} envelope for the two endpoints the
    // SDK actually decodes (sessions + issues) before it ever reaches the SDK's own JSON.parse.
    const { status, buf } = unwrapEnvelope(url, res.status, rawBuf);

    const kind = classify(url, method);
    const record: CapturedCall = {
      seq: (seq += 1),
      at: new Date().toISOString(),
      kind,
      method,
      url,
      status,
      requestHeaders: options.headers ?? {},
    };
    const bodyBytes =
      options.body === undefined
        ? undefined
        : typeof options.body === 'string'
          ? new TextEncoder().encode(options.body)
          : options.body;
    if (kind === 'bundle-upload' && bodyBytes !== undefined) {
      record.bundle = parseBundle(bodyBytes);
    }
    if (kind === 'performance' && bodyBytes !== undefined) {
      record.transactions = parsePerformanceBody(bodyBytes);
    }
    records.push(record);
    if (records.length > MAX_RECORDS) records.shift();

    return { status, headers: resHeaders, body: buf };
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
