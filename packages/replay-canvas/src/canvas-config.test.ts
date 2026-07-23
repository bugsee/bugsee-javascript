import { describe, expect, it } from 'vitest';
import { type CanvasReplayOptions, createCanvasRecordConfig } from './canvas-config';

describe('createCanvasRecordConfig', () => {
  it('produces cheap-by-default canvas options (2 fps / webp / q0.6, recordCanvas on)', () => {
    expect(createCanvasRecordConfig()).toEqual({
      recordCanvas: true,
      sampling: { canvas: 2 },
      dataURLOptions: { type: 'image/webp', quality: 0.6 },
    });
  });

  it('passes through explicit fps / quality / imageType', () => {
    expect(createCanvasRecordConfig({ fps: 5, quality: 0.4, imageType: 'image/jpeg' })).toEqual({
      recordCanvas: true,
      sampling: { canvas: 5 },
      dataURLOptions: { type: 'image/jpeg', quality: 0.4 },
    });
  });

  it('clamps fps to [1, 60] and rounds to a whole frame rate', () => {
    expect(createCanvasRecordConfig({ fps: 0 }).sampling.canvas).toBe(1); // floor
    expect(createCanvasRecordConfig({ fps: -10 }).sampling.canvas).toBe(1);
    expect(createCanvasRecordConfig({ fps: 200 }).sampling.canvas).toBe(60); // cap
    expect(createCanvasRecordConfig({ fps: 2.7 }).sampling.canvas).toBe(3); // rounds up
    expect(createCanvasRecordConfig({ fps: 2.3 }).sampling.canvas).toBe(2); // rounds down (pins Math.round, not ceil/trunc)
  });

  it('falls back to the default fps for a non-finite fps', () => {
    expect(createCanvasRecordConfig({ fps: Number.NaN }).sampling.canvas).toBe(2);
    expect(createCanvasRecordConfig({ fps: Number.POSITIVE_INFINITY }).sampling.canvas).toBe(2);
  });

  it('clamps quality to [0, 1]; non-finite → the default', () => {
    expect(createCanvasRecordConfig({ quality: -1 }).dataURLOptions.quality).toBe(0);
    expect(createCanvasRecordConfig({ quality: 5 }).dataURLOptions.quality).toBe(1);
    expect(createCanvasRecordConfig({ quality: Number.NaN }).dataURLOptions.quality).toBe(0.6);
  });

  it('defaults an unknown/absent imageType to webp; honors jpeg', () => {
    expect(createCanvasRecordConfig({}).dataURLOptions.type).toBe('image/webp');
    expect(createCanvasRecordConfig({ imageType: 'image/jpeg' }).dataURLOptions.type).toBe(
      'image/jpeg',
    );
    // Defensive: an out-of-contract string still resolves to the safe webp default.
    const bad = { imageType: 'image/gif' } as unknown as CanvasReplayOptions;
    expect(createCanvasRecordConfig(bad).dataURLOptions.type).toBe('image/webp');
  });

  it('always sets recordCanvas: true', () => {
    expect(createCanvasRecordConfig({ fps: 30 }).recordCanvas).toBe(true);
  });

  it("records every draw call when fps is 'all' (full-fidelity mode, bypasses the snapshot fps)", () => {
    const c = createCanvasRecordConfig({ fps: 'all' });
    expect(c.sampling.canvas).toBe('all'); // 'all' → rrweb records every canvas mutation
    expect(c.recordCanvas).toBe(true);
    expect(c.dataURLOptions).toEqual({ type: 'image/webp', quality: 0.6 }); // still snapshots full checkouts
  });

  it('stays in numeric snapshot mode by default (a number, never the string "all")', () => {
    expect(createCanvasRecordConfig().sampling.canvas).toBe(2);
    expect(createCanvasRecordConfig({ fps: 5 }).sampling.canvas).toBe(5);
  });
});
