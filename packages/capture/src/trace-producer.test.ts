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
