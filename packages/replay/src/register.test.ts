// @vitest-environment jsdom -- selector validation (Wave 1.4) needs a DOM to parse against
import type { CaptureDataEntry, CaptureProvider, CaptureProviderInit } from '@bugsee/core';
import type { eventWithTime, recordOptions } from '@bugsee/rrweb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeReplay } from './encoder';
import type { ReplayRecorder } from './recorder';
import { type ReplayFileEncoders, registerReplay } from './register';

function fakeClient() {
  const providers: CaptureProvider[] = [];
  return { addCaptureProvider: (p: CaptureProvider) => providers.push(p), providers };
}

function fakeRecord() {
  let options: recordOptions<eventWithTime> | undefined;
  const record = vi.fn((o: recordOptions<eventWithTime>) => {
    options = o;
    return vi.fn();
  });
  return { record, getOptions: () => options };
}

// `registerReplay` returns `undefined` in a DOM-less host. Every test below this line runs under jsdom,
// where it must return a real recorder — so failing that is a test failure, not a `?.` to be swallowed.
const mustRegister = (...args: Parameters<typeof registerReplay>): ReplayRecorder => {
  const recorder = registerReplay(...args);
  if (recorder === undefined) {
    throw new Error('registerReplay returned undefined despite a DOM being present');
  }
  return recorder;
};

const fakeInit = () =>
  ({
    captureAggregator: { addEntry: (_e: CaptureDataEntry) => {} },
  }) as unknown as CaptureProviderInit;

