import type { CaptureDataEntry } from './contracts';

// A STREAMING per-type binary encoder (the replay's `replay.bin`): the streaming assembler feeds it the type's entries one
// at a time and writes whatever bytes it returns into the bundle member straight away, so the type's whole payload list is
// never held. It is the streaming sibling of `fileEncoders` (which takes every payload at once and stays for encoders that
// cannot stream); a type with both uses this one. Core stays codec-free: the platform/extension provides the encoder.

/** The export's time plan: what the report is meant to cover. `start` is absent when the store could not say. */
export interface ExportPlan {
  readonly start: number | undefined;
  readonly end: number;
}

/** One export of one type. */
export interface StreamEncoderSession {
  /** Take the next entry (oldest first). Returns zero or more output chunks. May throw: that entry is skipped and reported. */
  write(entry: CaptureDataEntry): Uint8Array[];
  /**
   * No more entries: the trailing chunks. A session that returned no chunk at all (from `write` or `end`) produced nothing
   * usable, and the member and its manifest entry are omitted: an encoder with nothing to say must stay silent from the start.
   * A throwing `end()` fails the whole bundle (a half-written member cannot be taken back).
   */
  end(): Uint8Array[];
}

export interface FileStreamEncoder {
  begin(plan: ExportPlan): StreamEncoderSession;
}
