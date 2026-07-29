// The main-process inbound receiver (E3) — the convergence point. Every renderer streams its capture as
// encoded wire messages over IPC; the receiver decodes each one and adds it to the MAIN process's capture
// store, merging all renderers + the main process's own capture into ONE rolling timeline / one bundle.
// Entry timestamps are already wall-clock unix-ms (shared OS clock), so they're directly comparable across
// processes — no re-basing needed. `electron` is taken as plain args (no dependency; fully testable).
import type { StoredEntry } from '@bugsee/core';
import { BUGSEE_STREAM_CHANNEL } from './preload-bridge';
import {
  type DecodedReport,
  type DecodedStreamEntry,
  decodeReport,
  decodeStreamEntry,
  isReport,
} from './protocol';

/** An Electron `ipcMain` event (we only read the sender's id, to tag the originating window). */
export interface IpcMainEventLike {
  sender?: { id?: number };
}
/** The subset of Electron's `ipcMain` we use. */
export type IpcMainListener = (event: IpcMainEventLike, ...args: unknown[]) => void;
export interface IpcMainLike {
  on(channel: string, listener: IpcMainListener): void;
  removeListener(channel: string, listener: IpcMainListener): void;
}

export interface ElectronMainReceiverOptions {
  ipcMain: IpcMainLike;
  /** The main process's capture store (renderer entries are merged here). */
  store: { add(entry: StoredEntry): void };
  /** IPC channel (default {@link BUGSEE_STREAM_CHANNEL}). */
  channel?: string;
  /** Called after each decoded entry is stored (with the originating window id) — a seam for report joins. */
  onEntry?: (entry: DecodedStreamEntry, windowId: number) => void;
  /**
   * Called with a renderer-forwarded INCIDENT (R3). Routed here WITHOUT touching the capture store: an
   * incident is not a captured record, and storing it would put a second, array-shaped `crash.json` in the
   * bundle and pollute every later report in the rolling window
   * (docs/design/electron-renderer-incident-convergence.md §4.1).
   */
  onReport?: (report: DecodedReport, windowId: number) => void;
  /** Internal-error sink. A failure handling one message must never break the channel. */
  onError?: (error: unknown) => void;
}

export interface ElectronMainReceiver {
  start(): void;
  stop(): void;
}

/** Build the main-process receiver that merges every renderer's streamed capture into the main store. */
export function createElectronMainReceiver(
  options: ElectronMainReceiverOptions,
): ElectronMainReceiver {
  const channel = options.channel ?? BUGSEE_STREAM_CHANNEL;
  // R5: the whole listener is contained. It runs inside Electron's ipcMain dispatch, so a throw here — a
  // malformed message, a store failure, a user callback that raises — escapes into the host app's IPC
  // machinery and can take the channel (and with it all renderer capture) down. R3 adds report submission
  // inside this listener, which is precisely why the containment lands first.
  const listener = (event: IpcMainEventLike, ...args: unknown[]): void => {
    try {
      const raw = args[0];
      if (typeof raw !== 'string') {
        return;
      }
      const windowId = event.sender?.id ?? -1;
      // Incidents route to the join WITHOUT entering the capture store (see onReport).
      if (isReport(raw)) {
        const report = decodeReport(raw);
        if (report !== undefined) {
          options.onReport?.(report, windowId);
        }
        return;
      }
      const decoded = decodeStreamEntry(raw);
      if (decoded === undefined) {
        return;
      }
      options.store.add({
        type: decoded.type,
        timestamp: decoded.timestamp,
        serialized: decoded.payload,
      });
      options.onEntry?.(decoded, windowId);
    } catch (error) {
      options.onError?.(error);
    }
  };

  return {
    start(): void {
      options.ipcMain.on(channel, listener);
    },
    stop(): void {
      options.ipcMain.removeListener(channel, listener);
    },
  };
}
