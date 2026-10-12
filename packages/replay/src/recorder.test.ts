import {
  type BlackoutGate,
  type CaptureDataEntry,
  type CaptureProviderInit,
  createBlackoutState,
} from '@bugsee/core';
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
    latestEmit: () => options?.emit as (e: eventWithTime) => void,
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

/** The captured entries minus the blackout marker custom events (asserted separately). */
const real = (entries: CaptureDataEntry[]) =>
  entries.filter((e) => (e.data as { type: number }).type !== 5);

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
    expect(real(added)).toHaveLength(0);

    provider.stopBlackout();
    rec.emit(evt(2)); // captured again
    expect(real(added)).toHaveLength(1);
    expect(real(added)[0]?.timestamp).toBe(2);
  });

  describe('blackout (privacy: fail closed)', () => {
    const setup = (blackout?: BlackoutGate) => {
      const rec = fakeRecord();
      const { init, added } = fakeInit();
      const provider = createReplayCaptureProvider({
        record: rec.record,
        masking: resolveReplayMaskingOptions(),
        ...(blackout !== undefined ? { blackout } : {}),
      });
      provider.init(init);
      return { rec, added, provider };
    };

    it('STOPS the rrweb recorder for the whole blackout rather than only muting it', () => {
      const { rec, provider } = setup();
      provider.start(options());
      provider.startBlackout();
      expect(rec.stop).toHaveBeenCalledTimes(1);
      provider.startBlackout(); // idempotent: nothing left to stop
      expect(rec.stop).toHaveBeenCalledTimes(1);
      expect(rec.record).toHaveBeenCalledTimes(1);
    });

    it('resumes by RESTARTING rrweb (a fresh Meta + FullSnapshot), never by un-muting the old session', () => {
      const { rec, provider } = setup();
      provider.start(options());
      provider.startBlackout();
      provider.stopBlackout();
      expect(rec.record).toHaveBeenCalledTimes(2);
      provider.stopBlackout(); // not blacked out → no third session
      expect(rec.record).toHaveBeenCalledTimes(2);
    });

    it('drops a LATE emit from the pre-blackout session even after the recorder restarted', () => {
      const { rec, added, provider } = setup();
      provider.start(options());
      const stale = rec.latestEmit(); // e.g. a throttled scroll sample that fires after the stop
      provider.startBlackout();
      stale(evt(1));
      provider.stopBlackout();
      stale(evt(2)); // the old closure stays dead after the restart
      rec.emit(evt(3));
      expect(real(added).map((e) => e.timestamp)).toEqual([3]);
    });

    it('never records at all when a blackout was already active at start (lazy replay load)', () => {
      const gate = createBlackoutState();
      gate.start();
      const { rec, added, provider } = setup(gate);
      provider.start(options());
      expect(rec.record).not.toHaveBeenCalled();
      expect(added).toHaveLength(0);
    });

    it('follows the gate: pauses on start, restarts on end, and ignores a repeated notification', () => {
      const gate = createBlackoutState();
      const { rec, added, provider } = setup(gate);
      provider.start(options());
      rec.emit(evt(1));
      gate.start();
      expect(rec.stop).toHaveBeenCalledTimes(1);
      gate.end();
      expect(rec.record).toHaveBeenCalledTimes(2);
      rec.emit(evt(2));
      expect(real(added).map((e) => e.timestamp)).toEqual([1, 2]);
    });

    it('starts the deferred recording when the gate ends a blackout that was active at start', () => {
      const gate = createBlackoutState();
      gate.start();
      const { rec, provider } = setup(gate);
      provider.start(options());
      gate.end();
      expect(rec.record).toHaveBeenCalledTimes(1);
    });

    it('stop() unsubscribes from the gate, so a stopped provider never starts recording', () => {
      const real = createBlackoutState();
      const unsubscribed = vi.fn();
      const gate: BlackoutGate = {
        isActive: () => real.isActive(),
        onChange: (listener) => {
          const off = real.onChange(listener);
          return () => {
            unsubscribed();
            off();
          };
        },
      };
      const { rec, provider } = setup(gate);
      provider.start(options());
      provider.stop();
      expect(unsubscribed).toHaveBeenCalledTimes(1);
      real.start();
      real.end();
      expect(rec.record).toHaveBeenCalledTimes(1);
    });

    describe('replay blackout markers (rrweb custom events)', () => {
      const markers = (added: CaptureDataEntry[]) =>
        added
          .map(
            (e) => e.data as { type: number; data: { tag: string; payload: { active: boolean } } },
          )
          .filter((d) => d.type === 5 && d.data.tag === 'bugsee.blackout')
          .map((d) => d.data.payload.active);

      it('emits a custom event at blackout start and another at the end, so the player can show it', () => {
        const gate = createBlackoutState();
        const { rec, added, provider } = setup(gate);
        provider.start(options());
        rec.emit(evt(1));
        gate.start();
        expect(markers(added)).toEqual([true]);
        gate.end();
        expect(markers(added)).toEqual([true, false]);
        const [first] = added;
        expect(first?.type).toBe('replay');
        // The end marker lands BEFORE the fresh Meta + FullSnapshot the restarted recorder opens with.
        expect(added.at(-1)?.data).toMatchObject({ type: 5, data: { payload: { active: false } } });
      });

      it('carries a numeric timestamp on both the event and the entry', () => {
        const gate = createBlackoutState();
        const { added, provider, rec } = setup(gate);
        provider.start(options());
        gate.start();
        const entry = added.at(-1);
        expect(typeof (entry?.data as { timestamp: number }).timestamp).toBe('number');
        expect(entry?.timestamp).toBe((entry?.data as { timestamp: number }).timestamp);
        expect(rec.record).toHaveBeenCalledTimes(1);
      });

      it('emits no marker for a repeated start/stop, nor for a blackout that never recorded anything', () => {
        const gate = createBlackoutState();
        gate.start();
        const { added, provider } = setup(gate);
        provider.start(options()); // started blacked out: never recorded
        expect(markers(added)).toEqual([]);
        provider.startBlackout(); // already blacked out
        expect(markers(added)).toEqual([]);
      });

      it('no ORPHAN end marker: a blackout that began before recording (startInBlackout) ends without one (R2V-12)', () => {
        const gate = createBlackoutState();
        gate.start();
        const { added, provider, rec } = setup(gate);
        provider.start(options());
        gate.end();
        expect(markers(added)).toEqual([]);
        expect(rec.record).toHaveBeenCalledTimes(1); // recording begins fresh, with no marker needed
      });

      it('the end marker is emitted only once per start marker (a second end adds none)', () => {
        const gate = createBlackoutState();
        const { added, provider } = setup(gate);
        provider.start(options());
        gate.start();
        gate.end();
        provider.stopBlackout();
        expect(markers(added)).toEqual([true, false]);
      });

      it('a finished cycle leaves no stale start flag: a later blackout that never recorded ends without a marker', () => {
        const gate = createBlackoutState();
        const { added, provider } = setup(gate);
        provider.start(options());
        gate.start();
        gate.end(); // [true, false]
        provider.stop();
        gate.start();
        provider.start(options()); // born inside a blackout: never records
        gate.end();
        expect(markers(added)).toEqual([true, false]);
      });

      it('a later blackout after an orphan-free cycle marks normally (state does not stick)', () => {
        const gate = createBlackoutState();
        gate.start();
        const { added, provider } = setup(gate);
        provider.start(options());
        gate.end();
        gate.start();
        gate.end();
        expect(markers(added)).toEqual([true, false]);
      });

      it('the end marker lands BEFORE the fresh snapshot the restarted recorder emits (m29)', () => {
        const gate = createBlackoutState();
        const order: string[] = [];
        let first = true;
        const record: ReplayRecordFn = vi.fn((o) => {
          // A real recorder emits its opening Meta + FullSnapshot synchronously from record().
          if (!first) (o.emit as (e: eventWithTime) => void)({ type: 2, timestamp: 9 } as never);
          first = false;
          return vi.fn();
        });
        const { init, added } = fakeInit();
        const provider = createReplayCaptureProvider({
          record,
          masking: resolveReplayMaskingOptions(),
          blackout: gate,
        });
        provider.init(init);
        provider.start(options());
        gate.start();
        gate.end();
        for (const e of added) {
          order.push(String((e.data as { type: number }).type));
        }
        expect(order).toEqual(['5', '5', '2']); // start marker, end marker, THEN the snapshot
      });

      it('emits no marker from a provider that was never started', () => {
        const { added, provider } = setup();
        provider.startBlackout();
        provider.stopBlackout();
        expect(added).toHaveLength(0);
      });
    });

    it('a manual stopBlackout() on a provider that was never started does not start recording', () => {
      const { rec, provider } = setup();
      provider.startBlackout();
      provider.stopBlackout();
      expect(rec.record).not.toHaveBeenCalled();
    });
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

  describe('canvas restarts are bounded (R2V-7: rrweb cannot release canvas workers / rAF loops)', () => {
    const canvas = {
      recordCanvas: true as const,
      sampling: { canvas: 2 },
      dataURLOptions: { type: 'image/webp', quality: 0.6 },
    };
    const cycle = (gate: ReturnType<typeof createBlackoutState>, n: number) => {
      for (let i = 0; i < n; i++) {
        gate.start();
        gate.end();
      }
    };

    it('restarts WITH canvas up to the bound, then continues DOM-only and reports once', () => {
      const gate = createBlackoutState();
      const calls: Array<boolean | undefined> = [];
      const record: ReplayRecordFn = vi.fn((o) => {
        calls.push(o.recordCanvas);
        return vi.fn();
      });
      const onError = vi.fn();
      const provider = createReplayCaptureProvider({
        record,
        masking: resolveReplayMaskingOptions(),
        canvas,
        blackout: gate,
        onError,
      });
      provider.init(fakeInit().init);
      provider.start(options());
      cycle(gate, 10);
      // 1 initial + 3 restarts keep canvas; every later start is DOM-only
      expect(calls.slice(0, 4)).toEqual([true, true, true, true]);
      expect(calls.slice(4).every((c) => c === undefined)).toBe(true);
      expect(calls).toHaveLength(11);
      expect(onError).toHaveBeenCalledTimes(1);
      expect(String((onError.mock.calls[0]?.[0] as Error).message)).toMatch(/canvas/i);
    });

    it('a DOM-only recorder is never limited and never reports', () => {
      const gate = createBlackoutState();
      const record: ReplayRecordFn = vi.fn(() => vi.fn());
      const onError = vi.fn();
      const provider = createReplayCaptureProvider({
        record,
        masking: resolveReplayMaskingOptions(),
        blackout: gate,
        onError,
      });
      provider.init(fakeInit().init);
      provider.start(options());
      cycle(gate, 10);
      expect(record).toHaveBeenCalledTimes(11);
      expect(onError).not.toHaveBeenCalled();
    });

    // the bound-reached report went to the raw sink, so a THROWING onError escaped before `record()` ran and
    // left replay off until the next cycle (and the report would repeat or be lost).
    it('a throwing onError sink cannot leave replay off: the restart still happens, DOM-only', () => {
      const gate = createBlackoutState();
      const calls: Array<boolean | undefined> = [];
      const record: ReplayRecordFn = vi.fn((o) => {
        calls.push(o.recordCanvas);
        return vi.fn();
      });
      const onError = vi.fn(() => {
        throw new Error('sink exploded');
      });
      const provider = createReplayCaptureProvider({
        record,
        masking: resolveReplayMaskingOptions(),
        canvas,
        blackout: gate,
        onError,
      });
      provider.init(fakeInit().init);
      provider.start(options());
      expect(() => cycle(gate, 10)).not.toThrow();
      expect(calls).toHaveLength(11); // every restart reached record()
      expect(calls.slice(4).every((c) => c === undefined)).toBe(true); // DOM-only after the bound
      expect(onError).toHaveBeenCalledTimes(1); // reported once, not on every later start
    });

    it('works without an onError sink', () => {
      const gate = createBlackoutState();
      const record: ReplayRecordFn = vi.fn(() => vi.fn());
      const provider = createReplayCaptureProvider({
        record,
        masking: resolveReplayMaskingOptions(),
        canvas,
        blackout: gate,
      });
      provider.init(fakeInit().init);
      provider.start(options());
      expect(() => cycle(gate, 6)).not.toThrow();
    });
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
