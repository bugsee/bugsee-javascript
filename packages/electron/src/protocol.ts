// The Electron renderer→main wire codec. Main and renderers run the SAME @bugsee/electron version (shipped
// together), so — unlike the WebView bridge's versioned native protocol — this is a plain same-version JSON
// envelope: an `entry` (a streamed capture record) with the already-serialized payload SPLICED in verbatim
// (serialize once on the hot path, never walk/escape the payload), decoded on the main side into the fields
// the aggregator needs. Kept minimal; report/control kinds are added by later slices.
import type { StreamingCaptureEntry } from '@bugsee/core';
import type { FileType } from '@bugsee/protocol';

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

/** Decode a wire string into a {@link DecodedStreamEntry}, or `undefined` if it isn't a valid `entry`. */
export function decodeStreamEntry(raw: string): DecodedStreamEntry | undefined {
  let message: WireEntry;
  try {
    message = JSON.parse(raw) as WireEntry;
  } catch {
    return undefined;
  }
  if (message.k !== 'entry' || message.t === undefined) {
    return undefined;
  }
  return {
    type: message.t,
    seq: message.s ?? 0,
    timestamp: message.ts ?? 0,
    mono: message.mono ?? 0,
    timeOrigin: message.o ?? 0,
    redacted: message.red ?? false,
    // Re-serialize the payload for the aggregator's `StoredEntry.serialized` (main-side, off the hot path).
    payload: JSON.stringify(message.p),
  };
}
