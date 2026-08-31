// A "tee" transport (same pattern as samples/fastify-api/src/bugsee-transport.ts): forwards every SDK
// network call to the REAL staging endpoint verbatim, via the browser's own `fetch`, while recording a
// parsed summary of each call locally. That local record is what lets `scripts/verify.mjs` assert on
// things the MCP surface does not expose — the exact bundle contents (redaction, labels, dedupe) — the
// "wire" verification depth from docs/samples/PLAN.md §4/§6.6, instead of only asserting on the
// SCENARIO PANEL'S OWN callback having run (which proves nothing about what the SDK actually put on the
// wire — see FINDINGS.md's S8 note).
//
// It rewrites nothing: every call is forwarded byte-for-byte to the real endpoint.
import { gunzipSync, strFromU8, unzipSync } from '@bugsee/util';

// Structurally identical to @bugsee/core's HttpTransport (not re-exported from the browser umbrella,
// so defined locally here — same approach samples/fastify-api/src/bugsee-transport.ts takes).
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
  /** manifest.json's REPORT-LEVEL `attrs` — where the report's attribute snapshot lives (NOT
   *  request.json). That is `ManifestJson.attrs`, `packages/protocol/src/wire.ts:150,154`, written by
   *  `packages/core/src/bundle-assembler.ts:188-196` — NOT the per-FILE `ManifestFileEntry.attrs`
   *  (`wire.ts:142,146`), which the earlier `wire.ts:141` citation pointed at by mistake (corrected in
   *  fix round 6, R6-3). Needed to assert S2's "each report carries only the attributes that existed
   *  at ITS trigger time" at wire depth instead of merely counting calls. */
  attrs?: Record<string, unknown>;
  logMessages?: string[];
  /** logs.json entries with their LEVEL, not just the message — added for the S6 console wire check
   *  (fix round 5, R5-1): `console.warn`/`error`/`debug` are claimed to map to distinct captured
   *  levels (`packages/capture/src/console-interceptor.ts`'s `DEFAULT_LEVELS`), and a message-only
   *  view cannot tell a correct mapping from one that filed everything as `info`. */
  logEntries?: Array<{ message?: string; level?: unknown }>;
  breadcrumbs?: Array<{ message?: string; data?: Record<string, unknown> }>;
  /** events.user.json entries. Parsed (not merely listed in the manifest) because `captureInteractions`
   *  makes EVERY DOM click an events.user entry too — a manifest-presence check for this file therefore
   *  cannot fail in a sweep that clicks ~50 buttons, whether or not `client.event()` ever ran. */
  userEvents?: Array<{ name?: string; params?: Record<string, unknown> }>;
  /** traces.user.json entries — parsed for the same reason (assert the real name/value `trace()` sent,
   *  not just that the file exists). */
  userTraces?: Array<{ name?: string; value?: unknown }>;
  network?: Array<{
    url?: string;
    type?: string;
    /** Which interceptor produced the entry — `fetch` / `xhr` / `ws` / `sse` (`NetworkEvent.mechanism`).
     *  Load-bearing for the S7 wire checks: `s7-get` and `s7-xhr` hit the SAME url, so only `mechanism`
     *  tells "the XHR code path was captured" apart from "the fetch path was captured". */
    mechanism?: string;
    method?: string;
    /** Present on the INITIAL `complete` entry (the `override` amendment re-emits only the body). */
    status?: number;
    /** `in` / `out` on ws + sse `message` entries — proves both directions of traffic were captured. */
    direction?: string;
    // `override: true` marks the SEPARATE amendment entry a bounded body-read emits once it resolves
    // (fetch-interceptor.ts's #captureResponseBody) — it shares `type: 'complete'` with the initial
    // (non-override) completion entry, but only the override entry ever carries `no_body_reason`.
    override?: boolean;
    custom?: { headers?: Record<string, string>; body?: unknown; no_body_reason?: string };
  }>;
}

/**
 * A compact, on-demand view of ONE bundle's `replay.bin` (S11). Deliberately NOT part of
 * `ParsedBundleSummary`: `scripts/verify.mjs` polls `getCapturedBundles()` through `page.evaluate`
 * several times a second, and the S4 storm alone puts 100 bundles in the record — serialising a full
 * rrweb event stream (a DOM full-snapshot plus every incremental mutation) out of the page on every
 * poll would dominate the sweep's runtime. The digest is computed only when a check asks for it.
 *
 * No rrweb decoder is needed to produce it: `replay.bin` is exactly
 * `gzipSync(strToU8(JSON.stringify(payloads)))` (`packages/replay/src/encoder.ts:14-16`), so
 * `@bugsee/util`'s `gunzipSync` + `JSON.parse` recovers the ordered `eventWithTime[]` verbatim.
 */
