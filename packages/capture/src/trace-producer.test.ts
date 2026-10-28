import type { TraceName } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import { TraceProducerBase, type TraceSink } from './trace-producer';

type Emitted = { name: string; value: unknown; displayId?: number };
const mkSink = (): { sink: TraceSink; got: Emitted[]; holds: unknown[] } => {
  const got: Emitted[] = [];
  const holds: unknown[] = [];
  return {
    got,
    holds,
    sink: {
      emit: (name, value, displayId, options) => {
        got.push({ name, value, ...(displayId !== undefined ? { displayId } : {}) });
        holds.push(options?.hold);
      },
    },
  };
};

class Probe extends TraceProducerBase {
  readonly name = 'probe';
  starts = 0;
  stops = 0;
  // arbitrary names on purpose: the base class is name-agnostic (only real producers are typed to the registry)
  emitAll: (n: string, v: unknown, d?: number) => void = (n, v, d) =>
    this.emit(n as TraceName, v, d);
  emitChanged: (n: string, v: unknown, d?: number) => void = (n, v, d) =>
    this.emitIfChanged(n as TraceName, v, d);
  protected onStart(): void {
    this.starts += 1;
  }
  protected override onStop(): void {
    this.stops += 1;
  }
}

describe('TraceProducerBase.poll', () => {
  class Poller extends Probe {
    run(fn: () => void): void {
      this.poll(fn);
    }
  }
  const clockSink = (): { sink: TraceSink; stamps: Array<number | undefined> } => {
    const stamps: Array<number | undefined> = [];
    let t = 100;
    return {
      stamps,
      sink: {
        emit: (_n, _v, _d, o) => void stamps.push(o?.timestamp),
        now: () => (t += 1),
      },
    };
  };

  it('stamps every emit of one poll with a single sink-clock timestamp, then clears it', () => {
    const p = new Poller();
    const { sink, stamps } = clockSink();
    p.start(sink);
    p.run(() => {
      p.emitAll('a', 1);
      p.emitAll('b', 2);
      p.run(() => p.emitAll('c', 3)); // nested: same poll
    });
    p.emitAll('d', 4); // outside a poll: left to the sink
    p.run(() => p.emitAll('e', 5)); // a new poll takes a new timestamp
    expect(stamps).toEqual([101, 101, 101, undefined, 102]);
  });

  it('clears the poll timestamp when fn throws', () => {
    const p = new Poller();
    const { sink, stamps } = clockSink();
    p.start(sink);
    expect(() =>
      p.run(() => {
        throw new Error('x');
      }),
    ).toThrow('x');
    p.emitAll('a', 1);
    expect(stamps).toEqual([undefined]);
  });

  it('a sink without a clock leaves per-emit stamping; before start() it just runs fn', () => {
    const p = new Poller();
    const { sink, got } = mkSink();
    let ran = false;
    p.run(() => (ran = true));
    expect(ran).toBe(true);
    p.start(sink);
    p.run(() => p.emitAll('a', 1));
    expect(got).toHaveLength(1);
  });
});

