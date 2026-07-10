import { describe, expect, it, vi } from 'vitest';
import type { StoredEntry } from './contracts';
import {
  type StreamingCaptureEntry,
  createStreamingCaptureStore,
} from './streaming-capture-store';

const entry = (type: string, timestamp: number, serialized: string): StoredEntry =>
  ({ type, timestamp, serialized }) as StoredEntry;

/** A store wired to a recording `post` + a passthrough encoder that just returns the entry object. */
function harness(overrides: Partial<Parameters<typeof createStreamingCaptureStore>[0]> = {}) {
  const posted: string[] = [];
  const encoded: StreamingCaptureEntry[] = [];
  const store = createStreamingCaptureStore({
    post: (raw) => posted.push(raw),
    encodeEntry: (e) => {
      encoded.push(e);
      return JSON.stringify(e);
    },
    now: () => 111,
    timeOrigin: 222,
    ...overrides,
  });
  return { store, posted, encoded };
}

describe('createStreamingCaptureStore', () => {
  it('encodes + posts each added entry with type/timestamp/mono/timeOrigin/payload', () => {
    const { store, posted, encoded } = harness();
    store.add(entry('network', 1000, '{"url":"x"}'));
    expect(posted).toHaveLength(1);
    expect(encoded[0]).toMatchObject({
      type: 'network',
      timestamp: 1000,
      mono: 111,
      timeOrigin: 222,
      payload: '{"url":"x"}',
      redacted: false,
    });
  });

  it('assigns a monotonically increasing seq by default', () => {
    const { store, encoded } = harness();
    store.add(entry('log', 1, 'a'));
    store.add(entry('log', 2, 'b'));
    expect(encoded[0]?.seq).toBe(0);
    expect(encoded[1]?.seq).toBe(1);
  });

  it('uses an injected seq source when provided', () => {
    const seq = vi.fn(() => 77);
    const { store, encoded } = harness({ seq });
    store.add(entry('log', 1, 'a'));
    expect(encoded[0]?.seq).toBe(77);
  });

  it('stamps redaction provenance from redactedFor(type)', () => {
    const { store, encoded } = harness({ redactedFor: (t) => t === 'network' });
    store.add(entry('network', 1, 'a'));
    store.add(entry('log', 2, 'b'));
    expect(encoded[0]?.redacted).toBe(true);
    expect(encoded[1]?.redacted).toBe(false);
  });

  it('drops entries (no post) while paused', () => {
    let isPaused = true;
    const { store, posted } = harness({ paused: () => isPaused });
    store.add(entry('log', 1, 'a'));
    expect(posted).toHaveLength(0);
    isPaused = false;
    store.add(entry('log', 2, 'b'));
    expect(posted).toHaveLength(1);
  });

  it('snapshot() is an empty, releasable view (nothing buffered locally)', async () => {
    const { store } = harness();
    store.add(entry('log', 1, 'a'));
    const snap = store.snapshot();
    const seen: StoredEntry[] = [];
    for await (const r of snap.stream()) seen.push(r);
    expect(seen).toEqual([]);
    expect(await snap.drainAll()).toEqual(new Map());
    expect(() => snap.release()).not.toThrow();
  });

  it('tick()/clear() are no-ops (native/host owns the window)', () => {
    const { store, posted } = harness();
    expect(() => store.tick(123)).not.toThrow();
    expect(() => store.clear()).not.toThrow();
    expect(posted).toHaveLength(0);
  });

  it('defaults now/timeOrigin to the ambient performance when not injected', () => {
    const posted: string[] = [];
    const store = createStreamingCaptureStore({
      post: (raw) => posted.push(raw),
      encodeEntry: (e) => JSON.stringify(e),
    });
    expect(() => store.add(entry('log', 1, 'a'))).not.toThrow();
    expect(posted).toHaveLength(1);
  });
});