export interface ReplayDigest {
  /** Size of `replay.bin` AS UPLOADED (still gzipped) — a non-zero value proves real bytes shipped. */
  gzippedBytes: number;
  /** Size of the decoded JSON — separates "a real stream" from "the two-byte gzip of `[]`". */
  decodedBytes: number;
  eventCount: number;
  /** Sorted unique rrweb `EventType` values present (2 = FullSnapshot, 3 = IncrementalSnapshot,
   *  4 = Meta — rrweb's own enum, which the SDK passes through untouched). */
  types: number[];
  /** Whether every event carries a numeric `timestamp` — the shape the dashboard's player requires. */
  allTimestamped: boolean;
  /** `needle -> does the decoded stream contain it literally`. Used for the masking assertions: the
   *  needle is searched in the RAW decoded JSON, so a leak anywhere in the stream (text node, input
   *  value, attribute) is caught, not only the field a structural walk happened to look at. */
  found: Record<string, boolean>;
}

export interface CapturedCall {
  seq: number;
  /** Wall-clock ms when the call completed — lets a reader tell two SEPARATELY-ASSEMBLED uploads of the
   *  same incident apart by their spacing (the S12 duplicate-delivery evidence in FINDINGS.md F-3). */
  t: number;
  kind: 'bundle-upload' | 'other';
  method: string;
  url: string;
  status: number;
  bundle?: ParsedBundleSummary;
}

// Generous headroom — the S4 storm alone can produce up to 100 admitted reports in one sweep.
const MAX_RECORDS = 2000;
const records: CapturedCall[] = [];
let seq = 0;

/** `seq -> the bundle's replay.bin bytes`, kept so `getReplayDigest()` can decode on demand. Bounded
 *  hard: replay.bin is the largest file in the bundle and the S4 storm uploads 100 bundles, so
 *  retaining every one would hold tens of MB in the page for no benefit — the S11 checks only ever
 *  read the most recent few. */
const MAX_REPLAY_BLOBS = 8;
const replayBlobs = new Map<number, Uint8Array>();

function classify(method: string): CapturedCall['kind'] {
  return method === 'PUT' ? 'bundle-upload' : 'other';
}

