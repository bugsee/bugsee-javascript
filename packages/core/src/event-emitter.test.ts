import { describe, expect, it, vi } from 'vitest';
import { createEventEmitter } from './event-emitter';

describe('createEventEmitter', () => {
  it('delivers the emitted event to a subscriber', () => {
    const em = createEventEmitter<number>();
    const seen: number[] = [];
    em.subscribe((e) => seen.push(e));
    em.emit(7);
    expect(seen).toEqual([7]);
  });

  it('passes the same event reference to every listener', () => {
    const em = createEventEmitter<{ id: number }>();
    const event = { id: 1 };
    const received: unknown[] = [];
    em.subscribe((e) => received.push(e));
    em.subscribe((e) => received.push(e));
    em.emit(event);
    expect(received[0]).toBe(event);
    expect(received[1]).toBe(event);
  });

  it('calls listeners in subscription order', () => {
    const em = createEventEmitter<void>();
    const order: string[] = [];
    em.subscribe(() => order.push('a'));
    em.subscribe(() => order.push('b'));
    em.subscribe(() => order.push('c'));
    em.emit(undefined);
    expect(order).toEqual(['a', 'b', 'c']);
  });

  it('delivers each of multiple emits, in order', () => {
    const em = createEventEmitter<number>();
    const seen: number[] = [];
    em.subscribe((e) => seen.push(e));
    em.emit(1);
    em.emit(2);
    em.emit(3);
    expect(seen).toEqual([1, 2, 3]);
  });

  it('emitting with no listeners does not throw', () => {
    const em = createEventEmitter<number>();
    expect(() => em.emit(1)).not.toThrow();
  });

  it('the returned unsubscribe removes the listener', () => {
    const em = createEventEmitter<number>();
    const seen: number[] = [];
    const off = em.subscribe((e) => seen.push(e));
    em.emit(1);
    off();
    em.emit(2);
    expect(seen).toEqual([1]);
  });

  it('the returned unsubscribe is idempotent', () => {
    const em = createEventEmitter<number>();
    const seen: number[] = [];
    const listener = (e: number) => seen.push(e);
    const off = em.subscribe(listener);
    off();
    expect(() => off()).not.toThrow();
    // a second listener subscribed after must still receive events (off() removed only `listener`)
    em.subscribe((e) => seen.push(e * 10));
    em.emit(1);
    expect(seen).toEqual([10]);
  });

  it('unsubscribe(fn) removes a listener by reference', () => {
    const em = createEventEmitter<number>();
    const seen: number[] = [];
    const listener = (e: number) => seen.push(e);
    em.subscribe(listener);
    em.unsubscribe(listener);
    em.emit(1);
    expect(seen).toEqual([]);
  });

  it('unsubscribe(fn) for a never-subscribed listener is a no-op', () => {
    const em = createEventEmitter<number>();
    const seen: number[] = [];
    em.subscribe((e) => seen.push(e));
    expect(() => em.unsubscribe(() => {})).not.toThrow();
    em.emit(1);
    expect(seen).toEqual([1]);
  });

  it('dedups a listener subscribed twice (called once per emit)', () => {
    const em = createEventEmitter<number>();
    const listener = vi.fn();
    em.subscribe(listener);
    em.subscribe(listener);
    em.emit(1);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('a single unsubscribe removes a twice-subscribed listener', () => {
    const em = createEventEmitter<number>();
    const listener = vi.fn();
    const off1 = em.subscribe(listener);
    em.subscribe(listener);
    off1();
    em.emit(1);
    expect(listener).not.toHaveBeenCalled();
  });

  it('isolates a throwing listener: later listeners still run', () => {
    const em = createEventEmitter<number>();
    const seen: number[] = [];
    em.subscribe(() => {
      throw new Error('boom');
    });
    em.subscribe((e) => seen.push(e));
    expect(() => em.emit(1)).not.toThrow();
    expect(seen).toEqual([1]);
  });

  it('routes a listener error to onListenerError with the thrown value', () => {
    const onError = vi.fn();
    const em = createEventEmitter<number>(onError);
    const boom = new Error('boom');
    em.subscribe(() => {
      throw boom;
    });
    em.emit(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('calls onListenerError once per throwing listener', () => {
    const onError = vi.fn();
    const em = createEventEmitter<number>(onError);
    em.subscribe(() => {
      throw new Error('a');
    });
    em.subscribe(() => {
      throw new Error('b');
    });
    em.emit(1);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('swallows a listener error when no onListenerError is provided', () => {
    const em = createEventEmitter<number>();
    const seen: number[] = [];
    em.subscribe(() => {
      throw new Error('boom');
    });
    em.subscribe((e) => seen.push(e));
    expect(() => em.emit(1)).not.toThrow();
    expect(seen).toEqual([1]);
  });

  it('does not deliver the in-flight event to a listener subscribed during dispatch', () => {
    const em = createEventEmitter<number>();
    const lateSeen: number[] = [];
    const late = (e: number) => lateSeen.push(e);
    em.subscribe(() => {
      em.subscribe(late);
    });
    em.emit(1); // `late` subscribed during this dispatch — must not see event 1
    expect(lateSeen).toEqual([]);
    em.emit(2); // but is active for the next emit
    expect(lateSeen).toEqual([2]);
  });

  it('does not call a not-yet-reached listener that is unsubscribed during dispatch', () => {
    const em = createEventEmitter<number>();
    const seen: number[] = [];
    const second = (e: number) => seen.push(e);
    em.subscribe(() => {
      em.unsubscribe(second); // remove `second` before the loop reaches it
    });
    em.subscribe(second);
    em.emit(1);
    expect(seen).toEqual([]);
  });
});
