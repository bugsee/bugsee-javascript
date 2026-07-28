// The Electron renderer↔main wire codec. Main and renderers run the SAME @bugsee/electron version (shipped
// together), so — unlike the WebView bridge's versioned native protocol — this is a plain same-version JSON
// envelope. Three kinds:
//   `entry`   renderer→main: a streamed capture record with the already-serialized payload SPLICED in verbatim
//             (serialize once on the hot path, never walk/escape the payload), decoded main-side into the
//             fields the aggregator needs.
//   `control` main→renderer: pause/resume/flush/stop + the `session` handshake reply (carries the session id).
//   `hello`   renderer→main: the handshake request that prompts the main's `session` reply.
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
// to recover (docs/review/electron.md SEV1 #1).

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
  return {
    type: message.t,
    seq,
    timestamp,
    mono,
    timeOrigin,
    redacted: message.red ?? false,
    // Re-serialize the payload for the aggregator's `StoredEntry.serialized` (main-side, off the hot path).
    payload: JSON.stringify(message.p),
  };
}

/** The main→renderer control commands. `pause`/`resume`/`flush`/`stop` reuse the WebView control kinds;
 *  `session` is the handshake reply assigning the owner's session id to a renderer. */
export type ControlCommand = 'pause' | 'resume' | 'flush' | 'stop' | 'session';

const CONTROL_COMMANDS: ReadonlySet<string> = new Set([
  'pause',
  'resume',
  'flush',
  'stop',
  'session',
]);

export interface ControlMessage {
  command: ControlCommand;
  /** The assigned session id — set only on the `session` handshake reply. */
  sessionId?: string;
}

/** Encode a control message to a wire string (`sessionId` omitted unless present). */
export function encodeControl(message: ControlMessage): string {
  const wire: { k: 'control'; c: ControlCommand; sid?: string } = {
    k: 'control',
    c: message.command,
  };
  if (message.sessionId !== undefined) {
    wire.sid = message.sessionId;
  }
  return JSON.stringify(wire);
}

interface WireControl {
  k?: string;
  c?: string;
  sid?: string;
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
  if (message.sid !== undefined) {
    decoded.sessionId = message.sid;
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
