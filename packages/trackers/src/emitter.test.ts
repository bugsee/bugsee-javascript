import { describe, expect, it, vi } from 'vitest';
import { createMultiKeyEmitter, MultiKeyEmitterBase } from './emitter';

interface M {
  before: { url: string };
  complete: { status: number };
}

const mk = (onErr?: (e: unknown) => void) => new MultiKeyEmitterBase<M>(onErr);

describe('MultiKeyEmitterBase — on / emit', () => {
  it('delivers a payload to the listener of the emitted channel only', () => {
    const e = mk();
    const before = vi.fn();
    const complete = vi.fn();
    e.on('before', before);
    e.on('complete', complete);
    e.emit('before', { url: '/a' });
    expect(before).toHaveBeenCalledWith({ url: '/a' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('emit to a channel with no listeners is a no-op', () => {
    expect(() => mk().emit('before', { url: '/x' })).not.toThrow();
  });

  it('delivers to multiple listeners in subscription order', () => {
    const e = mk();
    const order: number[] = [];
    e.on('before', () => order.push(1));
    e.on('before', () => order.push(2));
    e.emit('before', { url: '/a' });
    expect(order).toEqual([1, 2]);
  });

  it('dedups the same listener reference (registered once, called once)', () => {
    const e = mk();
    const fn = vi.fn();
    e.on('before', fn);
    e.on('before', fn);
    e.emit('before', { url: '/a' });
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('on returns an idempotent unsubscribe', () => {
    const e = mk();
    const fn = vi.fn();
    const off = e.on('before', fn);
    e.emit('before', { url: '/1' });
    off();
    off();
    e.emit('before', { url: '/2' });
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe('MultiKeyEmitterBase — off / removeEventListener / removeAllListeners', () => {
  it('off removes a listener by reference', () => {
    const e = mk();
    const fn = vi.fn();
    e.on('before', fn);
    e.off('before', fn);
    e.emit('before', { url: '/a' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('off is a no-op for a channel that has no listeners', () => {
    expect(() => mk().off('before', vi.fn())).not.toThrow();
  });

  it('removeEventListener is an alias of off', () => {
    const e = mk();
    const fn = vi.fn();
    e.addEventListener('before', fn);
    e.removeEventListener('before', fn);
    e.emit('before', { url: '/a' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('removeAllListeners(name) clears only that channel', () => {
    const e = mk();
    const before = vi.fn();
    const complete = vi.fn();
    e.on('before', before);
    e.on('complete', complete);
    e.removeAllListeners('before');
    e.emit('before', { url: '/a' });
    e.emit('complete', { status: 200 });
    expect(before).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it('removeAllListeners() clears every channel', () => {
    const e = mk();
    const before = vi.fn();
    const complete = vi.fn();
    e.on('before', before);
    e.on('complete', complete);
    e.removeAllListeners();
    e.emit('before', { url: '/a' });
    e.emit('complete', { status: 200 });
    expect(before).not.toHaveBeenCalled();
    expect(complete).not.toHaveBeenCalled();
  });
});

describe('MultiKeyEmitterBase — addEventListener (alias of on)', () => {
  it('subscribes like on and returns a working unsubscribe', () => {
    const e = mk();
    const fn = vi.fn();
    const off = e.addEventListener('complete', fn);
    e.emit('complete', { status: 201 });
    off();
    e.emit('complete', { status: 500 });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ status: 201 });
  });
});

describe('MultiKeyEmitterBase — once', () => {
  it('fires the listener only on the next emit, then auto-unsubscribes', () => {
    const e = mk();
    const fn = vi.fn();
    e.once('before', fn);
    e.emit('before', { url: '/1' });
    e.emit('before', { url: '/2' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ url: '/1' });
  });

  it('the returned unsubscribe cancels a once listener before it fires', () => {
    const e = mk();
    const fn = vi.fn();
    const off = e.once('before', fn);
    off();
    e.emit('before', { url: '/a' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('off(original) cancels a once listener before it fires (Node parity)', () => {
    const e = mk();
    const fn = vi.fn();
    e.once('before', fn);
    e.off('before', fn);
    e.emit('before', { url: '/a' });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('MultiKeyEmitterBase — listener-error isolation', () => {
  it('routes a throwing listener to onListenerError and still runs the others', () => {
    const onErr = vi.fn();
    const e = mk(onErr);
    const after = vi.fn();
    e.on('before', () => {
      throw new Error('boom');
    });
    e.on('before', after);
    expect(() => e.emit('before', { url: '/a' })).not.toThrow();
    expect(after).toHaveBeenCalledWith({ url: '/a' });
    expect(onErr).toHaveBeenCalledTimes(1);
    expect((onErr.mock.calls[0]?.[0] as Error).message).toBe('boom');
  });

  it('a throwing listener without an onListenerError handler does not break emit', () => {
    const e = mk();
    e.on('before', () => {
      throw new Error('boom');
    });
    expect(() => e.emit('before', { url: '/a' })).not.toThrow();
  });

  it('a once listener still auto-unsubscribes when it throws', () => {
    const onErr = vi.fn();
    const e = mk(onErr);
    e.once('before', () => {
      throw new Error('boom');
    });
    e.emit('before', { url: '/1' }); // throws (isolated), removes itself
    e.emit('before', { url: '/2' }); // no second call
    expect(onErr).toHaveBeenCalledTimes(1);
  });
});

describe('MultiKeyEmitterBase — dispatch snapshot semantics', () => {
  it('a listener subscribed during dispatch is not called for the in-flight emit', () => {
    const e = mk();
    const late = vi.fn();
    e.on('before', () => {
      e.on('before', late);
    });
    e.emit('before', { url: '/a' });
    expect(late).not.toHaveBeenCalled();
    e.emit('before', { url: '/b' });
    expect(late).toHaveBeenCalledTimes(1);
  });

  it('a listener unsubscribed during dispatch is not called', () => {
    const e = mk();
    const second = vi.fn();
    e.on('before', () => e.off('before', second));
    e.on('before', second);
    e.emit('before', { url: '/a' });
    expect(second).not.toHaveBeenCalled();
  });
});

describe('MultiKeyEmitterBase — onAny', () => {
  it('delivers every channel with its name and payload', () => {
    const e = mk();
    const seen: Array<[string, unknown]> = [];
    e.onAny((name, payload) => seen.push([name, payload]));
    e.emit('before', { url: '/a' });
    e.emit('complete', { status: 204 });
    expect(seen).toEqual([
      ['before', { url: '/a' }],
      ['complete', { status: 204 }],
    ]);
  });

  it('fires even for a channel that has no per-channel listeners', () => {
    const e = mk();
    const fn = vi.fn();
    e.onAny(fn);
    e.emit('before', { url: '/a' }); // no on('before') listener exists
    expect(fn).toHaveBeenCalledWith('before', { url: '/a' });
  });

  it('fires per-channel listeners before onAny listeners', () => {
    const e = mk();
    const order: string[] = [];
    e.onAny(() => order.push('any'));
    e.on('before', () => order.push('named'));
    e.emit('before', { url: '/a' });
    expect(order).toEqual(['named', 'any']);
  });

  it('the returned unsubscribe stops onAny delivery', () => {
    const e = mk();
    const fn = vi.fn();
    const off = e.onAny(fn);
    off();
    e.emit('before', { url: '/a' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('isolates a throwing onAny listener', () => {
    const onErr = vi.fn();
    const e = mk(onErr);
    e.onAny(() => {
      throw new Error('boom');
    });
    expect(() => e.emit('before', { url: '/a' })).not.toThrow();
    expect(onErr).toHaveBeenCalledTimes(1);
  });

  it('removeAllListeners() also clears onAny listeners', () => {
    const e = mk();
    const fn = vi.fn();
    e.onAny(fn);
    e.removeAllListeners();
    e.emit('before', { url: '/a' });
    expect(fn).not.toHaveBeenCalled();
  });

  it('an onAny listener unsubscribed during dispatch is not called', () => {
    const e = mk();
    const second = vi.fn();
    let off2: () => void = () => {};
    e.onAny(() => off2());
    off2 = e.onAny(second);
    e.emit('before', { url: '/a' });
    expect(second).not.toHaveBeenCalled();
  });
});

class Probe extends MultiKeyEmitterBase<M> {
  readonly transitions: boolean[] = [];
  protected override onActiveChange(active: boolean): void {
    this.transitions.push(active);
  }
}

describe('MultiKeyEmitterBase — onActiveChange (listener presence)', () => {
  it('fires true on the first listener and false when the last leaves', () => {
    const e = new Probe();
    const off = e.on('before', () => {});
    expect(e.transitions).toEqual([true]);
    off();
    expect(e.transitions).toEqual([true, false]);
  });

  it('does not fire while the emitter stays non-empty (add/remove a second listener)', () => {
    const e = new Probe();
    e.on('before', () => {});
    e.transitions.length = 0; // ignore the initial true
    const offA = e.on('complete', () => {});
    expect(e.transitions).toEqual([]); // still active → no transition
    offA();
    expect(e.transitions).toEqual([]); // 'before' listener remains → no transition
  });

  it('counts onAny listeners toward presence', () => {
    const e = new Probe();
    const off = e.onAny(() => {});
    expect(e.transitions).toEqual([true]);
    off();
    expect(e.transitions).toEqual([true, false]);
  });

  it('does not fire when re-adding the same listener (dedup)', () => {
    const e = new Probe();
    const fn = () => {};
    e.on('before', fn);
    e.transitions.length = 0;
    e.on('before', fn);
    expect(e.transitions).toEqual([]);
  });

  it('fires false when removeAllListeners empties the emitter', () => {
    const e = new Probe();
    e.on('before', () => {});
    e.on('complete', () => {});
    e.transitions.length = 0;
    e.removeAllListeners();
    expect(e.transitions).toEqual([false]);
  });

  it('fires false when a once listener fires as the last listener', () => {
    const e = new Probe();
    e.once('before', () => {});
    e.transitions.length = 0;
    e.emit('before', { url: '/a' }); // once fires → auto-removes → now empty
    expect(e.transitions).toEqual([false]);
  });

  it('does not fire on off of an absent listener', () => {
    const e = new Probe();
    e.off('before', () => {});
    expect(e.transitions).toEqual([]);
  });
});

describe('createMultiKeyEmitter factory', () => {
  it('returns a working emitter (on/emit)', () => {
    const e = createMultiKeyEmitter<M>();
    const fn = vi.fn();
    e.on('complete', fn);
    e.emit('complete', { status: 204 });
    expect(fn).toHaveBeenCalledWith({ status: 204 });
  });
});