describe('TraceProducerBase', () => {
  it('start() is idempotent and calls onStart once', () => {
    const p = new Probe();
    const { sink } = mkSink();
    p.start(sink);
    p.start(sink);
    expect(p.starts).toBe(1);
  });

  it('stop() is idempotent, a no-op before start, and calls onStop once', () => {
    const p = new Probe();
    const { sink } = mkSink();
    p.stop();
    expect(p.stops).toBe(0);
    p.start(sink);
    p.stop();
    p.stop();
    expect(p.stops).toBe(1);
  });

  it('emit() always forwards; after stop() it is dropped (late callbacks cannot write)', () => {
    const p = new Probe();
    const { sink, got } = mkSink();
    p.start(sink);
    p.emitAll('a', 1);
    p.emitAll('a', 1);
    p.stop();
    p.emitAll('a', 2);
    expect(got).toEqual([
      { name: 'a', value: 1 },
      { name: 'a', value: 1 },
    ]);
  });

  it('emitIfChanged() drops equal consecutive values per name+display (primitives)', () => {
    const p = new Probe();
    const { sink, got } = mkSink();
    p.start(sink);
    p.emitChanged('a', 1);
    p.emitChanged('a', 1);
    p.emitChanged('a', 2);
    p.emitChanged('a', 1);
    expect(got.map((g) => g.value)).toEqual([1, 2, 1]);
  });

  it('emitIfChanged() compares objects structurally', () => {
    const p = new Probe();
    const { sink, got } = mkSink();
    p.start(sink);
    p.emitChanged('c', { state: 2 });
    p.emitChanged('c', { state: 2 });
    p.emitChanged('c', { state: 3 });
    expect(got.map((g) => g.value)).toEqual([{ state: 2 }, { state: 3 }]);
  });

  it('emitIfChanged() never throws on circular values: distinct circulars count as changed, same ref as unchanged', () => {
    const p = new Probe();
    const { sink, got } = mkSink();
    p.start(sink);
    const a: Record<string, unknown> = { n: 1 };
    a.self = a;
    const b: Record<string, unknown> = { n: 1 };
    b.self = b;
    expect(() => {
      p.emitChanged('c', a);
      p.emitChanged('c', a);
      p.emitChanged('c', b);
    }).not.toThrow();
    expect(got.map((g) => g.value)).toEqual([a, b]);
  });

  it('emitIfChanged() never throws when toJSON throws; counts as changed', () => {
    const p = new Probe();
    const { sink, got } = mkSink();
    p.start(sink);
    const mk = (): object => ({
      toJSON: () => {
        throw new Error('boom');
      },
    });
    expect(() => {
      p.emitChanged('c', mk());
      p.emitChanged('c', mk());
    }).not.toThrow();
    expect(got).toHaveLength(2);
  });

  it('emitIfChanged() handles BigInt inside objects structurally and never throws', () => {
    const p = new Probe();
    const { sink, got } = mkSink();
    p.start(sink);
    expect(() => {
      p.emitChanged('c', { v: 1n });
      p.emitChanged('c', { v: 1n });
      p.emitChanged('c', { v: 2n });
    }).not.toThrow();
    expect(got.map((g) => g.value)).toEqual([{ v: 1n }, { v: 2n }]);
  });

  it('emitIfChanged() distinguishes a BigInt from the same-looking string inside objects', () => {
    const p = new Probe();
    const { sink, got } = mkSink();
    p.start(sink);
    p.emitChanged('c', { v: 1n });
    p.emitChanged('c', { v: '1' });
    expect(got).toHaveLength(2);
  });

  it('emitIfChanged() tracks each name and displayId separately', () => {
    const p = new Probe();
    const { sink, got } = mkSink();
    p.start(sink);
    p.emitChanged('a', 1);
    p.emitChanged('b', 1);
    p.emitChanged('a', 1, 0);
    p.emitChanged('a', 1, 0);
    expect(got).toEqual([
      { name: 'a', value: 1 },
      { name: 'b', value: 1 },
      { name: 'a', value: 1, displayId: 0 },
    ]);
  });

  it('a restart clears the dedup state, so the baseline re-emits', () => {
    const p = new Probe();
    const { sink, got } = mkSink();
    p.start(sink);
    p.emitChanged('a', 1);
    p.stop();
    p.start(sink);
    p.emitChanged('a', 1);
    expect(got).toHaveLength(2);
  });

  it('emit() marks the value NOT held (a polled value must not be refreshed by the provider)', () => {
    const p = new Probe();
    const { sink, holds } = mkSink();
    p.start(sink);
    p.emitAll('cpu', 1);
    p.emitAll('cpu', 1, 0);
    expect(holds).toEqual([false, false]);
  });

  it('emitIfChanged() marks the value HELD (a change-driven value is refreshed by the provider)', () => {
    const p = new Probe();
    const { sink, holds } = mkSink();
    p.start(sink);
    p.emitChanged('battery', 50);
    p.emitChanged('battery', 50); // dropped: no second emit
    p.emitChanged('battery', 40, 0);
    expect(holds).toEqual([true, true]);
  });

  it('stop() still drops the sink when onStop throws', () => {
    class Throwing extends Probe {
      protected override onStop(): void {
        throw new Error('boom');
      }
    }
    const p = new Throwing();
    const { sink, got } = mkSink();
    p.start(sink);
    expect(() => p.stop()).toThrow('boom');
    p.emitAll('a', 1); // dropped
    expect(got).toEqual([]);
  });

  it('onStop() defaults to a no-op for producers that do not override it', () => {
    class Minimal extends TraceProducerBase {
      readonly name = 'minimal';
      protected onStart(): void {}
    }
    const p = new Minimal();
    const { sink } = mkSink();
    p.start(sink);
    expect(() => p.stop()).not.toThrow();
  });
});
