// Integration (cross-package boundary, standards §3): @bugsee/replay-canvas's resolved config must COMPOSE
// with @bugsee/replay's recorder seam — i.e. flow through registerReplay into the rrweb `record()` options.
// Uses the REAL registerReplay + REAL createCanvasRecordConfig with a fake `record` (no rrweb).
import type { CaptureProviderInit } from '@bugsee/core';
import { type ReplayRecordFn, registerReplay } from '@bugsee/replay';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createCanvasRecordConfig } from './canvas-config';

type RecordOpts = Parameters<ReplayRecordFn>[0];
const fakeInit = () =>
  ({ captureAggregator: { addEntry: () => {} } }) as unknown as CaptureProviderInit;

/** registerReplay returns undefined in a DOM-less host, which this node-env suite is. These tests are
 *  about the canvas-options composition, not the SSR guard, so give them the DOM the guard asks for —
 *  minimal, and enough for the masking resolver's `createElement('div').matches(selector)` validation. */
const withDom = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error('registerReplay returned undefined despite the stubbed document');
  }
  return value;
};

describe('@bugsee/replay-canvas ⇄ @bugsee/replay integration', () => {
  beforeEach(() => {
    vi.stubGlobal('document', { createElement: () => ({ matches: () => true }) });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drives rrweb record() with the resolved canvas options through registerReplay', () => {
    let recordArgs: RecordOpts | undefined;
    const record: ReplayRecordFn = vi.fn((o) => {
      recordArgs = o;
      return vi.fn();
    });

    const canvas = createCanvasRecordConfig({ fps: 5, quality: 0.5, imageType: 'image/jpeg' });
    const recorder = withDom(
      registerReplay({ addCaptureProvider: () => {} }, {}, { record, canvas }),
    );
    recorder.init(fakeInit());
    recorder.start({} as never); // start → the provider calls record()

    expect(record).toHaveBeenCalledTimes(1);
    expect(recordArgs?.recordCanvas).toBe(true);
    expect(recordArgs?.sampling?.canvas).toBe(5);
    expect(recordArgs?.dataURLOptions).toEqual({ type: 'image/jpeg', quality: 0.5 });
    // Fail-closed masking is still applied alongside canvas (defense-in-depth, not disturbed).
    expect(recordArgs?.maskAllText).toBe(true);
  });

  it("threads full-fidelity ('all') canvas capture through registerReplay to rrweb record()", () => {
    let recordArgs: RecordOpts | undefined;
    const record: ReplayRecordFn = vi.fn((o) => {
      recordArgs = o;
      return vi.fn();
    });
    const canvas = createCanvasRecordConfig({ fps: 'all' });
    const recorder = withDom(
      registerReplay({ addCaptureProvider: () => {} }, {}, { record, canvas }),
    );
    recorder.init(fakeInit());
    recorder.start({} as never);

    expect(recordArgs?.recordCanvas).toBe(true);
    expect(recordArgs?.sampling?.canvas).toBe('all'); // rrweb's seam accepts 'all' | number
  });

  it('produces a DOM-only session (no canvas options) when the canvas config is absent', () => {
    let recordArgs: RecordOpts | undefined;
    const record: ReplayRecordFn = vi.fn((o) => {
      recordArgs = o;
      return vi.fn();
    });
    const recorder = withDom(registerReplay({ addCaptureProvider: () => {} }, {}, { record }));
    recorder.init(fakeInit());
    recorder.start({} as never);
    expect(recordArgs?.recordCanvas).toBeUndefined();
  });
});
