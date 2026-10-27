// The Electron renderer↔main wire codec. Main and renderers run the SAME @bugsee/electron version (shipped
// together), so — unlike the WebView bridge's versioned native protocol — this is a plain same-version JSON
// envelope. Three kinds:
//   `entry`   renderer→main: a streamed capture record with the already-serialized payload SPLICED in verbatim
//             (serialize once on the hot path, never walk/escape the payload), decoded main-side into the
//             fields the aggregator needs.
//   `control` main→renderer: pause/resume/flush/stop + the `session` handshake reply (carries the session id).
//   `hello`   renderer→main: the handshake request that prompts the main's `session` reply.

import { sanitizeTraceNames } from '@bugsee/capture';
import type { StreamingCaptureEntry } from '@bugsee/core';
import { DEFAULT_FILENAMES, type FileType } from '@bugsee/protocol';

/** A decoded streamed entry (the main receiver's view). `payload` is re-serialized for `StoredEntry.serialized`. */
export interface DecodedStreamEntry {
  type: FileType;
  seq: number;
  timestamp: number;
  mono: number;
  timeOrigin: number;
  redacted: boolean;
  payload: string;
}

/** Encode a streaming capture entry to a wire string, splicing the already-serialized payload in verbatim. */
export function encodeStreamEntry(entry: StreamingCaptureEntry): string {
  const head = JSON.stringify({
    k: 'entry',
    t: entry.type,
    s: entry.seq,
    ts: entry.timestamp,
    mono: entry.mono,
    o: entry.timeOrigin,
    red: entry.redacted,
  });
  // Splice the payload as the raw JSON value of `p` (no re-parse/escape of the payload on the hot path).
  return `${head.slice(0, -1)},"p":${entry.payload}}`;
}

interface WireEntry {
  k?: string;
  t?: FileType;
  s?: number;
  ts?: number;
  mono?: number;
  o?: number;
  red?: boolean;
  p?: unknown;
}

// ---------------------------------------------------------------------------------------------------
// Renderer input is UNTRUSTED. The preload exposes `post()` to the page's main world, so anything an
// XSS or a compromised renderer-side dependency can reach is attacker-controlled. Two fields are
// security-critical because they leave the SDK's own data structures:
//
//   `t` — becomes `StoredEntry.type`, which the disk-backed chunk store (the DEFAULT on Electron main)
//         `path.join`s into a filename. An unvalidated value escapes the capture root with `..`, giving
//         an append-only arbitrary file write with attacker-controlled content — code execution as the
//         user once it targets a shell rc file or any `.js` the app loads.
//   `ts` — is written verbatim into the frame `${timestamp}\t${serialized}\n`, so a string with
//         newlines injects records.
//
// Both are therefore validated against a closed set / a numeric check, and a message failing either is
// DROPPED rather than sanitised: a renderer sending them is misbehaving, and there is no correct entry
// to recover.

/** Every FileType the SDK emits — the closed set `t` must belong to. */
const KNOWN_FILE_TYPES: ReadonlySet<string> = new Set<string>([
  ...Object.keys(DEFAULT_FILENAMES),
  'attachment', // the one FileType with no default filename
]);

function isKnownFileType(value: unknown): value is FileType {
  return typeof value === 'string' && KNOWN_FILE_TYPES.has(value);
}

