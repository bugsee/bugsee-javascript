import type { CaptureDataEntry, CaptureProviderInit } from '@bugsee/core';
import type { eventWithTime, recordOptions } from '@bugsee/rrweb';
import { describe, expect, it, vi } from 'vitest';
import { resolveReplayMaskingOptions } from './masking';
import { createReplayCaptureProvider, type ReplayRecordFn } from './recorder';

/** A fake rrweb `record`: captures the options it was called with + lets a test drive `emit`. */
function fakeRecord() {
  let options: recordOptions<eventWithTime> | undefined;
  const stop = vi.fn();
  const record: ReplayRecordFn = vi.fn((o) => {
    options = o;
    return stop;
  });
  return {
    record,
    stop,
    getOptions: () => options,
    emit: (event: eventWithTime) => (options?.emit as (e: eventWithTime) => void)(event),
  };
}

/** A provider init whose aggregator records added entries. */
function fakeInit() {
  const added: CaptureDataEntry[] = [];
  const init = {
    captureAggregator: { addEntry: (e: CaptureDataEntry) => added.push(e) },
  } as unknown as CaptureProviderInit;
  return { init, added };
}

const evt = (timestamp: number): eventWithTime =>
  ({ type: 3, data: { source: 0 }, timestamp }) as unknown as eventWithTime;

const options = () => ({}) as never; // OptionsContainer — unused by the replay provider

describe('createReplayCaptureProvider', () => {
  it('starts rrweb record with the masking config + checkoutEveryNms + no cross-origin iframes', () => {
    const { record, getOptions } = fakeRecord();
    const masking = resolveReplayMaskingOptions();
    const provider = createReplayCaptureProvider({ record, masking, checkoutEveryNms: 30_000 });
    provider.init(fakeInit().init);
    provider.start(options());

    const o = getOptions();
    expect(record).toHaveBeenCalledTimes(1);
    expect(o?.maskAllInputs).toBe(true); // masking spread in
    expect(o?.maskAllText).toBe(true);
    expect(o?.checkoutEveryNms).toBe(30_000);
    expect(o?.recordCrossOriginIframes).toBe(false);
    expect(typeof o?.emit).toBe('function');
  });

  it('defaults checkoutEveryNms to 60000 (bounds the ring window)', () => {
    const { record, getOptions } = fakeRecord();
    const provider = createReplayCaptureProvider({
      record,
      masking: resolveReplayMaskingOptions(),
    });
    provider.init(fakeInit().init);
    provider.start(options());
    expect(getOptions()?.checkoutEveryNms).toBe(60_000);
  });

  it('routes each rrweb event to the aggregator as a `replay` entry (type + timestamp + data)', () => {
    const rec = fakeRecord();
    const { init, added } = fakeInit();
    const provider = createReplayCaptureProvider({
      record: rec.record,
      masking: resolveReplayMaskingOptions(),
    });
    provider.init(init);
    provider.start(options());

    const event = evt(1234);
    rec.emit(event);

    expect(added).toHaveLength(1);
    expect(added[0]?.type).toBe('replay');
    expect(added[0]?.timestamp).toBe(1234);
    expect(added[0]?.data).toBe(event);
  });

  it('DROPS events while blacked out, and resumes after stopBlackout', () => {
    const rec = fakeRecord();
    const { init, added } = fakeInit();
    const provider = createReplayCaptureProvider({
      record: rec.record,
      masking: resolveReplayMaskingOptions(),
    });
    provider.init(init);
    provider.start(options());

    provider.startBlackout();
    rec.emit(evt(1)); // dropped
    expect(added).toHaveLength(0);

    provider.stopBlackout();
    rec.emit(evt(2)); // captured again
    expect(added).toHaveLength(1);
    expect(added[0]?.timestamp).toBe(2);
  });

  it('stops the rrweb recorder on stop()', () => {
    const rec = fakeRecord();
    const provider = createReplayCaptureProvider({
      record: rec.record,
      masking: resolveReplayMaskingOptions(),
    });
    provider.init(fakeInit().init);
    provider.start(options());
    provider.stop();
    expect(rec.stop).toHaveBeenCalledTimes(1);
  });

  it('spreads a canvas config into the rrweb record options when provided (opt-in canvas)', () => {
    const { record, getOptions } = fakeRecord();
    const provider = createReplayCaptureProvider({
      record,
      masking: resolveReplayMaskingOptions(),
      canvas: {
        recordCanvas: true,
        sampling: { canvas: 2 },
        dataURLOptions: { type: 'image/webp', quality: 0.6 },
      },
    });
    provider.init(fakeInit().init);
    provider.start(options());

    const o = getOptions();
    expect(o?.recordCanvas).toBe(true);
    expect(o?.sampling?.canvas).toBe(2);
    expect(o?.dataURLOptions).toEqual({ type: 'image/webp', quality: 0.6 });
    expect(o?.maskAllText).toBe(true); // masking still applied alongside canvas
    expect(o?.recordCrossOriginIframes).toBe(false); // canvas does not disturb the other options
  });

  it('records NO canvas by default — recordCanvas/sampling/dataURLOptions stay absent (DOM-only)', () => {
    const { record, getOptions } = fakeRecord();
    const provider = createReplayCaptureProvider({
      record,
      masking: resolveReplayMaskingOptions(),
    });
    provider.init(fakeInit().init);
    provider.start(options());

    const o = getOptions();
    expect(o?.recordCanvas).toBeUndefined();
    expect(o?.sampling).toBeUndefined();
    expect(o?.dataURLOptions).toBeUndefined();
  });
});
