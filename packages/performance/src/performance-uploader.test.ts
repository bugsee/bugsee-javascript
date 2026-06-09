import type { Scheduler } from '@bugsee/core';
import { describe, expect, it, vi } from 'vitest';
import { createPerformanceUploader } from './performance-uploader';
import type { TransactionWire } from './span';
import { createTransactionStore } from './transaction-store';

const wire = (name: string): TransactionWire => ({ name }) as TransactionWire;

function fakeScheduler() {
  const scheduled: { cb: () => void; ms: number }[] = [];
  const cleared: unknown[] = [];
  const scheduler: Scheduler = {
    setInterval: (cb, ms) => {
      scheduled.push({ cb, ms });
      return `h${scheduled.length}`;
    },
    clearInterval: (handle) => {
      cleared.push(handle);
    },
  };
  return { scheduler, scheduled, cleared };
}

describe('createPerformanceUploader', () => {
  it('flush() drains the store and sends the transactions; an empty store sends nothing', async () => {
    const store = createTransactionStore();
    const send = vi.fn(async () => {});
    const uploader = createPerformanceUploader({
      store,
      send,
      scheduler: fakeScheduler().scheduler,
    });

    await uploader.flush();
    expect(send).not.toHaveBeenCalled(); // empty → no request

    store.add(wire('a'));
    store.add(wire('b'));
    await uploader.flush();
    expect(send).toHaveBeenCalledWith([wire('a'), wire('b')]);
    expect(store.size()).toBe(0); // drained
  });

  it('routes a send failure to onError without throwing (best-effort delivery)', async () => {
    const store = createTransactionStore();
    store.add(wire('a'));
    const boom = new Error('network');
    const onError = vi.fn();
    const uploader = createPerformanceUploader({
      store,
      send: async () => {
        throw boom;
      },
      scheduler: fakeScheduler().scheduler,
      onError,
    });
    await expect(uploader.flush()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('swallows a send failure with the default (no-op) onError sink', async () => {
    const store = createTransactionStore();
    store.add(wire('a'));
    const uploader = createPerformanceUploader({
      store,
      send: async () => {
        throw new Error('x');
      },
      scheduler: fakeScheduler().scheduler,
    });
    await expect(uploader.flush()).resolves.toBeUndefined(); // no onError → default no-op, no throw
  });

  it('start() schedules a periodic flush at the interval (default 30s); the tick flushes', async () => {
    const store = createTransactionStore();
    const send = vi.fn(async () => {});
    const { scheduler, scheduled } = fakeScheduler();
    const uploader = createPerformanceUploader({ store, send, scheduler });

    uploader.start();
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0]?.ms).toBe(30_000);

    store.add(wire('a'));
    scheduled[0]?.cb(); // the scheduler tick
    await Promise.resolve(); // let the async flush settle
    expect(send).toHaveBeenCalledWith([wire('a')]);
  });

  it('honours a custom flush interval', () => {
    const { scheduler, scheduled } = fakeScheduler();
    createPerformanceUploader({
      store: createTransactionStore(),
      send: async () => {},
      scheduler,
      flushIntervalMs: 5000,
    }).start();
    expect(scheduled[0]?.ms).toBe(5000);
  });

  it('start() is idempotent (no double-schedule); stop() clears the interval and is idempotent', () => {
    const { scheduler, scheduled, cleared } = fakeScheduler();
    const uploader = createPerformanceUploader({
      store: createTransactionStore(),
      send: async () => {},
      scheduler,
    });
    uploader.start();
    uploader.start(); // already running → no second schedule
    expect(scheduled).toHaveLength(1);
    uploader.stop();
    expect(cleared).toEqual(['h1']);
    uploader.stop(); // already stopped → no second clear
    expect(cleared).toHaveLength(1);
  });
});
