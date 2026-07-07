// @bugsee/replay — the replay encoder (RP3, design D5-revised). Produces `replay.bin`: the gzipped rrweb
// event stream the dashboard's rrweb player consumes (ungzip → JSON.parse → events).
//
// A stateless SYNCHRONOUS function (fflate `gzipSync`) — masking is applied during RECORDING, not encoding,
// so no options/init are needed, and a one-shot gzip at incident time keeps the bundle assembler pure/sync
// (D5-revised). Registered as the assembler's `fileEncoders.replay` at launch wiring (RP5).
import { gzipSync, strToU8 } from 'fflate';

/**
 * Encode the captured rrweb event payloads to the gzipped `replay.bin` bytes. `payloads` is the ordered list
 * of `eventWithTime` (the `replay` capture entries' `data`). Signature matches the core assembler's
 * `fileEncoders` entry: `(payloads: unknown[]) => Uint8Array`.
 */
export function encodeReplay(payloads: unknown[]): Uint8Array {
  return gzipSync(strToU8(JSON.stringify(payloads)));
}
