import { describe, expect, it, vi } from 'vitest';
import { createIdleTransaction } from './idle-transaction';
import type { Transaction } from './span';

// A fake one-shot timer that records scheduled callbacks (by handle + delay) and lets a test fire them.
function fakeTimer() {
  const scheduled = new Map<number, { cb: () => void; ms: number }>();
  let nextId = 1;
  const setTimeout = vi.fn((cb: () => void, ms: number) => {
    const id = nextId++;
    scheduled.set(id, { cb, ms });
    return id;
  });
  const clearTimeout = vi.fn((h: unknown) => {
    scheduled.delete(h as number);
  });
  return {
    timer: { setTimeout, clearTimeout },
    setTimeout,
    clearTimeout,
    pending: () => scheduled.size,
    /** Fire the MOST-RECENTLY-scheduled still-pending timer with this delay (the current idle/final timer). */
    fire: (ms: number) => {
      let target: number | undefined;
      for (const [id, s] of scheduled) if (s.ms === ms) target = id;
      if (target !== undefined) {
        const s = scheduled.get(target);
        scheduled.delete(target);
        s?.cb();
      }
    },
  };
}

// Fully conforming — deliberately NOT cast (`as unknown as Transaction`). Left as a bare object literal
// assigned to a `Transaction`-typed const, tsc's missing-property check on a fresh object literal rejects
// this double at authoring time (a CI gate) the moment `Transaction` grows a member it does not implement.
// R5-8: these three were the last casts left, and they sit in the package that OWNS the interface.
const fakeTxn = (): Transaction => {
  const txn: Transaction = {
    getTraceId: () => 'trace-1',
    getSpanId: () => 'span-1',
    isSampled: () => true,
    isFinished: vi.fn(() => false),
    setName: vi.fn(() => txn),
    setDescription: vi.fn(() => txn),
    setAttribute: vi.fn(() => txn),
    setStatus: vi.fn(() => txn),
    startChildSpan: vi.fn(() => txn),
    recordChildSpan: vi.fn(),
    getStatus: () => 'OK',
    getDescription: () => undefined,
    getAttributes: vi.fn(() => ({})),
    getName: () => 'name',
    finish: vi.fn(),
    getOperation: () => 'ui.idle',
  };
  return txn;
};

describe('createIdleTransaction', () => {
  it('schedules an idle timer + a final (hard-cap) timer on creation', () => {
    const t = fakeTimer();
    createIdleTransaction({
      transaction: fakeTxn(),
      timer: t.timer,
      idleTimeoutMs: 1000,
      finalTimeoutMs: 30000,
    });
    expect(t.setTimeout).toHaveBeenCalledTimes(2);
    expect(t.setTimeout).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(t.setTimeout).toHaveBeenCalledWith(expect.any(Function), 30000);
  });

  it('finishes OK when the idle timeout elapses (no activity)', () => {
    const txn = fakeTxn();
    const t = fakeTimer();
    createIdleTransaction({
      transaction: txn,
      timer: t.timer,
      idleTimeoutMs: 1000,
      finalTimeoutMs: 30000,
    });
    t.fire(1000); // idle timeout
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('keepAlive RESETS the idle timer (clears the old, schedules a new) without touching the final cap', () => {
    const txn = fakeTxn();
    const t = fakeTimer();
    const handle = createIdleTransaction({
      transaction: txn,
      timer: t.timer,
      idleTimeoutMs: 1000,
      finalTimeoutMs: 30000,
    });
    const firstIdleHandle = t.setTimeout.mock.results[0]?.value; // the original idle timer (id 1)
    handle.keepAlive();
    expect(t.clearTimeout).toHaveBeenCalledWith(firstIdleHandle); // old idle timer cleared
    expect(t.setTimeout).toHaveBeenCalledTimes(3); // idle + final + the rescheduled idle
    // The (cleared) original idle timer can no longer finish; the rescheduled one does.
    t.fire(1000);
    expect(txn.finish).toHaveBeenCalledWith('OK');
  });

  it('finishes DEADLINE_EXCEEDED at the hard cap — keepAlive never extends past it', () => {
    const txn = fakeTxn();
    const t = fakeTimer();
    const handle = createIdleTransaction({
      transaction: txn,
      timer: t.timer,
      idleTimeoutMs: 1000,
      finalTimeoutMs: 30000,
    });
    const finalHandle = t.setTimeout.mock.results[1]?.value; // the final (hard-cap) timer (id 2)
    handle.keepAlive();
    handle.keepAlive();
    expect(t.clearTimeout).not.toHaveBeenCalledWith(finalHandle); // the cap is never reset
    t.fire(30000); // hard cap elapses
    expect(txn.finish).toHaveBeenCalledWith('DEADLINE_EXCEEDED');
  });

  it('finishNow finishes immediately (OK by default) and clears both timers', () => {
    const txn = fakeTxn();
    const t = fakeTimer();
    const handle = createIdleTransaction({ transaction: txn, timer: t.timer });
    handle.finishNow();
    expect(txn.finish).toHaveBeenCalledWith('OK');
    expect(t.pending()).toBe(0); // both timers cleared
  });

  it('finishNow forwards an explicit status (not coerced to OK)', () => {
    const txn = fakeTxn();
    const t = fakeTimer();
    const handle = createIdleTransaction({ transaction: txn, timer: t.timer });
    handle.finishNow('CANCELLED');
    expect(txn.finish).toHaveBeenCalledWith('CANCELLED'); // the passed status wins over the OK default
  });

  it('cancel finishes CANCELLED (page hidden) and clears both timers', () => {
    const txn = fakeTxn();
    const t = fakeTimer();
    const handle = createIdleTransaction({ transaction: txn, timer: t.timer });
    handle.cancel();
    expect(txn.finish).toHaveBeenCalledWith('CANCELLED');
    expect(t.pending()).toBe(0);
  });

  it('is idempotent: after finishing, keepAlive / cancel / a late timer fire do nothing (finish called once)', () => {
    const txn = fakeTxn();
    const t = fakeTimer();
    const handle = createIdleTransaction({ transaction: txn, timer: t.timer, idleTimeoutMs: 1000 });
    handle.finishNow();
    handle.keepAlive();
    handle.cancel();
    t.fire(1000); // a stale timer (already cleared) — also a no-op
    expect(txn.finish).toHaveBeenCalledTimes(1);
  });

  it('honors custom idle/final timeouts', () => {
    const t = fakeTimer();
    createIdleTransaction({
      transaction: fakeTxn(),
      timer: t.timer,
      idleTimeoutMs: 250,
      finalTimeoutMs: 5000,
    });
    expect(t.setTimeout).toHaveBeenCalledWith(expect.any(Function), 250);
    expect(t.setTimeout).toHaveBeenCalledWith(expect.any(Function), 5000);
  });

  it('defaults to the global setTimeout/clearTimeout when no timer is injected', () => {
    vi.useFakeTimers();
    try {
      const txn = fakeTxn();
      createIdleTransaction({ transaction: txn, idleTimeoutMs: 1000 });
      vi.advanceTimersByTime(1000);
      expect(txn.finish).toHaveBeenCalledWith('OK');
    } finally {
      vi.useRealTimers();
    }
  });
});
