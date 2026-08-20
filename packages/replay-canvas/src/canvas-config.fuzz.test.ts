// Property-based (fuzz) tests for the canvas option resolver. `createCanvasRecordConfig` is fed
// USER-SUPPLIED values that are spread straight into rrweb's `record()` — an out-of-range fps or a NaN
// quality reaches the recorder itself (a 10 000 fps canvas snapshot loop, or a `toDataURL` quality the
// browser rejects), so the clamping is a safety boundary, not cosmetics. The example tests pin the
// documented values; these pin the INVARIANTS over the whole input domain, and each expectation is
// computed a second time from an independent reference (a scan over the legal frame rates, and
// `floor(x + 0.5)` instead of `Math.round`) rather than by restating the implementation.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type CanvasReplayOptions, createCanvasRecordConfig } from './canvas-config';

const LEGAL_FPS = Array.from({ length: 60 }, (_, i) => i + 1); // 1..60, the contract's whole-frame rates

/** Independent reference for the resolved fps: round with floor(x+0.5), then pick the legal rate by scan. */
const referenceFps = (fps: number): number => {
  const rounded = Math.floor(fps + 0.5);
  let best = LEGAL_FPS[0] as number;
  for (const candidate of LEGAL_FPS) {
    if (candidate <= rounded) {
      best = candidate;
    }
  }
  return best;
};

/** Independent reference for the resolved quality: pick by comparison, not by min/max composition. */
const referenceQuality = (quality: number): number => {
  if (quality < 0) {
    return 0;
  }
  if (quality > 1) {
    return 1;
  }
  return quality;
};

// A generator of *any* value a caller could pass for fps — including the out-of-contract ones a JS caller
// can always produce despite the types.
const anyFps = () =>
  fc.oneof(
    fc.double(),
    fc.double({ min: -1e6, max: 1e6 }),
    // Biased at the interesting band. `fc.double` over [-5, 70] is useless here: doubles are dense
    // around zero, so a fractional value between 1 and 60 essentially never comes out — and that band is
    // exactly where the rounding rule (round vs ceil vs trunc) is decided. Millis-scaled integers give
    // dense, genuinely fractional coverage of it.
    fc.integer({ min: -5_000, max: 70_000 }).map((n) => n / 1000),
    fc.integer({ min: -1000, max: 1000 }),
    fc.constantFrom(
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      -0,
      Number.MIN_VALUE,
      Number.MAX_VALUE,
    ),
  );

