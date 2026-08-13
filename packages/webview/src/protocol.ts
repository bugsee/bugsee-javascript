import type { FileType } from '@bugsee/protocol';

// The JSON intrinsics, captured at MODULE LOAD (review round 1, SEV1).
//
// `JSON.parse` and `JSON.stringify` are page-writable globals. Reading them at call time let a script do:
//
//   const orig = JSON.parse;
//   JSON.parse = s => { if (s.includes('"k":"control"')) steal(orig(s).tok); return orig(s); };
//
// which reads the token out of NATIVE's control message — defeating D-A1, whose guarantee is stated
// only in outbound terms ("sent once, on hello"). The same trick on `stringify` (or an
// `Object.prototype.toJSON`) reads the outbound hello and can silently replace the payload.
//
// Capturing them here is not absolute — a script that runs before this module is evaluated still wins — but
// this module is part of the SDK bundle, so it loads with the SDK rather than at first use.
const jsonParse = JSON.parse;
const jsonStringify = JSON.stringify;

// The versioned wire protocol crossing the WebView boundary (docs/design/webview-bridge.md §6). A single,
// transport-agnostic JSON envelope rides whichever channel is available (Android @JavascriptInterface /
// WebMessageChannel; later iOS/Cordova). Every message carries `b` (the protocol version) — its presence also
// tags the message as Bugsee's on a shared channel. JS→native: hello | entry | batch | report | secure | bye.
// native→JS: control (parsed here; applied by the control channel). Unknown fields/kinds are ignored by the
// receiver (forward-compatible). This module is PURE — builders + encode + a defensive control parse.
//
// These TS types are the CANONICAL emitter shapes; their machine-checkable mirror — the cross-language artifact
// handed to the native receiver team — is `bridge-protocol.schema.json` (this package), validated end-to-end by
// the conformance harness (instrumentation-tests/test/webview-conformance.e2e.ts). Keep the three in lockstep.

/** The current bridge protocol version. */
export const PROTOCOL_VERSION = 1;

/** Message kinds on the wire. */
export type BridgeMessageKind =
  | 'hello'
  | 'entry'
  | 'batch'
  | 'report'
  | 'secure'
  | 'control'
  | 'bye';

/** A distributed-trace join (FE↔native↔backend): `t` = traceId, `s` = spanId. */
export interface TraceRef {
  readonly t: string;
  readonly s: string;
}

/** JS→native: the opening handshake declaring the SDK version, its capabilities, and its session id. */
export interface HelloMessage {
  readonly b: number;
  readonly k: 'hello';
  /** The JS SDK version. */
  readonly sdk: string;
  /** Capabilities the SDK provides (FileTypes it emits + features like `obscuring`) — drives negotiation. */
  readonly caps: readonly string[];
  /** The JS-side session id (until native supplies its own via the control reply). */
  readonly session: string;
  /**
   * SUPERSEDED by D-A10 — a native receiver MUST NOT store or echo this.
   *
   * It is minted by this SDK and published here so native could learn it, which authenticates nobody:
   * `hello` arrives on the same `@JavascriptInterface` any frame can post to, so native cannot tell it from
   * a token a page script minted. That is why the channel had to start open and wait to latch, and why a
   * script could stop capture inside that window. Native mints its OWN secret instead and delivers it
   * inside the bundle it injects — see {@link ControlMessage.tok}.
   *
   * Still emitted only when no `controlNonce` was injected, i.e. against a host that predates D-A10.
   */
  readonly tok?: string;
}

/** JS→native: one streamed capture entry. `p` is the entry's serialized form (type-specific; per-FileType
 *  payload shaping is slice 2 — here `p` is the store's `StoredEntry.serialized`, opaque to this layer). */
export interface EntryMessage {
  readonly b: number;
  readonly k: 'entry';
  /** Which capture stream this entry belongs to (native routes by it). */
  readonly t: FileType;
  /** Monotonic sequence per session — ordering + dedup. */
  readonly s: number;
  /** Wall-clock unix-ms at capture. */
  readonly ts: number;
  /** `performance.now()` at capture (paired with `o` for native time-base mapping). */
  readonly mono: number;
  /** `performance.timeOrigin`. */
  readonly o: number;
  /** Redaction provenance: did a JS-side filter pass run before this crossed? (D3) */
  readonly red: boolean;
  /** Optional distributed-trace join. */
  readonly tr?: TraceRef;
  /** The entry's ALREADY-serialized payload JSON (the store's `StoredEntry.serialized`). `encode` splices this
   *  in VERBATIM as the wire `p`, so on the wire `p` is an INLINE object (native parses it once), not a
   *  re-encoded string. */
  readonly p: string;
}

/** One secure area native must MASK in its rendered frame — a sensitive input / `.bugsee-hide` element's
 *  viewport rect. JS cannot redact native-rendered pixels, so it only streams the rects; native masks them. */