describe('registerReplay', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('installs the recorder capture-provider on the client + registers the replay.bin encoder', () => {
    const client = fakeClient();
    const fileEncoders: ReplayFileEncoders = {};
    const recorder = mustRegister(client, fileEncoders, { record: fakeRecord().record });

    expect(client.providers).toHaveLength(1);
    expect(client.providers[0]?.name).toBe('replay');
    expect(fileEncoders.replay).toBe(encodeReplay); // the shared map now encodes replay → replay.bin
    // The returned recorder exposes the blackout controls (for the caller to wire client.startBlackout).
    expect(typeof recorder.startBlackout).toBe('function');
    expect(typeof recorder.stopBlackout).toBe('function');
  });

  it('reports a dropped invalid masking selector through the caller onError', () => {
    // Wave 1.4. Without this wiring the resolver's report has nowhere to go, and a developer's typo'd
    // selector is silently downgraded — which is how the original defect stayed invisible in the first place.
    const errors: unknown[] = [];
    registerReplay(
      fakeClient(),
      {},
      {
        record: fakeRecord().record,
        blockSelector: 'div[',
        onError: (e) => errors.push(e),
      },
    );
    expect(errors).toHaveLength(1);
    expect(String(errors[0])).toContain('blockSelector');
  });

  it('builds the recorder with the fail-closed masking + checkoutEveryNms (started → rrweb record opts)', () => {
    const client = fakeClient();
    const rec = fakeRecord();
    const recorder = mustRegister(client, {}, { record: rec.record, checkoutEveryNms: 15_000 });
    // Start the installed provider (the fake client didn't) to observe the record() options.
    recorder.init(fakeInit());
    recorder.start({} as never);

    const o = rec.getOptions();
    expect(o?.maskAllInputs).toBe(true);
    expect(o?.maskAllText).toBe(true);
    expect(o?.checkoutEveryNms).toBe(15_000);
  });

  it('forwards masking option overrides (maskAllText:false → only Bugsee-marked text)', () => {
    const rec = fakeRecord();
    const recorder = mustRegister(fakeClient(), {}, { record: rec.record, maskAllText: false });
    recorder.init(fakeInit());
    recorder.start({} as never);
    expect(rec.getOptions()?.maskTextSelector).not.toBe('*');
    expect(rec.getOptions()?.maskTextSelector).toContain('.bugsee-mask');
  });

  it('defaults to the real @bugsee/rrweb record when no record seam is given', () => {
    // No `record` option → the default `rrwebRecord` branch. The provider is created (not started here, so
    // real rrweb never runs) — this exercises the `options.record ?? rrwebRecord` default.
    const client = fakeClient();
    expect(() => registerReplay(client, {})).not.toThrow();
    expect(client.providers).toHaveLength(1);
  });

  it('threads a canvas config through to the rrweb record options (opt-in canvas)', () => {
    const rec = fakeRecord();
    const recorder = mustRegister(
      fakeClient(),
      {},
      {
        record: rec.record,
        canvas: {
          recordCanvas: true,
          sampling: { canvas: 3 },
          dataURLOptions: { type: 'image/webp', quality: 0.5 },
        },
      },
    );
    recorder.init(fakeInit());
    recorder.start({} as never);

    const o = rec.getOptions();
    expect(o?.recordCanvas).toBe(true);
    expect(o?.sampling?.canvas).toBe(3);
    expect(o?.dataURLOptions).toEqual({ type: 'image/webp', quality: 0.5 });
  });

  // --- DOM-less hosts (SSR / pre-render) ---------------------------------------------------------
  //
  // Defence in depth. `@bugsee/browser` already refuses to even `import()` this module without a DOM (that
  // gate is what saves the ~56KB), but this module can still be reached DOM-less — a consumer importing
  // `@bugsee/replay` directly, or a bundler that resolves it eagerly instead of code-splitting. rrweb
  // records the DOM, so `record()` throws there; without this skip the throw escapes `registerReplay`.
  describe('without a DOM', () => {
    const noDom = () => vi.stubGlobal('document', undefined);

    it('no-ops: no provider installed, no encoder registered, record never called', () => {
      noDom();
      const client = fakeClient();
      const fileEncoders: ReplayFileEncoders = {};
      const rec = fakeRecord();

      const recorder = registerReplay(client, fileEncoders, { record: rec.record });

      expect(recorder).toBeUndefined(); // nothing to blackout — there is nothing recording
      expect(client.providers).toHaveLength(0); // the aggregator never sees a replay provider
      expect(fileEncoders.replay).toBeUndefined(); // and no report claims a replay.bin
      expect(rec.record).not.toHaveBeenCalled(); // rrweb was never started
    });

    it('does not throw, and stays SILENT — no onError', () => {
      noDom();
      const errors: unknown[] = [];
      expect(() =>
        registerReplay(
          fakeClient(),
          {},
          { record: fakeRecord().record, onError: (e) => errors.push(e) },
        ),
      ).not.toThrow();
      // A DOM-less host is a supported environment, not a misconfiguration, and replay is on by DEFAULT —
      // an onError here would fire on every server render. Same contract as @bugsee/capture's interceptors,
      // which return silently when their global is absent.
      expect(errors).toEqual([]);
    });

    it('stays silent even for a misconfiguration a DOM-ful launch WOULD report', () => {
      // The silence is unconditional, not "silent unless something else is also wrong": a typo'd selector
      // is reported through onError with a DOM (test above), and reported not at all without one, because
      // the skip returns before any masking is resolved.
      noDom();
      const errors: unknown[] = [];
      registerReplay(
        fakeClient(),
        {},
        { record: fakeRecord().record, blockSelector: 'div[', onError: (e) => errors.push(e) },
      );
      expect(errors).toEqual([]); // with a DOM this same call reports a dropped selector (test above)
    });

    it('positive control: the SAME call registers normally once the DOM is back', () => {
      // Proves the three zeros above come from the DOM probe and not from a broken fake or a stubbed-out
      // module — the identical arguments produce a provider + an encoder when `document` exists.
      noDom();
      const a = fakeClient();
      const encodersA: ReplayFileEncoders = {};
      expect(registerReplay(a, encodersA, { record: fakeRecord().record })).toBeUndefined();

      vi.unstubAllGlobals();
      const b = fakeClient();
      const encodersB: ReplayFileEncoders = {};
      expect(registerReplay(b, encodersB, { record: fakeRecord().record })).toBeDefined();
      expect(b.providers).toHaveLength(1);
      expect(encodersB.replay).toBe(encodeReplay);
    });
  });

  it('omits canvas by default (no canvas option → DOM-only record)', () => {
    const rec = fakeRecord();
    const recorder = mustRegister(fakeClient(), {}, { record: rec.record });
    recorder.init(fakeInit());
    recorder.start({} as never);
    expect(rec.getOptions()?.recordCanvas).toBeUndefined();
  });
});
