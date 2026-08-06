// @bugsee/replay — the wiring entry (RP5b). `registerReplay` composes the built pieces into a launched
// client: it creates the rrweb recorder capture-provider (with the fail-closed masking) + installs it
// (`client.addCaptureProvider`), and registers the `replay.bin` encoder into the client's shared
// `fileEncoders` map (read at each report's bundle assembly, RP5a). The browser launch lazy-`import()`s this
// module + calls `registerReplay` when the `replay` option is truthy (RP5c). Returns the recorder so the
// caller can wire `client.startBlackout` → its blackout controls.
import type { CaptureProvider } from '@bugsee/core';
import { record as rrwebRecord } from '@bugsee/rrweb';
import { encodeReplay } from './encoder';
import { type ReplayMaskingOptions, resolveReplayMaskingOptions } from './masking';
import {
  type CanvasRecordConfig,
  createReplayCaptureProvider,
  type ReplayRecorder,
  type ReplayRecordFn,
} from './recorder';

/** The client surface `registerReplay` needs (structural — no hard @bugsee/core client dep). */
export interface ReplayClientLike {
  addCaptureProvider(provider: CaptureProvider): void;
}

/** The shared `fileEncoders` map `registerReplay` writes its `replay` encoder into. */
export interface ReplayFileEncoders {
  replay?: (payloads: unknown[]) => Uint8Array;
}

export interface RegisterReplayOptions extends ReplayMaskingOptions {
  /** Full-snapshot cadence (ms) — bounds the retained ring window. Default 60000. */
  checkoutEveryNms?: number;
  /** Test/advanced seam: the rrweb record fn. Default the real `@bugsee/rrweb` `record`. */
  record?: ReplayRecordFn;
  /** Opt-in canvas recording (from `@bugsee/replay-canvas`); absent ⇒ DOM-only replay (unchanged). */
  canvas?: CanvasRecordConfig;
  /** Internal-error sink. Today: an invalid masking selector that was dropped and escalated (Wave 1.4) —
   *  without it the downgrade is silent, which is precisely how the original fail-open survived. */
  onError?: (error: unknown) => void;
}

/**
 * Wire session replay into a launched client: install the rrweb recorder (fail-closed masking) + register
 * the `replay.bin` encoder. Returns the recorder (its `startBlackout`/`stopBlackout` for the caller to wire).
 */
export function registerReplay(
  client: ReplayClientLike,
  fileEncoders: ReplayFileEncoders,
  options: RegisterReplayOptions = {},
): ReplayRecorder {
  const provider = createReplayCaptureProvider({
    record: options.record ?? rrwebRecord,
    masking: resolveReplayMaskingOptions(options, { onError: options.onError }),
    ...(options.checkoutEveryNms !== undefined
      ? { checkoutEveryNms: options.checkoutEveryNms }
      : {}),
    ...(options.canvas !== undefined ? { canvas: options.canvas } : {}),
  });
  client.addCaptureProvider(provider);
  // Register the encoder into the SHARED map the client reads at assembly time (RP5a) — so the next report's
  // `replay` entries serialize to the gzipped `replay.bin`.
  fileEncoders.replay = encodeReplay;
  return provider;
}