export interface SecureArea {
  /** `text` = a secure input field; `hidden` = an explicitly `.bugsee-hide`-marked element. */
  readonly type: 'text' | 'hidden';
  readonly top: number;
  readonly left: number;
  readonly bottom: number;
  readonly right: number;
}

/** JS→native: the current set of secure-area rects to mask. A current native receiver DISCARDS this payload and
 *  re-pulls `__bugsee_bridge.snapshot()` instead (D-A9); an older one applies the LATEST (by `s`).
 *  Also returned synchronously by `__bugsee_bridge.snapshot()` at native frame-capture time. */
export interface SecureMessage {
  readonly b: number;
  readonly k: 'secure';
  readonly s: number;
  readonly ts: number;
  readonly mono: number;
  readonly o: number;
  /** The serialized {@link SecureArea}`[]`. */
  readonly p: string;
}

/** JS→native: a WebView-originated report TRIGGER (D5 — gated by `reportTrigger`). Native opens a bug from the
 *  serialized `ReportingRequest` metadata in `p`. Same time/seq frame as an entry, with `k:'report'`. */
export interface ReportMessage {
  readonly b: number;
  readonly k: 'report';
  /** The incident file type (`crash`). */
  readonly t: FileType;
  readonly s: number;
  readonly ts: number;
  readonly mono: number;
  readonly o: number;
  readonly red: boolean;
  readonly tr?: TraceRef;
  /** The serialized report metadata (the `ReportingRequest`). */
  readonly p: string;
}

/** JS→native: many entries coalesced into one crossing (logs/network can be high-volume). */
export interface BatchMessage {
  readonly b: number;
  readonly k: 'batch';
  readonly e: readonly EntryMessage[];
}

/** JS→native: teardown signal (pagehide / stop) so native can finalize. */
export interface ByeMessage {
  readonly b: number;
  readonly k: 'bye';
}

/** The config native pushes to the JS SDK via the control reply (slice 1 subset — grows in slice 3). */
export interface ControlConfig {
  /** The capture FileTypes native wants (others are suppressed). */
  readonly enabledTypes?: readonly FileType[];
  /** Whether the WebView may emit report triggers (D5 — default off). */
  readonly reportTrigger?: boolean;
}

/** native→JS: the handshake reply + ongoing control commands. */
export interface ControlMessage {
  /** Protocol version — REQUIRED (its presence tags the message as Bugsee's on a shared inbound channel). */
  readonly b: number;
  readonly k: 'control';
  /** The protocol version native accepted (≤ the SDK's). */
  readonly accept?: number;
  /** The native session id to tag entries with. */
  readonly session?: string;
  /** Config push (handshake reply + on change). */
  readonly config?: ControlConfig;
  /** A one-shot command (pause/resume/flush/stop/snapshot — handled in slice 3). */
  readonly command?: 'pause' | 'resume' | 'flush' | 'stop' | 'snapshot';
  /**
   * The control secret NATIVE minted (D-A10), interpolated into the bundle native injects so it reaches
   * this SDK by a route the page never observes. Required on EVERY control message, from the first —
   * `__bugsee_bridge.control(...)` is page-callable, so there is no open period and no latch to race.
   *
   * NOT derived from {@link HelloMessage.tok}, which any page script can mint. Also distinct from the
   * capture nonce `n`: that one necessarily travels the wire, so sharing them would let a script tapping
   * the outgoing stream send commands. Applies only to a host that injected no nonce; a current native
   * receiver echoes no `hello.tok` at all.
   */
  readonly tok?: string;
}

/** Build a `hello` handshake message. */
export function helloMessage(opts: {
  sdk: string;
  caps: readonly string[];
  session: string;
  /** The per-session control token (Wave 0.3 / D-A1). Omitted → no `tok` field, i.e. the pre-token wire. */
  token?: string;
}): HelloMessage {
  return {
    b: PROTOCOL_VERSION,
    k: 'hello',
    sdk: opts.sdk,
    caps: opts.caps,
    session: opts.session,
    ...(opts.token !== undefined ? { tok: opts.token } : {}),
  };
}

/** Build an `entry` message from a serialized capture record + its time/seq/redaction context. */
export function entryMessage(opts: {
  type: FileType;
  seq: number;
  timestamp: number;
  mono: number;
  timeOrigin: number;
  payload: string;
  redacted: boolean;
  trace?: TraceRef;
}): EntryMessage {
  return {
    b: PROTOCOL_VERSION,
    k: 'entry',
    t: opts.type,
    s: opts.seq,
    ts: opts.timestamp,
    mono: opts.mono,
    o: opts.timeOrigin,
    red: opts.redacted,
    ...(opts.trace !== undefined ? { tr: opts.trace } : {}),
    p: opts.payload,
  };
}

