import type { SystemEvent } from '@bugsee/capture';
import { type EventSubscribable, InterceptorBase } from '@bugsee/core';
import { ElectronProcessTracker } from '@bugsee/trackers/electron';
import { describe, expect, it, vi } from 'vitest';
import { createElectronSystemEventsSource } from './system-events';

type Events = { event: SystemEvent };

/** Stands in for the node events source: emits process_started on activation, tracks active/idle. */
class FakeInner extends InterceptorBase<Events> {
  readonly name = 'fake-inner';
  activations = 0;
  deactivations = 0;
  protected onActivate(): void {
    this.activations++;
    this.emit('event', { name: 'process_started' });
  }
  protected override onDeactivate(): void {
    this.deactivations++;
  }
  fire(event: SystemEvent): void {
    this.emit('event', event);
  }
}

function setup() {
  const listeners: Array<(event: unknown, details: unknown) => void> = [];
  const app = {
    on: vi.fn((_e: string, l: (event: unknown, details: unknown) => void) => {
      listeners.push(l);
    }),
    removeListener: vi.fn((_e: string, l: (event: unknown, details: unknown) => void) => {
      const i = listeners.indexOf(l);
      if (i >= 0) listeners.splice(i, 1);
    }),
  };
  const onError = vi.fn();
  const tracker = new ElectronProcessTracker({ app }, onError);
  const inner = new FakeInner();
  const mux = createElectronSystemEventsSource(inner, tracker, onError);
  return { app, listeners, tracker, inner, mux, onError };
}

const names = (seen: ReturnType<typeof vi.fn>) =>
  seen.mock.calls.map((c) => (c[0] as SystemEvent).name);

describe('createElectronSystemEventsSource (lazy mux)', () => {
  it('attaches NOTHING at construction: no inner subscription, no app listener', () => {
    const { app, inner, mux, tracker } = setup();
    expect(inner.activations).toBe(0);
    expect(app.on).not.toHaveBeenCalled();
    expect(mux).toBeDefined();
    tracker.reset();
  });

  it('on subscribe: attaches the inner source AND child-process-gone; process_started arrives exactly once', () => {
    const { app, inner, mux, listeners, tracker } = setup();
    const seen = vi.fn();
    mux.on('event', seen);
    expect(inner.activations).toBe(1);
    expect(app.on).toHaveBeenCalledExactlyOnceWith('child-process-gone', expect.any(Function));
    expect(names(seen)).toEqual(['process_started']);
    inner.fire({ name: 'process_exiting', params: { code: 0 } });
    expect(names(seen)).toEqual(['process_started', 'process_exiting']);
    expect(listeners).toHaveLength(1);
    tracker.reset();
  });

  it('forwards the inner events untouched, params included', () => {
    const { inner, mux, tracker } = setup();
    const seen = vi.fn();
    mux.on('event', seen);
    inner.fire({ name: 'process_signal', params: { signal: 'SIGTERM' } });
    expect(seen).toHaveBeenLastCalledWith({
      name: 'process_signal',
      params: { signal: 'SIGTERM' },
    });
    tracker.reset();
  });

  it('records child_process_gone with {type, reason, exitCode?, name?} and no undefined keys', () => {
    const { mux, listeners, tracker } = setup();
    const seen = vi.fn();
    mux.on('event', seen);
    listeners[0]?.({}, { type: 'GPU', reason: 'crashed', exitCode: 139, name: 'GPU Process' });
    listeners[0]?.({}, { type: 'Utility', reason: 'oom' });
    expect(seen.mock.calls.slice(1).map((c) => c[0])).toEqual([
      {
        name: 'child_process_gone',
        params: { type: 'GPU', reason: 'crashed', exitCode: 139, name: 'GPU Process' },
      },
      { name: 'child_process_gone', params: { type: 'Utility', reason: 'oom' } },
    ]);
    expect(Object.keys((seen.mock.calls[2]?.[0] as SystemEvent).params ?? {})).toEqual([
      'type',
      'reason',
    ]);
    tracker.reset();
  });

  it('the last unsubscribe releases BOTH: inner deactivated, the very same app listener removed', () => {
    const { app, inner, mux, listeners, tracker } = setup();
    const off1 = mux.on('event', vi.fn());
    const off2 = mux.on('event', vi.fn());
    expect(inner.activations).toBe(1); // one attach however many subscribers
    off1();
    expect(inner.deactivations).toBe(0);
    expect(listeners).toHaveLength(1);
    off2();
    expect(inner.deactivations).toBe(1);
    expect(listeners).toHaveLength(0);
    expect(app.removeListener).toHaveBeenCalledExactlyOnceWith(
      'child-process-gone',
      app.on.mock.calls[0]?.[1],
    );
    tracker.reset();
  });

  it('re-subscribing after release attaches again (and process_started fires again with the inner source)', () => {
    const { app, inner, mux, tracker } = setup();
    mux.on('event', vi.fn())();
    const seen = vi.fn();
    mux.on('event', seen);
    expect(inner.activations).toBe(2);
    expect(app.on).toHaveBeenCalledTimes(2);
    expect(names(seen)).toEqual(['process_started']);
    tracker.reset();
  });

  it('a failing release of one side cannot strand the other (reported)', () => {
    const { app, inner, mux, listeners, onError, tracker } = setup();
    const off = mux.on('event', vi.fn());
    const boom = new Error('inner off');
    const innerOff = vi.spyOn(inner, 'off').mockImplementation(() => {
      throw boom;
    });
    off();
    expect(innerOff).toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(boom);
    expect(listeners).toHaveLength(0);
    expect(app.removeListener).toHaveBeenCalledTimes(1);
    tracker.reset();
  });

  it('a throwing subscriber cannot break the other side (isolated + reported)', () => {
    const { mux, listeners, onError, tracker } = setup();
    const ok = vi.fn();
    const boom = new Error('subscriber');
    mux.on('event', () => {
      throw boom;
    });
    mux.on('event', ok);
    listeners[0]?.({}, { type: 'GPU', reason: 'killed' });
    expect(names(ok)).toContain('child_process_gone');
    expect(onError).toHaveBeenCalledWith(boom);
    tracker.reset();
  });

  it('exposes the standard subscribable surface', () => {
    const { mux, tracker } = setup();
    const sub: EventSubscribable<Events> = mux;
    expect(typeof sub.on).toBe('function');
    tracker.reset();
  });
});
