import { describe, expect, it, vi } from 'vitest';
import { createHooks } from './hooks';

// A sample stage map: distinct payload types per channel pin the typing + per-channel dispatch.
interface StageMap {
  before: { url: string };
  complete: { status: number };
}

describe('createHooks — on / emit', () => {
  it('delivers a payload to the listener of the emitted channel', () => {
    const hooks = createHooks<StageMap>();
    const seen: Array<{ url: string }> = [];
    hooks.on('before', (p) => seen.push(p));
    hooks.emit('before', { url: '/a' });
    expect(seen).toEqual([{ url: '/a' }]);
  });

  it('does not deliver to listeners of other channels', () => {
    const hooks = createHooks<StageMap>();
    const before = vi.fn();
    const complete = vi.fn();
    hooks.on('before', before);
    hooks.on('complete', complete);
    hooks.emit('complete', { status: 200 });
    expect(complete).toHaveBeenCalledWith({ status: 200 });
    expect(before).not.toHaveBeenCalled();
  });

  it('emit to a channel with no listeners is a no-op', () => {
    expect(() => createHooks<StageMap>().emit('before', { url: '/x' })).not.toThrow();
  });

  it('delivers to multiple listeners on a channel in subscription order', () => {
    const hooks = createHooks<StageMap>();
    const order: number[] = [];
    hooks.on('before', () => order.push(1));
    hooks.on('before', () => order.push(2));
    hooks.emit('before', { url: '/a' });
    expect(order).toEqual([1, 2]);
  });

  it('the returned unsubscribe stops further delivery (and is idempotent)', () => {
    const hooks = createHooks<StageMap>();
    const fn = vi.fn();
    const off = hooks.on('before', fn);
    hooks.emit('before', { url: '/1' });
    off();
    off(); // idempotent
    hooks.emit('before', { url: '/2' });
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith({ url: '/1' });
  });
});

describe('createHooks — onAny', () => {
  it('delivers every channel with its name and payload', () => {
    const hooks = createHooks<StageMap>();
    const seen: Array<[string, unknown]> = [];
    hooks.onAny((name, payload) => seen.push([name, payload]));
    hooks.emit('before', { url: '/a' });
    hooks.emit('complete', { status: 204 });
    expect(seen).toEqual([
      ['before', { url: '/a' }],
      ['complete', { status: 204 }],
    ]);
  });

  it('fires per-channel listeners before onAny listeners', () => {
    const hooks = createHooks<StageMap>();
    const order: string[] = [];
    hooks.onAny(() => order.push('any'));
    hooks.on('before', () => order.push('named'));
    hooks.emit('before', { url: '/a' });
    expect(order).toEqual(['named', 'any']);
  });

  it('onAny unsubscribe stops delivery', () => {
    const hooks = createHooks<StageMap>();
    const fn = vi.fn();
    const off = hooks.onAny(fn);
    off();
    hooks.emit('before', { url: '/a' });
    expect(fn).not.toHaveBeenCalled();
  });
});

describe('createHooks — listener-error isolation', () => {
  it('routes a throwing listener to onListenerError and still runs the others', () => {
    const onListenerError = vi.fn();
    const hooks = createHooks<StageMap>(onListenerError);
    const after = vi.fn();
    hooks.on('before', () => {
      throw new Error('boom');
    });
    hooks.on('before', after);
    expect(() => hooks.emit('before', { url: '/a' })).not.toThrow();
    expect(after).toHaveBeenCalledWith({ url: '/a' });
    expect(onListenerError).toHaveBeenCalledTimes(1);
    expect((onListenerError.mock.calls[0]?.[0] as Error).message).toBe('boom');
  });

  it('a throwing onAny listener is isolated too', () => {
    const onListenerError = vi.fn();
    const hooks = createHooks<StageMap>(onListenerError);
    hooks.onAny(() => {
      throw new Error('any-boom');
    });
    expect(() => hooks.emit('complete', { status: 500 })).not.toThrow();
    expect(onListenerError).toHaveBeenCalledTimes(1);
  });

  it('a throwing listener without an onListenerError handler does not break emit', () => {
    const hooks = createHooks<StageMap>(); // no handler
    hooks.on('before', () => {
      throw new Error('boom');
    });
    expect(() => hooks.emit('before', { url: '/a' })).not.toThrow();
  });
});

describe('createHooks — dispatch snapshot semantics', () => {
  it('a listener subscribed during dispatch is not called for the in-flight emit', () => {
    const hooks = createHooks<StageMap>();
    const late = vi.fn();
    hooks.on('before', () => {
      hooks.on('before', late);
    });
    hooks.emit('before', { url: '/a' });
    expect(late).not.toHaveBeenCalled();
    hooks.emit('before', { url: '/b' });
    expect(late).toHaveBeenCalledTimes(1); // called on the next emit
  });

  it('a listener unsubscribed during dispatch is not called', () => {
    const hooks = createHooks<StageMap>();
    const second = vi.fn();
    const off = hooks.on('before', () => off2());
    const off2 = hooks.on('before', second);
    // first listener removes the second before it runs
    hooks.on('before', vi.fn());
    void off;
    hooks.emit('before', { url: '/a' });
    expect(second).not.toHaveBeenCalled();
  });

  it('an onAny listener unsubscribed during dispatch is not called', () => {
    const hooks = createHooks<StageMap>();
    const second = vi.fn();
    hooks.onAny(() => off2());
    const off2 = hooks.onAny(second);
    hooks.emit('before', { url: '/a' });
    expect(second).not.toHaveBeenCalled();
  });
});
