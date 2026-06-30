import type { StoredEntry } from '@bugsee/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HostBridge } from './host-bridge';
import { createHostBridgeCaptureStore } from './host-bridge-capture-store';
import type { EntryMessage } from './protocol';

function recordingBridge() {
  const posted: string[] = [];
  const bridge: HostBridge = { available: true, post: (r) => posted.push(r) };
  return { bridge, msgs: () => posted.map((r) => JSON.parse(r) as EntryMessage) };
}

const rec = (type: StoredEntry['type'], serialized: string, timestamp = 1000): StoredEntry => ({
  type,
  timestamp,
  serialized,
});

afterEach(() => vi.restoreAllMocks());

describe('createHostBridgeCaptureStore', () => {
  it('streams each added record as an entry envelope (type/seq/ts/payload), seq monotonic', () => {
    const { bridge, msgs } = recordingBridge();
    const store = createHostBridgeCaptureStore({ bridge, now: () => 5, timeOrigin: 900 });
    store.add(rec('network', '{"u":"x"}', 1000));
    store.add(rec('log', 'hello', 2000));

    const m = msgs();
    expect(m).toHaveLength(2);
    expect(m[0]).toMatchObject({
      k: 'entry',
      t: 'network',
      s: 0,
      ts: 1000,
      mono: 5,
      o: 900,
      red: false,
      p: '{"u":"x"}',
    });
    expect(m[1]).toMatchObject({ k: 'entry', t: 'log', s: 1, ts: 2000, p: 'hello' }); // seq incremented
  });

  it('stamps mono/timeOrigin from the injected sources', () => {
    const { bridge, msgs } = recordingBridge();
    let t = 10;
    const store = createHostBridgeCaptureStore({ bridge, now: () => t++, timeOrigin: 777 });
    store.add(rec('log', 'a'));
    store.add(rec('log', 'b'));
    expect(msgs().map((x) => x.mono)).toEqual([10, 11]); // now() read per entry
    expect(msgs().every((x) => x.o === 777)).toBe(true);
  });

  it('defaults mono to performance.now() and timeOrigin to performance.timeOrigin (not swapped)', () => {
    vi.spyOn(performance, 'now').mockReturnValue(4242);
    const { bridge, msgs } = recordingBridge();
    const store = createHostBridgeCaptureStore({ bridge }); // no now/timeOrigin injected
    store.add(rec('log', 'a'));
    const m = msgs()[0] as EntryMessage;
    expect(m.mono).toBe(4242); // from performance.now() — a now/timeOrigin swap would fail this
    expect(m.o).toBe(performance.timeOrigin); // from performance.timeOrigin
  });

  it('snapshot() is an empty, releasable view (native owns the ring — no local export)', async () => {
    const { bridge } = recordingBridge();
    const store = createHostBridgeCaptureStore({ bridge });
    store.add(rec('log', 'a'));
    const snap = store.snapshot();
    const streamed: StoredEntry[] = [];
    for await (const e of snap.stream()) streamed.push(e);
    expect(streamed).toEqual([]);
    expect([...(await snap.drainAll()).keys()]).toEqual([]);
    expect(() => snap.release()).not.toThrow();
  });

  it('tick() and clear() are no-ops (native owns the rolling window) and never post', () => {
    const { bridge, msgs } = recordingBridge();
    const store = createHostBridgeCaptureStore({ bridge });
    expect(() => store.tick(1234)).not.toThrow();
    expect(() => store.clear()).not.toThrow();
    expect(msgs()).toEqual([]); // neither posts
  });
});