describe('createCanvasRecordConfig — properties', () => {
  it('always produces a recording config rrweb can consume (structure + recordCanvas)', () => {
    fc.assert(
      fc.property(
        fc.option(anyFps(), { nil: undefined }),
        fc.option(fc.double(), { nil: undefined }),
        fc.option(fc.string(), { nil: undefined }),
        (fps, quality, imageType) => {
          const cfg = createCanvasRecordConfig({
            fps,
            quality,
            imageType,
          } as unknown as CanvasReplayOptions);
          expect(cfg.recordCanvas).toBe(true);
          expect(Object.keys(cfg).sort()).toEqual(['dataURLOptions', 'recordCanvas', 'sampling']);
          expect(Object.keys(cfg.dataURLOptions).sort()).toEqual(['quality', 'type']);
          // Spread into rrweb's options as-is, so no key may arrive holding `undefined`.
          expect(Object.values(cfg.dataURLOptions).every((v) => v !== undefined)).toBe(true);
          expect(cfg.sampling.canvas).not.toBe(undefined);
        },
      ),
    );
  });

  it('resolves any numeric fps to a whole legal frame rate in [1, 60] (matches an independent reference)', () => {
    fc.assert(
      fc.property(anyFps(), (fps) => {
        const resolved = createCanvasRecordConfig({ fps }).sampling.canvas;
        expect(typeof resolved).toBe('number');
        const n = resolved as number;
        expect(Number.isInteger(n)).toBe(true);
        expect(n).toBeGreaterThanOrEqual(1);
        expect(n).toBeLessThanOrEqual(60);
        // Non-finite input is the documented "fall back to the cheap default" case; finite input must
        // agree with the reference clamp.
        expect(n).toBe(Number.isFinite(fps) ? referenceFps(fps) : 2);
      }),
    );
  });

  it('is monotone in fps: asking for more frames never yields fewer', () => {
    fc.assert(
      fc.property(
        // Millis-scaled, for the same density reason as `anyFps` above.
        fc.integer({ min: -10_000, max: 70_000 }).map((n) => n / 1000),
        fc.integer({ min: -10_000, max: 70_000 }).map((n) => n / 1000),
        (a, b) => {
          const lo = Math.min(a, b);
          const hi = Math.max(a, b);
          expect(
            (createCanvasRecordConfig({ fps: lo }).sampling.canvas as number) <=
              (createCanvasRecordConfig({ fps: hi }).sampling.canvas as number),
          ).toBe(true);
        },
      ),
    );
  });

  it('is idempotent: re-resolving an already-resolved fps / quality changes nothing', () => {
    fc.assert(
      fc.property(anyFps(), fc.double(), (fps, quality) => {
        const once = createCanvasRecordConfig({ fps, quality });
        const twice = createCanvasRecordConfig({
          fps: once.sampling.canvas,
          quality: once.dataURLOptions.quality,
        });
        expect(twice).toEqual(once);
      }),
    );
  });

  it('resolves any quality into [0, 1], never NaN (matches an independent reference)', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.double(),
          fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0),
        ),
        (quality) => {
          const resolved = createCanvasRecordConfig({ quality }).dataURLOptions.quality;
          expect(Number.isNaN(resolved)).toBe(false);
          expect(resolved).toBeGreaterThanOrEqual(0);
          expect(resolved).toBeLessThanOrEqual(1);
          // `+ 0` normalizes -0 to +0 on BOTH sides: clamping through Math.max(0, -0) yields +0 while the
          // reference returns -0 unchanged, and that difference is invisible everywhere it matters
          // (JSON, arithmetic, rrweb's toDataURL quality argument).
          expect(resolved + 0).toBe(
            (Number.isFinite(quality) ? referenceQuality(quality) : 0.6) + 0,
          );
        },
      ),
    );
  });

  it("accepts only the two documented encodings — every other string falls back to webp, and only the exact 'all' is full fidelity", () => {
    fc.assert(
      fc.property(fc.string(), (s) => {
        const type = createCanvasRecordConfig({ imageType: s } as unknown as CanvasReplayOptions)
          .dataURLOptions.type;
        expect(type).toBe(s === 'image/jpeg' ? 'image/jpeg' : 'image/webp');
        // The same exact-match rule for the fps sentinel: a near-miss string must not enable 'all'.
        const canvas = createCanvasRecordConfig({ fps: s } as unknown as CanvasReplayOptions)
          .sampling.canvas;
        expect(canvas).toBe(s === 'all' ? 'all' : 2); // a non-numeric fps is not finite → the default
      }),
      { examples: [['image/jpeg'], ['IMAGE/JPEG'], [' image/jpeg'], ['all'], ['ALL'], ['all ']] },
    );
  });

  it('is pure: it never mutates the caller-owned options object and repeats itself exactly', () => {
    fc.assert(
      fc.property(anyFps(), fc.double(), fc.string(), (fps, quality, imageType) => {
        const options = { fps, quality, imageType } as unknown as CanvasReplayOptions;
        const snapshot = JSON.stringify(options);
        const first = createCanvasRecordConfig(options);
        const second = createCanvasRecordConfig(options);
        expect(JSON.stringify(options)).toBe(snapshot); // caller's object untouched
        expect(second).toEqual(first);
        expect(second).not.toBe(first); // a fresh config per call (never a shared mutable singleton)
      }),
    );
  });
});
