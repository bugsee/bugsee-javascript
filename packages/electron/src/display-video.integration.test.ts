import {
  assembleBundleStream,
  type BundleAssemblyContext,
  type CaptureDataEntry,
  createReportingRequest,
} from '@bugsee/core';
import { strFromU8, unzipSync } from '@bugsee/util';
import { describe, expect, it } from 'vitest';
import { electronDisplays, electronWindowLayers, type WindowLike } from './display-video';
import { createPixelVideoController, encodePixelVideo } from './pixel-video-controller';
import { createDisplayVideoSource } from './video-capture';

// Display source -> pixel controller -> bundle assembler, with the REAL `encodePixelVideo` (which concatenates every payload it is
// given): two displays must reach it as two separate files, not as one concatenated one.
const rect = (x: number, y: number, width: number, height: number) => ({ x, y, width, height });
const win = (id: number, bounds: ReturnType<typeof rect>, focused = false): WindowLike => ({
  id,
  getBounds: () => bounds,
  isVisible: () => true,
  isMinimized: () => false,
  isFocused: () => focused,
  webContents: { capturePage: async () => ({ toJPEG: () => new Uint8Array([id]) }) },
});

describe('a two-display session, end to end', () => {
  it('ships one video member per display, each holding only its own display frames, named by attrs.displayId', async () => {
    const windows = [win(1, rect(10, 10, 100, 100), true), win(2, rect(1100, 10, 100, 100))];
    const BrowserWindow = { getAllWindows: () => windows };
    const screen = {
      getAllDisplays: () => [
        { id: 30, bounds: rect(0, 0, 1000, 600) },
        { id: 70, bounds: rect(1000, 0, 800, 600) },
      ],
    };
    let tick: (() => unknown) | undefined;
    const controller = createPixelVideoController({
      source: createDisplayVideoSource({
        displays: electronDisplays(screen, BrowserWindow),
        layers: electronWindowLayers(BrowserWindow),
        // "compose": the first layer's bytes stand for the composed frame of the display
        compose: async (display, layers) =>
          new Uint8Array([display.id, ...layers.map((l) => l.bytes[0] as number)]),
        encode: (frames) => Uint8Array.from(frames.flatMap((f) => [...f.bytes])),
        scheduler: {
          setInterval: (cb) => {
            tick = cb;
            return 'h';
          },
          clearInterval: () => {},
        },
        now: () => 1_700_000_000_000,
      }),
    });
    await controller.start();
    await tick?.();
    const extra = new Map<string, CaptureDataEntry[]>([
      ['video', await controller.snapshot(1_700_000_000_000)],
    ]);

    async function* none(): AsyncGenerator<CaptureDataEntry> {}
    const bundle = await assembleBundleStream(
      createReportingRequest({ source: { type: 'error' }, id: 'r1' }),
      none(),
      {
        appToken: 'tok',
        environment: {
          platform: { type: 'electron', version: '1' },
          runtime: { type: 'electron', version: '' },
          sdk: { version: '1', type: 'javascript' },
        } as never,
        attributes: {},
        clock: { wallNow: () => 1_700_000_000_000, monotonicNow: () => 0 },
        fileName: () => 'b.zip',
        fileEncoders: { video: encodePixelVideo },
      } satisfies BundleAssemblyContext,
      extra as never,
    );
    const files = unzipSync(await bundle.body.bytes());
    // display 0 = the focused window's display (native 30, window 1); display 1 = native 70 (window 2)
    expect([...(files['video.webm'] as Uint8Array)]).toEqual([0, 1]);
    expect([...(files['video.1.webm'] as Uint8Array)]).toEqual([1, 2]);
    const manifest = JSON.parse(strFromU8(files['manifest.json'] as Uint8Array)) as {
      files: Array<{ filename: string; type: string; attrs?: Record<string, unknown> }>;
    };
    expect(
      manifest.files.filter((f) => f.type === 'video').map((f) => [f.filename, f.attrs]),
    ).toEqual([
      ['video.webm', { format: 'webm', displayId: 0 }],
      ['video.1.webm', { format: 'webm', displayId: 1 }],
    ]);
  });
});
