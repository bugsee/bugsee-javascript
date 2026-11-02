// @bugsee/replay — the STREAMING replay encoder: `replay.bin` built one event at a time (core's FileStreamEncoder), so
// a report never holds the window's rrweb events. Same bytes shape as `encodeReplay` (a gzip of the JSON event array),
// plus the two repairs the retained window needs:
//
//  * Orphan trim. rrweb events only mean something on top of a Meta (4) + FullSnapshot (2) base. The store keeps whole
//    base segments, but the oldest part may still start mid-segment, and a player would apply such events to the wrong DOM.
//    Everything before the first Meta that is IMMEDIATELY followed by a FullSnapshot is dropped. No such pair at all means
//    the encoder never writes a byte (the member is omitted).
//  * Clamp. The store keeps the base that the window's first events depend on even though it is older than the window.
//    Events older than the plan start are written with `timestamp = plan.start`, in order: replaying them at one instant
//    reproduces the page state at the window start, and the player's timeline equals the report's.
import type { ExportPlan, FileStreamEncoder, StreamEncoderSession } from '@bugsee/core';
import { Gzip, strToU8 } from 'fflate';

const META = 4;
const FULL_SNAPSHOT = 2;

const typeOf = (event: unknown): number | undefined =>
  typeof event === 'object' && event !== null ? (event as { type?: number }).type : undefined;

function clamp(event: unknown, start: number | undefined): unknown {
  if (start === undefined || typeof event !== 'object' || event === null) {
    return event;
  }
  return (event as { timestamp: number }).timestamp < start
    ? { ...event, timestamp: start }
    : event;
}

function beginSession(plan: ExportPlan): StreamEncoderSession {
  let out: Uint8Array[] = [];
  let gzip: Gzip | undefined;
  let count = 0;
  let pendingMeta: unknown;
  let hasPendingMeta = false;
  let ended = false;

  const text = (event: unknown): string => JSON.stringify(clamp(event, plan.start)) ?? 'null';
  // Writes already-serialized events: serializing happens BEFORE anything is written, so a record that cannot be
  // serialized (a cycle, a BigInt) leaves the stream untouched instead of half of a base pair behind.
  const emit = (...texts: string[]): void => {
    if (gzip === undefined) {
      gzip = new Gzip();
      gzip.ondata = (chunk) => {
        out.push(chunk);
      };
    }
    for (const item of texts) {
      gzip.push(strToU8((count === 0 ? '[' : ',') + item));
      count += 1;
    }
  };
  const drain = (): Uint8Array[] => {
    const chunks = out;
    out = [];
    return chunks;
  };

  return {
    write(entry): Uint8Array[] {
      if (ended) {
        return []; // a finished gzip stream takes no more input
      }
      const event = entry.data;
      if (count === 0) {
        // Still looking for the base: only a Meta directly followed by a FullSnapshot opens it.
        const type = typeOf(event);
        if (type === META) {
          pendingMeta = event;
          hasPendingMeta = true;
        } else if (type === FULL_SNAPSHOT && hasPendingMeta) {
          emit(text(pendingMeta), text(event));
          hasPendingMeta = false;
          pendingMeta = undefined;
        } else {
          hasPendingMeta = false;
          pendingMeta = undefined;
        }
      } else {
        emit(text(event));
      }
      return drain();
    },
    end(): Uint8Array[] {
      if (ended) {
        return [];
      }
      ended = true;
      if (gzip !== undefined) {
        gzip.push(strToU8(']'), true);
      }
      return drain();
    },
  };
}

/** The streaming replay encoder to register as the assembler's `streamEncoders.replay`. */
export function createReplayStreamEncoder(): FileStreamEncoder {
  return { begin: beginSession };
}
