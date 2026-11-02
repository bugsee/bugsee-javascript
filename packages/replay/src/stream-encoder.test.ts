import { CaptureDataEntryBase } from '@bugsee/core';
import { gunzipSync, strFromU8 } from 'fflate';
import { describe, expect, it } from 'vitest';
import { encodeReplay } from './encoder';
import { createReplayStreamEncoder } from './stream-encoder';

const META = 4;
const FULL = 2;
const INC = 3;
const ev = (type: number, timestamp: number, extra: Record<string, unknown> = {}) => ({
  type,
  timestamp,
  data: { n: `${type}@${timestamp}`, ...extra },
});

function encode(
  events: unknown[],
  plan: { start: number | undefined; end: number } = { start: undefined, end: 10_000 },
) {
  const session = createReplayStreamEncoder().begin(plan);
  const chunks: Uint8Array[] = [];
  for (const e of events) {
    chunks.push(
      ...session.write(
        new CaptureDataEntryBase('replay', (e as { timestamp?: number } | null)?.timestamp ?? 0, e),
      ),
    );
  }
  chunks.push(...session.end());
  const total = chunks.reduce((n, c) => n + c.length, 0);
  const bytes = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    bytes.set(c, at);
    at += c.length;
  }
  return { bytes, produced: total > 0 };
}
const decode = (bytes: Uint8Array): Array<{ type: number; timestamp: number }> =>
  JSON.parse(strFromU8(gunzipSync(bytes)));
const shape = (events: Array<{ type: number; timestamp: number }>) =>
  events.map((e) => `${e.type}@${e.timestamp}`);

