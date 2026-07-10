import type { StoredEntry } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import { decodeStreamEntry } from './protocol';
import { createElectronRendererCaptureStore } from './renderer-capture-store';

const stored = (type: string, timestamp: number, serialized: string): StoredEntry =>
  ({ type, timestamp, serialized }) as StoredEntry;

describe('createElectronRendererCaptureStore', () => {
  it('encodes each added entry with the Electron codec + posts it (main side decodes it back)', () => {
    const posted: string[] = [];
    const store = createElectronRendererCaptureStore({
      post: (raw) => posted.push(raw),
      now: () => 5,
      timeOrigin: 9,
      seq: () => 3,
    });

    store.add(stored('log', 100, '{"m":"hi"}'));

    expect(posted).toHaveLength(1);
    expect(decodeStreamEntry(posted[0] as string)).toEqual({
      type: 'log',
      seq: 3,
      timestamp: 100,
      mono: 5,
      timeOrigin: 9,
      redacted: false,
      payload: '{"m":"hi"}',
    });
  });

  it('threads the pause seam (no post while paused)', () => {
    const posted: string[] = [];
    const store = createElectronRendererCaptureStore({
      post: (raw) => posted.push(raw),
      paused: () => true,
    });
    store.add(stored('log', 1, '{}'));
    expect(posted).toHaveLength(0);
  });
});
