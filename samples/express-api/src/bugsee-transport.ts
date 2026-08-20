// A "tee" transport: forwards every SDK network call to the REAL staging endpoint verbatim, while
// recording a parsed summary of each call locally. That local record is what lets `pnpm verify` and
// the dashboard assert on things the MCP surface does not expose (redacted network bodies, the exact
// bundle contents, the trace_id a report carried) — the "wire" verification depth from
// docs/samples/PLAN.md §4.
//
// It rewrites NOTHING. It used to carry three deliberate rewrites, working around SDK defects this
// sample found (a hardcoded `x-client-type: web`, the unparsed `{ok, result}` response envelope, and
// an `x-amz-checksum-sha256` header the presigned S3 url was never signed for). All three are fixed
// in @bugsee/core; see samples/FINDINGS.md. If a rewrite ever reappears here, the sample has stopped
// testing what a customer actually runs.
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

/** Build the transport used by the launched client. Every call is forwarded to the real staging
 *  endpoint verbatim; the tee only RECORDS a parsed copy, so wire-level assertions (redaction,
 *  attributes, route names, dedupe) can be made on exactly what the SDK sent. It rewrites nothing. */
export function createTeeTransport(): HttpTransport {
  return async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const headers = options.headers;
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

    const status = res.status;
    const buf = rawBuf;

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
