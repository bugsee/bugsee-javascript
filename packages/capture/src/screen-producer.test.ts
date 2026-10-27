import { ScreenTracker } from '@bugsee/core';
import { describe, expect, it } from 'vitest';
import { ScreenProducer } from './screen-producer';
import type { TraceSink } from './trace-producer';

const mk = () => {
  const got: Array<{ name: string; value: unknown; hold: unknown; displayId: unknown }> = [];
  const sink: TraceSink = {
    emit: (name, value, displayId, options) =>
      got.push({ name, value, hold: options?.hold, displayId }),
  };
  return { got, sink };
};

describe('ScreenProducer: the `route` and `view` traces', () => {
  it('is named `screen` and writes nothing at start when nothing was set (never a fabricated value)', () => {
    const tracker = new ScreenTracker();
    const { got, sink } = mk();
    const p = new ScreenProducer(tracker);
    expect(p.name).toBe('screen');
    p.start(sink);
    expect(got).toEqual([]);
  });

  it('writes the route and the view that were set before it started (a baseline), held', () => {
    const tracker = new ScreenTracker();
    tracker.setRoute('/orders/:id');
    tracker.setView({ name: 'OrderDetail', type: 'angular' });
    const { got, sink } = mk();
    new ScreenProducer(tracker).start(sink);
    expect(got).toEqual([
      { name: 'route', value: '/orders/:id', hold: true, displayId: undefined },
      {
        name: 'view',
        value: { name: 'OrderDetail', type: 'angular' },
        hold: true,
        displayId: undefined,
      },
    ]);
  });

  it('writes the "$$none" view as the bare string', () => {
    const tracker = new ScreenTracker();
    tracker.setView('$$none');
    const { got, sink } = mk();
    new ScreenProducer(tracker).start(sink);
    expect(got.map((g) => [g.name, g.value])).toEqual([['view', '$$none']]);
  });

  it('writes each later change, de-duplicated', () => {
    const tracker = new ScreenTracker();
    const { got, sink } = mk();
    new ScreenProducer(tracker).start(sink);
    tracker.setRoute('/a');
    tracker.setRoute('/a');
    tracker.setRoute('/b');
    tracker.setView({ name: 'A1' });
    tracker.setView({ name: 'A1' });
    tracker.setView('$$none');
    expect(got.map((g) => [g.name, g.value])).toEqual([
      ['route', '/a'],
      ['route', '/b'],
      ['view', { name: 'A1' }],
      ['view', '$$none'],
    ]);
  });

  it('writes nothing after stop, and a restart writes the held baseline again', () => {
    const tracker = new ScreenTracker();
    const { got, sink } = mk();
    const p = new ScreenProducer(tracker);
    p.start(sink);
    tracker.setRoute('/a');
    p.stop();
    tracker.setRoute('/b');
    expect(got.map((g) => g.value)).toEqual(['/a']);
    p.start(sink);
    expect(got.map((g) => g.value)).toEqual(['/a', '/b']);
    tracker.setRoute('/c');
    expect(got.map((g) => g.value)).toEqual(['/a', '/b', '/c']);
  });

  it('later changes are written HELD (re-recorded by the provider), like the baseline', () => {
    const tracker = new ScreenTracker();
    const { got, sink } = mk();
    new ScreenProducer(tracker).start(sink);
    tracker.setRoute('/a');
    tracker.setView({ name: 'A1' });
    expect(got.map((g) => [g.name, g.hold])).toEqual([
      ['route', true],
      ['view', true],
    ]);
  });

  it('subscribing activates the tracker and stopping releases it (a stopped producer leaves it idle)', () => {
    class Probe extends ScreenTracker {
      activations = 0;
      deactivations = 0;
      protected override onActivate(): void {
        this.activations += 1;
      }
      protected override onDeactivate(): void {
        this.deactivations += 1;
      }
    }
    const tracker = new Probe();
    const p = new ScreenProducer(tracker);
    p.start(mk().sink);
    expect([tracker.activations, tracker.deactivations]).toEqual([1, 0]);
    p.stop();
    p.stop(); // idempotent
    expect([tracker.activations, tracker.deactivations]).toEqual([1, 1]);
    p.start(mk().sink); // restartable
    expect([tracker.activations, tracker.deactivations]).toEqual([2, 1]);
  });
});