/** Build a `report` trigger message (D5-gated) from serialized report metadata + its time/seq context. */
export function reportMessage(opts: {
  type: FileType;
  seq: number;
  timestamp: number;
  mono: number;
  timeOrigin: number;
  payload: string;
  redacted: boolean;
  trace?: TraceRef;
}): ReportMessage {
  return {
    b: PROTOCOL_VERSION,
    k: 'report',
    t: opts.type,
    s: opts.seq,
    ts: opts.timestamp,
    mono: opts.mono,
    o: opts.timeOrigin,
    red: opts.redacted,
    ...(opts.trace !== undefined ? { tr: opts.trace } : {}),
    p: opts.payload,
  };
}

/** Build a `secure` message from the serialized secure-area rects + its time/seq context. */
export function secureMessage(opts: {
  seq: number;
  timestamp: number;
  mono: number;
  timeOrigin: number;
  payload: string;
}): SecureMessage {
  return {
    b: PROTOCOL_VERSION,
    k: 'secure',
    s: opts.seq,
    ts: opts.timestamp,
    mono: opts.mono,
    o: opts.timeOrigin,
    p: opts.payload,
  };
}

/** Coalesce entries into a single `batch` message. */
export function batchMessage(entries: readonly EntryMessage[]): BatchMessage {
  return { b: PROTOCOL_VERSION, k: 'batch', e: entries };
}

/** Build a `bye` teardown message. */
export function byeMessage(): ByeMessage {
  return { b: PROTOCOL_VERSION, k: 'bye' };
}

/**
 * Serialize a message to its wire string. Entry/report/secure carry an opaque, ALREADY-serialized payload (`p`
 * = the store's `StoredEntry.serialized`); we splice those bytes in VERBATIM as the raw `p` value rather than
 * `JSON.stringify`-ing them into a quoted string. So the payload is serialized exactly ONCE (by the aggregator)
 * and appears INLINE on the wire (an object/array), letting native parse the whole message once — no nested
 * second parse (docs/design/webview-bridge.md §6.1). `batch` splices each element the same way; `hello`/`bye`
 * have no opaque payload, so plain `JSON.stringify`.
 */
export function encode(
  message: HelloMessage | EntryMessage | ReportMessage | SecureMessage | BatchMessage | ByeMessage,
): string {
  switch (message.k) {
    case 'entry':
    case 'report':
    case 'secure':
      return spliceRawPayload(message);
    case 'batch':
      return `{"b":${message.b},"k":"batch","e":[${message.e.map(spliceRawPayload).join(',')}]}`;
    default:
      return jsonStringify(message);
  }
}

/**
 * Encode an envelope whose `p` is the already-serialized payload JSON, splicing `p` in verbatim (unescaped) as
 * an inline value. Only the small primitive envelope goes through `JSON.stringify` (escape-safe, cannot throw on
 * the payload); the pre-validated payload bytes are appended raw.
 */
function spliceRawPayload(message: EntryMessage | ReportMessage | SecureMessage): string {
  const { p, ...envelope } = message;
  const head = jsonStringify(envelope);
  return `${head.slice(0, -1)},"p":${p}}`;
}

/** Defensively parse a native→JS `control` message; returns `undefined` for non-JSON, a non-object, a message
 *  whose `k` is not `control`, OR one missing the `b` protocol-version tag — so a foreign message on a shared
 *  inbound channel (e.g. the WebMessageChannel) is ignored, not just one with the wrong `k`. */
export function parseControl(raw: string): ControlMessage | undefined {
  let parsed: unknown;
  try {
    parsed = jsonParse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  // Cut the prototype chain BEFORE any field is read (review round 1, SEV1). Every subsequent read —
  // `k`, `b`, `tok`, `command`, `config`, `session` — is a plain property lookup, so without this a single
  // line of page script forges an authenticated message by riding native's own:
  //
  //   Object.prototype.command = 'stop';   // read off a legitimately-tokened control -> SDK torn down
  //   Object.prototype.tok = 'x';          // makes every LEGACY (untokened) control look like an attack
  //
  // `JSON.parse` never produces inherited own-properties, so nulling the prototype cannot discard anything
  // native actually sent. `config` is nulled too — `reportTrigger` is read off it, and it is the quiet half
  // of this attack (the WebView opens native bug reports at will, past the D5 gate).
  Object.setPrototypeOf(parsed, null);
  const config = (parsed as { config?: unknown }).config;
  if (typeof config === 'object' && config !== null) {
    Object.setPrototypeOf(config, null);
  }
  const m = parsed as { k?: unknown; b?: unknown };
  if (m.k !== 'control' || typeof m.b !== 'number') {
    return undefined;
  }
  return parsed as ControlMessage;
}
