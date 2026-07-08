import type { CaptureDataEntry, CaptureProvider, CaptureProviderInit } from '@bugsee/core';
import type { eventWithTime, recordOptions } from '@bugsee/rrweb';
import { describe, expect, it, vi } from 'vitest';
import { encodeReplay } from './encoder';
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

const fakeInit = () =>
  ({
    captureAggregator: { addEntry: (_e: CaptureDataEntry) => {} },
  }) as unknown as CaptureProviderInit;

describe('registerReplay', () => {
  it('installs the recorder capture-provider on the client + registers the replay.bin encoder', () => {
    const client = fakeClient();
    const fileEncoders: ReplayFileEncoders = {};
    const recorder = registerReplay(client, fileEncoders, { record: fakeRecord().record });

    expect(client.providers).toHaveLength(1);
    expect(client.providers[0]?.name).toBe('replay');
    expect(fileEncoders.replay).toBe(encodeReplay); // the shared map now encodes replay → replay.bin
    // The returned recorder exposes the blackout controls (for the caller to wire client.startBlackout).
    expect(typeof recorder.startBlackout).toBe('function');
    expect(typeof recorder.stopBlackout).toBe('function');
  });

  it('builds the recorder with the fail-closed masking + checkoutEveryNms (started → rrweb record opts)', () => {
    const client = fakeClient();
    const rec = fakeRecord();
    const recorder = registerReplay(client, {}, { record: rec.record, checkoutEveryNms: 15_000 });
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
    const recorder = registerReplay(fakeClient(), {}, { record: rec.record, maskAllText: false });
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
});