/** `undefined` input → 0 (the field is optional); a present-but-non-finite value → `undefined` (reject). */
function optionalFiniteNumber(value: unknown): number | undefined {
  if (value === undefined) return 0;
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Decode a wire string into a {@link DecodedStreamEntry}, or `undefined` if it isn't a valid `entry`. */
export function decodeStreamEntry(raw: string): DecodedStreamEntry | undefined {
  let message: WireEntry;
  try {
    message = JSON.parse(raw) as WireEntry;
  } catch {
    return undefined;
  }
  // The PARSE succeeding does not mean an object came back. `JSON.parse('null')` yields `null`, and
  // `JSON.parse('1')` a number, so reading `.k` off the result threw a TypeError for input a renderer can
  // post trivially. The receiver happens to catch, which downgraded it to an onError, but this function's
  // contract is `… | undefined` and a decoder at a trust boundary that throws is a hazard for the next
  // caller that does not wrap it.
  if (message === null || typeof message !== 'object') {
    return undefined;
  }
  if (message.k !== 'entry' || !isKnownFileType(message.t)) {
    return undefined;
  }
  // Numeric fields are VALIDATED, not coerced. `timestamp` is written verbatim into the on-disk frame
  // (`${timestamp}\t${serialized}\n`), so a string containing newlines injects records — the proven
  // exploit used exactly that to smuggle a shell script into the file it escaped to.
  const seq = optionalFiniteNumber(message.s);
  const timestamp = optionalFiniteNumber(message.ts);
  const mono = optionalFiniteNumber(message.mono);
  const timeOrigin = optionalFiniteNumber(message.o);
  if (
    seq === undefined ||
    timestamp === undefined ||
    mono === undefined ||
    timeOrigin === undefined
  ) {
    return undefined;
  }
  // `JSON.stringify(undefined)` returns undefined, NOT a string — so an omitted or unserialisable `p` would
  // break this function's own `payload: string` contract and reach `store.add` with a non-string
  // `serialized`, throwing out of the ipcMain listener.
  // Validate rather than trust the declared type: `p` is untrusted renderer input like every other field.
  const payload = JSON.stringify(message.p);
  if (typeof payload !== 'string') {
    return undefined;
  }
  return {
    type: message.t,
    seq,
    timestamp,
    mono,
    timeOrigin,
    redacted: message.red ?? false,
    // Re-serialize the payload for the aggregator's `StoredEntry.serialized` (main-side, off the hot path).
    payload,
  };
}

// ---------------------------------------------------------------------------------------------------
// The renderer→main REPORT message.
//
// A DEDICATED kind, not an `entry`. The first design draft reused `entry` with `type: 'crash'` to avoid a
// protocol change — but the codec is same-version by declaration (see the file header), so a new kind costs
// nothing, and reusing `entry` was actively harmful: `main-receiver` store.adds every entry BEFORE the join
// callback, so the incident would land in the main rolling capture store and the assembler would emit TWO
// files named `crash.json` — one array-shaped — with the stale entry polluting every later bundle in the
// 60 s window. WebView splits `entryMessage`/`reportMessage` for the same reason.

/** A decoded renderer incident: the `{ source, report }` pair the main side submits as a ReportingRequest. */
export interface DecodedReport {
  /** The ReportingRequest source (mechanism / origin) as serialized by the renderer. */
  source: Record<string, unknown>;
  /** The Report payload. */
  report: Record<string, unknown>;
  /** Wall-clock ms when the renderer raised it. */
  timestamp: number;
}

/** Encode a renderer incident for the main process. */
export function encodeReport(source: unknown, report: unknown, timestamp: number): string {
  return JSON.stringify({ k: 'report', p: { source, report }, ts: timestamp });
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Decode a renderer incident, or `undefined` if it is not a well-formed `report`.
 *
 * Renderer input is UNTRUSTED — the same channel and the same sender as the entry path hardened earlier.
 * Both halves of the payload must be plain objects; anything else is
 * dropped rather than submitted, since a malformed incident has no correct interpretation.
 */
export function decodeReport(raw: string): DecodedReport | undefined {
  let message: { k?: string; p?: unknown; ts?: unknown };
  try {
    message = JSON.parse(raw) as typeof message;
  } catch {
    return undefined;
  }
  // Same as `decodeStreamEntry`: a successful parse can still yield `null` or a primitive.
  if (message === null || typeof message !== 'object') {
    return undefined;
  }
  if (message.k !== 'report' || !isPlainObject(message.p)) {
    return undefined;
  }
  const { source, report } = message.p;
  if (!isPlainObject(source) || !isPlainObject(report)) {
    return undefined;
  }
  const timestamp = message.ts === undefined ? 0 : message.ts;
  if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
    return undefined;
  }
  return { source, report, timestamp };
}

/** True iff `raw` is a report message (so the receiver can route it without decoding twice). */
export function isReport(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { k?: string }).k === 'report';
  } catch {
    return false;
  }
}

