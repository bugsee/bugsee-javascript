// Integration (cross-package boundary, standards §3): @bugsee/replay-canvas's resolved config must COMPOSE
// with @bugsee/replay's recorder seam — i.e. flow through registerReplay into the rrweb `record()` options.
// Uses the REAL registerReplay + REAL createCanvasRecordConfig with a fake `record` (no rrweb/DOM).
import type { CaptureProviderInit } from '@bugsee/core';
import { type ReplayRecordFn, registerReplay } from '@bugsee/replay';
import { describe, expect, it, vi } from 'vitest';
import { createCanvasRecordConfig } from './canvas-config';

type RecordOpts = Parameters<ReplayRecordFn>[0];
const fakeInit = () =>
  ({ captureAggregator: { addEntry: () => {} } }) as unknown as CaptureProviderInit;

describe('@bugsee/replay-canvas ⇄ @bugsee/replay integration', () => {
  it('drives rrweb record() with the resolved canvas options through registerReplay', () => {
    let recordArgs: RecordOpts | undefined;
    const record: ReplayRecordFn = vi.fn((o) => {
      recordArgs = o;
      return vi.fn();
    });

    const canvas = createCanvasRecordConfig({ fps: 5, quality: 0.5, imageType: 'image/jpeg' });
    const recorder = registerReplay({ addCaptureProvider: () => {} }, {}, { record, canvas });
    recorder.init(fakeInit());
    recorder.start({} as never); // start → the provider calls record()

    expect(record).toHaveBeenCalledTimes(1);
    expect(recordArgs?.recordCanvas).toBe(true);
    expect(recordArgs?.sampling?.canvas).toBe(5);
    expect(recordArgs?.dataURLOptions).toEqual({ type: 'image/jpeg', quality: 0.5 });
    // Fail-closed masking is still applied alongside canvas (defense-in-depth, not disturbed).
    expect(recordArgs?.maskAllText).toBe(true);
  });

  it('produces a DOM-only session (no canvas options) when the canvas config is absent', () => {
    let recordArgs: RecordOpts | undefined;
    const record: ReplayRecordFn = vi.fn((o) => {
      recordArgs = o;
      return vi.fn();
    });
    const recorder = registerReplay({ addCaptureProvider: () => {} }, {}, { record });
    recorder.init(fakeInit());
    recorder.start({} as never);
    expect(recordArgs?.recordCanvas).toBeUndefined();
  });
});
