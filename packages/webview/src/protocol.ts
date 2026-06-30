import type { FileType } from '@bugsee/protocol';

// The versioned wire protocol crossing the WebView boundary (docs/design/webview-bridge.md §6). A single,
// transport-agnostic JSON envelope rides whichever channel is available (Android @JavascriptInterface /
// WebMessageChannel; later iOS/Cordova). Every message carries `b` (the protocol version) — its presence also
// tags the message as Bugsee's on a shared channel. JS→native: hello | entry | batch | bye (+ report, gated,
// slice-2). native→JS: control (parsed here; applied by the control channel). Unknown fields/kinds are ignored
// by the receiver (forward-compatible). This module is PURE — builders + encode + a defensive control parse.

/** The current bridge protocol version. */
export const PROTOCOL_VERSION = 1;

/** Message kinds on the wire. */
export type BridgeMessageKind = 'hello' | 'entry' | 'batch' | 'report' | 'control' | 'bye';

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
  /** The entry's serialized payload. */
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
}

/** Build a `hello` handshake message. */
export function helloMessage(opts: {
  sdk: string;
  caps: readonly string[];
  session: string;
}): HelloMessage {
  return { b: PROTOCOL_VERSION, k: 'hello', sdk: opts.sdk, caps: opts.caps, session: opts.session };
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

/** Coalesce entries into a single `batch` message. */
export function batchMessage(entries: readonly EntryMessage[]): BatchMessage {
  return { b: PROTOCOL_VERSION, k: 'batch', e: entries };
}

/** Build a `bye` teardown message. */
export function byeMessage(): ByeMessage {
  return { b: PROTOCOL_VERSION, k: 'bye' };
}

/** Serialize a message to its wire string. */
export function encode(message: HelloMessage | EntryMessage | BatchMessage | ByeMessage): string {
  return JSON.stringify(message);
}

/** Defensively parse a native→JS `control` message; returns `undefined` for non-JSON, a non-object, a message
 *  whose `k` is not `control`, OR one missing the `b` protocol-version tag — so a foreign message on a shared
 *  inbound channel (e.g. the WebMessageChannel) is ignored, not just one with the wrong `k`. */
export function parseControl(raw: string): ControlMessage | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const m = parsed as { k?: unknown; b?: unknown };
  if (m.k !== 'control' || typeof m.b !== 'number') {
    return undefined;
  }
  return parsed as ControlMessage;
}
