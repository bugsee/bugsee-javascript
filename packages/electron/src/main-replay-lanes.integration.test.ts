import { gunzipSync } from 'node:zlib';
import {
  assembleBundleStream,
  createCaptureExporter,
  createChunkCaptureStore,
  createMemoryChunkBackend,
  createReportingRequest,
} from '@bugsee/core';
import { createReplayStreamEncoder } from '@bugsee/replay/stream-encoder';
import { strFromU8, unzipSync } from '@bugsee/util';
import { describe, expect, it } from 'vitest';
import { createElectronMainReceiver, type IpcMainListener } from './main-receiver';
import { encodeStreamEntry } from './protocol';

// Two windows stream rrweb replay into main; the report must carry one decodable replay per window, each opening on its own
// base. Real receiver -> real chunk store -> real exporter -> real assembler -> the real replay stream encoder.
const NOW = 1_700_000_000_000;
const clock = { wallNow: () => NOW, monotonicNow: () => 0 };

const event = (type: number, timestamp: number, tag: string) => ({
  type,
  timestamp,
  data: { tag },
});
const wire = (seq: number, timestamp: number, payload: unknown, anchor = false): string =>
  encodeStreamEntry({
    type: 'replay',
    seq,
    timestamp,
    mono: 0,
    timeOrigin: 0,
    redacted: false,
    payload: JSON.stringify({ timestamp, data: payload }), // a record's payload wraps the rrweb event as `data`
    ...(anchor ? { anchor: true } : {}),
  } as never);

describe('main: one replay member per window, end to end', () => {
  it('builds replay.bin and replay.1.bin from two windows, each opening on its own Meta + FullSnapshot', async () => {
    const store = createChunkCaptureStore(createMemoryChunkBackend(), {
      clock,
      maxRecordingTimeMs: 1_000_000,
    });
    let listener: IpcMainListener | undefined;
    const receiver = createElectronMainReceiver({
      ipcMain: {
        on: (_c, l) => {
          listener = l;
        },
        removeListener: () => {},
      },
      store,
    });
    receiver.start();
    const send = (id: number, message: string) => listener?.({ sender: { id } }, message);
    // window 3 and window 8 interleave their events
    send(3, wire(1, NOW - 50, event(4, NOW - 50, 'A-meta')));
    send(8, wire(1, NOW - 49, event(4, NOW - 49, 'B-meta')));
    send(3, wire(2, NOW - 48, event(2, NOW - 48, 'A-full'), true));
    send(8, wire(2, NOW - 47, event(2, NOW - 47, 'B-full'), true));
    send(3, wire(3, NOW - 40, event(3, NOW - 40, 'A-inc')));
    send(8, wire(3, NOW - 39, event(3, NOW - 39, 'B-inc')));

    const bundle = await assembleBundleStream(
      createReportingRequest({ source: { type: 'error' }, id: 'r1' }),
      createCaptureExporter(store).stream(),
      {
        appToken: 'tok',
        environment: {
          platform: { type: 'electron', version: '1' },
          runtime: { type: 'electron', version: '' },
          sdk: { version: '1', type: 'javascript' },
        } as never,
        attributes: {},
        clock,
        fileName: () => 'b.zip',
        streamEncoders: { replay: createReplayStreamEncoder() },
      },
    );
    const files = unzipSync(await bundle.body.bytes());
    const tags = (name: string): string[] =>
      (
        JSON.parse(strFromU8(new Uint8Array(gunzipSync(files[name] as Uint8Array)))) as Array<{
          data: { tag: string };
        }>
      ).map((e) => e.data.tag);
    expect(tags('replay.bin')).toEqual(['A-meta', 'A-full', 'A-inc']);
    expect(tags('replay.1.bin')).toEqual(['B-meta', 'B-full', 'B-inc']);
    const manifest = JSON.parse(strFromU8(files['manifest.json'] as Uint8Array)) as {
      files: Array<{ filename: string; type: string; attrs?: Record<string, unknown> }>;
    };
    expect(
      manifest.files.filter((f) => f.type === 'replay').map((f) => [f.filename, f.attrs?.window]),
    ).toEqual([
      ['replay.bin', '3'],
      ['replay.1.bin', '8'],
    ]);
  });
});
