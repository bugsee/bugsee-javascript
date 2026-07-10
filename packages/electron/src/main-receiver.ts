// The main-process inbound receiver (E3) — the convergence point. Every renderer streams its capture as
// encoded wire messages over IPC; the receiver decodes each one and adds it to the MAIN process's capture
// store, merging all renderers + the main process's own capture into ONE rolling timeline / one bundle.
// Entry timestamps are already wall-clock unix-ms (shared OS clock), so they're directly comparable across
// processes — no re-basing needed. `electron` is taken as plain args (no dependency; fully testable).
import type { StoredEntry } from '@bugsee/core';
import { BUGSEE_STREAM_CHANNEL } from './preload-bridge';
import { type DecodedStreamEntry, decodeStreamEntry } from './protocol';

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
  const listener = (event: IpcMainEventLike, ...args: unknown[]): void => {
    const raw = args[0];
    if (typeof raw !== 'string') {
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
    options.onEntry?.(decoded, event.sender?.id ?? -1);
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