describe('createReplayStreamEncoder', () => {
  it('writes a gzip of the JSON event array that decodes to exactly what the one-shot encoder encodes for a clean stream', () => {
    const events = [ev(META, 100), ev(FULL, 100), ev(INC, 116), ev(INC, 132)];
    const { bytes } = encode(events);
    expect(bytes[0]).toBe(0x1f);
    expect(bytes[1]).toBe(0x8b);
    expect(decode(bytes)).toEqual(events);
    expect(decode(bytes)).toEqual(decode(encodeReplay(events)));
  });

  it('drops events before the first Meta+FullSnapshot pair (orphans of an evicted base)', () => {
    const { bytes } = encode([ev(INC, 10), ev(INC, 20), ev(META, 30), ev(FULL, 30), ev(INC, 40)]);
    expect(shape(decode(bytes))).toEqual(['4@30', '2@30', '3@40']);
  });

  it('keeps the LAST Meta before the base when several precede it', () => {
    const { bytes } = encode([ev(META, 1), ev(META, 2), ev(FULL, 2), ev(INC, 3)]);
    expect(shape(decode(bytes))).toEqual(['4@2', '2@2', '3@3']);
  });

  it('drops a FullSnapshot that has no Meta directly before it, and a Meta with another event after it', () => {
    const { bytes } = encode([
      ev(FULL, 1),
      ev(META, 2),
      ev(INC, 3),
      ev(FULL, 4),
      ev(META, 5),
      ev(FULL, 5),
      ev(INC, 6),
    ]);
    expect(shape(decode(bytes))).toEqual(['4@5', '2@5', '3@6']);
  });

  it('keeps later Meta/FullSnapshot pairs (checkouts) and everything after the base', () => {
    const events = [ev(META, 1), ev(FULL, 1), ev(INC, 2), ev(META, 3), ev(FULL, 3), ev(INC, 4)];
    expect(decode(encode(events).bytes)).toEqual(events);
  });

  it('produces no bytes at all when no base exists', () => {
    const { produced } = encode([ev(INC, 1), ev(FULL, 2), ev(META, 3)]);
    expect(produced).toBe(false);
  });

  it('produces no bytes for no events', () => {
    expect(encode([]).produced).toBe(false);
  });

  it('clamps events older than the plan start to the plan start, in order, leaving later ones alone', () => {
    const { bytes } = encode(
      [ev(META, 100), ev(FULL, 100), ev(INC, 150), ev(INC, 200), ev(INC, 300)],
      { start: 200, end: 1000 },
    );
    expect(shape(decode(bytes))).toEqual(['4@200', '2@200', '3@200', '3@200', '3@300']);
  });

  it('clamps only strictly older events: start-1 is clamped, start and start+1 are kept', () => {
    const { bytes } = encode([ev(META, 199), ev(FULL, 199), ev(INC, 200), ev(INC, 201)], {
      start: 200,
      end: 1000,
    });
    expect(shape(decode(bytes))).toEqual(['4@200', '2@200', '3@200', '3@201']);
  });

  it('does not clamp an event exactly at the plan start, and keeps its payload', () => {
    const { bytes } = encode([ev(META, 200, { w: 1 }), ev(FULL, 200, { w: 2 })], {
      start: 200,
      end: 1000,
    });
    expect(decode(bytes)).toEqual([ev(META, 200, { w: 1 }), ev(FULL, 200, { w: 2 })]);
  });

  it('clamping keeps the rest of the event untouched and does not mutate the captured entry', () => {
    const base = ev(FULL, 50, { deep: { a: [1, 2] } });
    const session = createReplayStreamEncoder().begin({ start: 200, end: 1000 });
    session.write(new CaptureDataEntryBase('replay', 50, ev(META, 50)));
    const chunks = [
      ...session.write(new CaptureDataEntryBase('replay', 50, base)),
      ...session.end(),
    ];
    expect(base.timestamp).toBe(50);
    const total = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      total.set(c, at);
      at += c.length;
    }
    expect((decode(total)[1] as unknown as typeof base).data).toEqual(base.data);
  });

  it('with no plan start nothing is clamped', () => {
    const events = [ev(META, 1), ev(FULL, 1), ev(INC, 5)];
    expect(decode(encode(events, { start: undefined, end: 9 }).bytes)).toEqual(events);
  });

  it('passes non-object payloads after the base through unchanged and drops them before it', () => {
    const { bytes } = encode(['junk', ev(META, 1), ev(FULL, 1), 'tail', null]);
    expect(decode(bytes)).toEqual([ev(META, 1), ev(FULL, 1), 'tail', null]);
  });

  it('with a plan start, leaves null, primitive and undefined events after the base alone (undefined reads null)', () => {
    const { bytes } = encode([ev(META, 300), ev(FULL, 300), null, 'x', undefined, ev(INC, 100)], {
      start: 200,
      end: 1000,
    });
    expect(decode(bytes)).toEqual([
      ev(META, 300),
      ev(FULL, 300),
      null,
      'x',
      null,
      { ...ev(INC, 100), timestamp: 200 },
    ]);
  });

  it('streams: output appears before end() and the chunks concatenate to exactly the event array', () => {
    const events = [
      ev(META, 1),
      ev(FULL, 1),
      ...Array.from({ length: 3000 }, (_, i) => ev(INC, 2 + i, { pad: `${i}-${'x'.repeat(100)}` })),
    ];
    const session = createReplayStreamEncoder().begin({ start: undefined, end: 9 });
    const chunks: Uint8Array[] = [];
    let beforeEnd = 0;
    for (const e of events) {
      for (const c of session.write(new CaptureDataEntryBase('replay', 1, e))) {
        chunks.push(c);
        beforeEnd += 1;
      }
    }
    expect(beforeEnd).toBeGreaterThan(1); // several gzip chunks left before end()
    chunks.push(...session.end());
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    expect(decode(bytes)).toEqual(events);
  });

  it('a base whose FullSnapshot cannot be serialized leaves no half base: later events stay orphans', () => {
    const cyclic: Record<string, unknown> = { type: 2, timestamp: 1 };
    cyclic.self = cyclic;
    const session = createReplayStreamEncoder().begin({ start: undefined, end: 9 });
    session.write(new CaptureDataEntryBase('replay', 1, ev(META, 1)));
    expect(() => session.write(new CaptureDataEntryBase('replay', 1, cyclic))).toThrow();
    expect(session.write(new CaptureDataEntryBase('replay', 2, ev(INC, 2)))).toEqual([]);
    // ...and a later healthy base still opens the stream, with nothing of the failed one before it.
    const chunks = [
      ...session.write(new CaptureDataEntryBase('replay', 3, ev(META, 3))),
      ...session.write(new CaptureDataEntryBase('replay', 3, ev(FULL, 3))),
      ...session.end(),
    ];
    const bytes = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of chunks) {
      bytes.set(c, at);
      at += c.length;
    }
    expect(shape(decode(bytes))).toEqual(['4@3', '2@3']);
  });

  it('end() twice and write() after end() do not throw or duplicate output', () => {
    const session = createReplayStreamEncoder().begin({ start: undefined, end: 9 });
    session.write(new CaptureDataEntryBase('replay', 1, ev(META, 1)));
    session.write(new CaptureDataEntryBase('replay', 1, ev(FULL, 1)));
    const first = session.end();
    expect(first.length).toBeGreaterThan(0);
    expect(session.end()).toEqual([]);
    expect(session.write(new CaptureDataEntryBase('replay', 2, ev(INC, 2)))).toEqual([]);
  });

  it('an object event without a numeric timestamp passes through unclamped', () => {
    const { bytes } = encode([ev(META, 300), ev(FULL, 300), { type: 3, data: {} }], {
      start: 200,
      end: 1000,
    });
    expect(decode(bytes)[2]).toEqual({ type: 3, data: {} });
  });
});