/** The main→renderer control commands. `pause`/`resume`/`flush`/`stop` reuse the WebView control kinds;
 *  `session` is the handshake reply assigning the owner's session id to a renderer. */
export type ControlCommand =
  | 'pause'
  | 'resume'
  | 'flush'
  | 'stop'
  | 'session'
  | 'blackout-start'
  | 'blackout-end'
  | 'window-key';

const CONTROL_COMMANDS: ReadonlySet<string> = new Set([
  'pause',
  'resume',
  'flush',
  'stop',
  'session',
  'blackout-start',
  'blackout-end',
  'window-key',
]);

export interface ControlMessage {
  command: ControlCommand;
  /** The assigned session id — set only on the `session` handshake reply. */
  sessionId?: string;
  /**
   * The main client's blackout state at handshake time — set only on the `session` reply. A renderer that
   * launches while main is blacked out must learn it from the reply (a broadcast sent before it said hello
   * never reached it).
   */
  blackout?: boolean;
  /**
   * The trace names the HOST (main) owns, set only on the `session` reply: the renderer must not write them (one writer per
   * name per session). An empty array is a real declaration ("owns nothing"); absent means the host said nothing and the
   * renderer keeps its built-in default.
   */
  hostOwnedTraces?: string[];
  /**
   * Whether the receiving renderer's window is the session's KEY window (spec "Several windows in one session"): only the
   * key window writes the per-window traces. Set on the `session` reply (absent = main cannot resolve windows, so every
   * renderer is key) and on every `window-key` command, which main sends when the answer CHANGES for that renderer.
   */
  keyWindow?: boolean;
}

/** Encode a control message to a wire string (`sessionId` omitted unless present). */
export function encodeControl(message: ControlMessage): string {
  const wire: {
    k: 'control';
    c: ControlCommand;
    sid?: string;
    bo?: boolean;
    ho?: string[];
    kw?: boolean;
  } = {
    k: 'control',
    c: message.command,
  };
  if (message.sessionId !== undefined) {
    wire.sid = message.sessionId;
  }
  if (message.blackout !== undefined) {
    wire.bo = message.blackout;
  }
  if (message.hostOwnedTraces !== undefined) {
    wire.ho = [...message.hostOwnedTraces];
  }
  if (message.keyWindow !== undefined) {
    wire.kw = message.keyWindow;
  }
  return JSON.stringify(wire);
}

interface WireControl {
  k?: string;
  c?: string;
  sid?: unknown;
  bo?: unknown;
  ho?: unknown;
  kw?: unknown;
}

/** Decode a control wire string into a {@link ControlMessage}, or `undefined` if it isn't a valid control. */
export function decodeControl(raw: string): ControlMessage | undefined {
  let message: WireControl;
  try {
    message = JSON.parse(raw) as WireControl;
  } catch {
    return undefined;
  }
  if (message.k !== 'control' || message.c === undefined || !CONTROL_COMMANDS.has(message.c)) {
    return undefined;
  }
  const decoded: ControlMessage = { command: message.c as ControlCommand };
  if (typeof message.sid === 'string') {
    decoded.sessionId = message.sid;
  }
  if (typeof message.bo === 'boolean') {
    decoded.blackout = message.bo;
  }
  if (typeof message.kw === 'boolean') {
    decoded.keyWindow = message.kw;
  }
  // validated as a unit: a malformed declaration is ignored whole, never half applied
  const hostOwned = sanitizeTraceNames(message.ho);
  if (hostOwned !== undefined) {
    decoded.hostOwnedTraces = hostOwned;
  }
  return decoded;
}

/** Encode the renderer→main handshake request. */
export function encodeHello(): string {
  return JSON.stringify({ k: 'hello' });
}

/** True iff `raw` is a hello handshake request. */
export function isHello(raw: string): boolean {
  try {
    return (JSON.parse(raw) as { k?: string }).k === 'hello';
  } catch {
    return false;
  }
}