function parseBundle(body: Uint8Array, forSeq: number): ParsedBundleSummary | undefined {
  try {
    const files = unzipSync(body) as Record<string, Uint8Array>;
    const summary: ParsedBundleSummary = { files: Object.keys(files) };
    // S11: keep the raw bytes only — decoding happens in getReplayDigest(), on demand. See ReplayDigest.
    const replayFile = files['replay.bin'];
    if (replayFile !== undefined) {
      replayBlobs.set(forSeq, replayFile);
      while (replayBlobs.size > MAX_REPLAY_BLOBS) {
        // Map preserves insertion order, so the first key is the oldest retained bundle.
        replayBlobs.delete(replayBlobs.keys().next().value as number);
      }
    }
    const requestFile = files['request.json'];
    if (requestFile !== undefined) {
      summary.request = JSON.parse(strFromU8(requestFile)) as Record<string, unknown>;
    }
    const logsFile = files['logs.json'];
    if (logsFile !== undefined) {
      const logs = JSON.parse(strFromU8(logsFile)) as Array<{ message?: string; level?: unknown }>;
      summary.logMessages = logs.map((l) => l.message ?? '');
      summary.logEntries = logs;
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
    const manifestFile = files['manifest.json'];
    if (manifestFile !== undefined) {
      const manifest = JSON.parse(strFromU8(manifestFile)) as { attrs?: Record<string, unknown> };
      summary.attrs = manifest.attrs;
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
 *  verbatim; the tee only RECORDS a parsed copy, so wire-level assertions (redaction, labels, dedupe)
 *  can be made on exactly what the SDK sent, not on the scenario panel's own filter-callback log. */
// Same bound @bugsee/browser-utils' fetch-transport.ts applies (DEFAULT_TIMEOUT_MS = 30_000). Core
// never passes `timeoutMs` at any call site (bundle-uploader.ts, bugsee-api.ts) — it relies on the
// transport itself supplying the default. This tee stands in for that transport, so it must supply
// the same default rather than only bounding calls that happen to pass one explicitly: leaving it
// unbounded would mean every SDK call in this sample (issue-create, session POST, S3 PUT) never
// times out, and a half-open socket would wedge flush()/stop() forever — exactly the "interceptors
// must not alter app behaviour" hazard this sample exists to verify, applied to our own tee.
const DEFAULT_TIMEOUT_MS = 30_000;

export function createTeeTransport(): HttpTransport {
  return async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const init: RequestInit = { method, headers: options.headers, signal: AbortSignal.timeout(timeoutMs) };
    if (options.body !== undefined) {
      init.body = typeof options.body === 'string' ? options.body : new Uint8Array(options.body);
    }
    let res: Response;
    try {
      res = await fetch(url, init);
    } catch (error) {
      // Match fetch-transport.ts:45-47's error shape so callers (and this sample's assertions) see
      // the same timeout signature regardless of which transport is wired in.
      if (init.signal?.aborted) {
        throw new Error(`request to ${url} timed out after ${timeoutMs}ms`);
      }
      throw error;
    }
    const rawBuf = new Uint8Array(await res.arrayBuffer());
    const resHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      resHeaders[k] = v;
    });

    const kind = classify(method);
    const record: CapturedCall = { seq: (seq += 1), t: Date.now(), kind, method, url, status: res.status };
    if (kind === 'bundle-upload' && options.body !== undefined) {
      // The zip is the REQUEST body being PUT to the presigned S3 url, not the response (S3's PUT
      // response body is empty on success — parsing `rawBuf` here was a bug caught during this fix
      // pass: it silently produced 0 bundles, which is exactly the "everything still reads green"
      // failure mode this wire-level check exists to avoid).
      const bodyBytes =
        typeof options.body === 'string' ? new TextEncoder().encode(options.body) : options.body;
      record.bundle = parseBundle(bodyBytes, record.seq);
    }
    records.push(record);
    if (records.length > MAX_RECORDS) records.shift();

    return { status: res.status, headers: resHeaders, body: rawBuf };
  };
}

export function getCapturedBundles(): readonly CapturedCall[] {
  return records.filter((r) => r.kind === 'bundle-upload' && r.bundle !== undefined);
}

/**
 * Decode the `replay.bin` uploaded with bundle `seq` (S11). Returns `undefined` when that bundle
 * carried no replay file or its bytes are no longer retained (see MAX_REPLAY_BLOBS) — the caller
 * treats that as "no evidence", never as "verified".
 *
 * `needles` are searched LITERALLY in the decoded JSON, which is what makes the masking assertions
 * honest: a value that leaked into an attribute, a text node or an input value is caught wherever it
 * sits in the stream, without this harness having to model rrweb's node shapes.
 */
export function getReplayDigest(seq: number, needles: readonly string[] = []): ReplayDigest | undefined {
  const bytes = replayBlobs.get(seq);
  if (bytes === undefined) return undefined;
  const json = strFromU8(gunzipSync(bytes));
  const events = JSON.parse(json) as Array<{ type?: unknown; timestamp?: unknown }>;
  const found: Record<string, boolean> = {};
  for (const needle of needles) {
    // Search the needle BOTH verbatim and in its JSON-escaped form. Without the second form a
    // multi-line needle can never match — the stream is JSON, so a real newline in the recorded value
    // is stored as the two characters `\` `n`. MEASURED: with masking deliberately disabled, the note
    // body typed in this sample was reported ABSENT for the raw needle and PRESENT for the escaped
    // one, i.e. the masking assertion built on the raw form alone was passing vacuously. Same class of
    // defect this script's own audit block hunts — a check green because it can never go red.
    const escaped = JSON.stringify(needle).slice(1, -1);
    found[needle] = json.includes(needle) || json.includes(escaped);
  }
  return {
    gzippedBytes: bytes.length,
    decodedBytes: json.length,
    eventCount: events.length,
    types: [...new Set(events.map((e) => e.type))].filter((t): t is number => typeof t === 'number').sort((a, b) => a - b),
    allTimestamped: events.length > 0 && events.every((e) => typeof e.timestamp === 'number'),
    found,
  };
}

export function clearCapturedCalls(): void {
  records.length = 0;
  replayBlobs.clear();
}
