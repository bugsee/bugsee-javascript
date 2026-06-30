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

  it('stamps the `red` provenance flag per entry from redactedFor(type) (D3)', () => {
    const { bridge, msgs } = recordingBridge();
    // A network filter is configured but not a log filter → only network entries cross as redacted.
    const store = createHostBridgeCaptureStore({
      bridge,
      redactedFor: (type) => type === 'network',
    });
    store.add(rec('network', '{"u":"x"}'));
    store.add(rec('log', 'hello'));
    const m = msgs();
    expect(m[0]).toMatchObject({ t: 'network', red: true }); // a JS network filter ran
    expect(m[1]).toMatchObject({ t: 'log', red: false }); // no JS log filter → native redacts
  });

  it('defaults `red` to false when no redactedFor is injected (native redacts)', () => {
    const { bridge, msgs } = recordingBridge();
    const store = createHostBridgeCaptureStore({ bridge });
    store.add(rec('network', 'x'));
    expect(msgs()[0]?.red).toBe(false);
  });

  it('draws seq from an injected counter (shared with the report path) when provided', () => {
    const { bridge, msgs } = recordingBridge();
    let n = 100;
    const store = createHostBridgeCaptureStore({ bridge, seq: () => n++ });
    store.add(rec('log', 'a'));
    store.add(rec('log', 'b'));
    expect(msgs().map((m) => m.s)).toEqual([100, 101]); // the injected counter, not an internal 0,1
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

  it('drops entries while paused (control pause/resume) and resumes streaming', () => {
    const { bridge, msgs } = recordingBridge();
    let paused = false;
    const store = createHostBridgeCaptureStore({ bridge, paused: () => paused });
    store.add(rec('log', 'before'));
    paused = true;
    store.add(rec('log', 'while-paused')); // dropped — no bridge crossing while backgrounded
    paused = false;
    store.add(rec('log', 'after'));
    expect(msgs().map((m) => m.p)).toEqual(['before', 'after']); // the paused entry never crossed
  });

  it('tick() and clear() are no-ops (native owns the rolling window) and never post', () => {
    const { bridge, msgs } = recordingBridge();
    const store = createHostBridgeCaptureStore({ bridge });
    expect(() => store.tick(1234)).not.toThrow();
    expect(() => store.clear()).not.toThrow();
    expect(msgs()).toEqual([]); // neither posts
  });
});
