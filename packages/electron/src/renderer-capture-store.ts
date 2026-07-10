// The renderer-side CaptureStore: a streaming store whose entries are encoded with the Electron wire codec
// and posted to the main process. It's the @bugsee/webview HostBridgeCaptureStore pattern with the sink
// swapped from a JS→native bridge to a JS→JS `post` (Electron IPC). The main process is the ring + bundler.
import { type CaptureStore, createStreamingCaptureStore } from '@bugsee/core';
import type { FileType } from '@bugsee/protocol';
import { encodeStreamEntry } from './protocol';

export interface ElectronRendererCaptureStoreOptions {
  /** The sink to the main process (e.g. `(raw) => __bugseeElectron.post(raw)`). Must never throw. */
  post: (raw: string) => void;
  now?: () => number;
  timeOrigin?: number;
  seq?: () => number;
  paused?: () => boolean;
  redactedFor?: (type: FileType) => boolean;
}

/** Build the renderer capture store that encodes + posts every entry to the main process. */
export function createElectronRendererCaptureStore(
  opts: ElectronRendererCaptureStoreOptions,
): CaptureStore {
  return createStreamingCaptureStore({
    post: opts.post,
    encodeEntry: encodeStreamEntry,
    now: opts.now,
    timeOrigin: opts.timeOrigin,
    seq: opts.seq,
    paused: opts.paused,
    redactedFor: opts.redactedFor,
  });
}
