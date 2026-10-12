import { utf8ByteLength } from '@bugsee/util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createNotifyRelay, type NotifyRelayOptions } from './notify-relay';
import type { NotifyItem, NotifyResult } from './transport';

// The relay runs on the REAL global timers, driven by vitest fake timers, so the default-timer path is
// the one under test. `send` is the only seam; everything else is observed through what it receives.

type Send = (items: readonly NotifyItem[]) => Promise<NotifyResult>;
const SENT: NotifyResult = { outcome: 'sent' };

let sends: Array<readonly NotifyItem[]>;
let ids: number;

const make = (over: Partial<NotifyRelayOptions> = {}, send?: Send) => {
  const sendFn = vi.fn<Send>(async (items) => {
    sends.push(items.map((item) => ({ ...item })));
    return send ? send(items) : SENT;
  });
  const onError = vi.fn();
  const relay = createNotifyRelay({
    send: sendFn,
    clock: { wallNow: () => 1_700_000_000_000, monotonicNow: () => 0 },
    flushDelayMs: 0,
    newId: () => `id${++ids}`,
    onError,
    ...over,
  });
  return { relay, send: sendFn, onError };
};

beforeEach(() => {
  vi.useFakeTimers();
  sends = [];
  ids = 0;
});
afterEach(() => {
  vi.useRealTimers();
});

describe('enqueue — validation and the wire shape', () => {
  it('sends title only with an id and a timestamp, and the immediate delivery stamp at delay 0', async () => {
    const { relay } = make();
    relay.enqueue({ title: 'Deploy finished' });
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toEqual([
      [
        {
          id: 'id1',
          timestamp: 1_700_000_000_000,
          title: 'Deploy finished',
          delivery: 'immediate',
        },
      ],
    ]);
  });

  it('carries body, the numeric severity, string fields and the urgent flag', async () => {
    const { relay } = make();
    relay.enqueue({
      title: 't',
      body: 'details',
      severity: 'critical',
      fields: { env: 'prod', region: 'eu' },
      urgent: true,
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(sends[0]?.[0]).toMatchObject({
      title: 't',
      body: 'details',
      severity: 4,
      fields: { env: 'prod', region: 'eu' },
      urgent: true,
    });
  });

  it('maps every severity name to its wire value, and accepts the low alias', async () => {
    const { relay } = make();
    const names = ['verylow', 'low', 'medium', 'high', 'critical', 'blocker'] as const;
    for (const severity of names) {
      relay.enqueue({ title: severity, severity });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(sends[0]?.map((item) => item.severity)).toEqual([1, 1, 2, 3, 4, 5]);
  });

  it('ignores an empty or non-string title: nothing is sent, nothing is reported', async () => {
    const { relay, onError } = make();
    relay.enqueue({ title: '' });
    relay.enqueue({ title: undefined as unknown as string });
    relay.enqueue({ title: 42 as unknown as string });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sends).toEqual([]);
    expect(onError).not.toHaveBeenCalled();
  });

  it('omits what is malformed: a non-string body, an unknown severity, non-string fields', async () => {
    const { relay } = make();
    relay.enqueue({
      title: 't',
      body: 5 as unknown as string,
      severity: 'urgent' as unknown as 'high',
      fields: { ok: 'yes', n: 1, o: {}, nil: null } as unknown as Record<string, string>,
    });
    relay.enqueue({
      title: 'u',
      fields: { n: 1 } as unknown as Record<string, string>,
    });
    relay.enqueue({ title: 'v', fields: ['a'] as unknown as Record<string, string> });
    relay.enqueue({ title: 'w', fields: null as unknown as Record<string, string> });
    await vi.advanceTimersByTimeAsync(0);
    const [t, u, v, w] = sends[0] as NotifyItem[];
    expect(t).not.toHaveProperty('body');
    expect(t).not.toHaveProperty('severity');
    expect(t?.fields).toEqual({ ok: 'yes' });
    expect(u).not.toHaveProperty('fields');
    expect(v).not.toHaveProperty('fields');
    expect(w).not.toHaveProperty('fields');
  });

  it('keeps an empty-string body (the caller asked for it)', async () => {
    const { relay } = make();
    relay.enqueue({ title: 't', body: '' });
    await vi.advanceTimersByTimeAsync(0);
    expect(sends[0]?.[0]).toHaveProperty('body', '');
  });

  it('treats only urgent === true as urgent', async () => {
    const { relay } = make();
    relay.enqueue({ title: 't', urgent: 'yes' as unknown as boolean });
    await vi.advanceTimersByTimeAsync(0);
    expect(sends[0]?.[0]).not.toHaveProperty('urgent');
  });

  it('stamps the user, environment and attributes snapshotted at the call', async () => {
    let user: string | null = 'u-1';
    const env = { sdk: { version: '1', type: 'javascript' } };
    const { relay } = make({
      snapshot: () => ({
        userIdentifier: user,
        attributes: { plan: 'pro' },
        environment: env as never,
      }),
    });
    relay.enqueue({ title: 'a' });
    user = 'u-2';
    await vi.advanceTimersByTimeAsync(0);
    expect(sends[0]?.[0]).toMatchObject({
      user: { email: 'u-1' }, // Android sends {email}; the integrations read only name/email
      attributes: { plan: 'pro' },
      environment: env,
    });
  });

  it('omits an absent user, empty attributes and a throwing environment', async () => {
    const { relay, onError } = make({
      snapshot: () => ({ userIdentifier: null, attributes: {}, environment: undefined }),
    });
    relay.enqueue({ title: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    expect(sends[0]?.[0]).not.toHaveProperty('user');
    expect(sends[0]?.[0]).not.toHaveProperty('attributes');
    expect(sends[0]?.[0]).not.toHaveProperty('environment');

    const throwing = make({
      snapshot: () => {
        throw new Error('snapshot broke');
      },
    });
    throwing.relay.enqueue({ title: 'b' });
    await vi.advanceTimersByTimeAsync(0);
    expect(sends[1]?.[0]).toMatchObject({ title: 'b' });
    expect(throwing.onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'snapshot broke' }),
    );
    expect(onError).not.toHaveBeenCalled();
  });

  it('refuses a notification larger than 256 KB and says so', async () => {
    const { relay, onError } = make();
    relay.enqueue({ title: 'big', body: 'x'.repeat(256 * 1024) });
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toEqual([]);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/256 KB/) }),
    );
    expect(relay.pending()).toBe(0);
  });

  it('counts the size in UTF-8 bytes, not characters', async () => {
    const { relay, onError } = make();
    // 100k three-byte characters = 300 KB of bytes, 100k of characters.
    relay.enqueue({ title: 'big', body: '€'.repeat(100_000) });
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toEqual([]);
    expect(onError).toHaveBeenCalled();
  });

  it('accepts a notification just under the limit', async () => {
    const { relay } = make();
    relay.enqueue({ title: 'ok', body: 'x'.repeat(200 * 1024) });
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toHaveLength(1);
  });
});

describe('batching and the flush delay', () => {
  it('coalesces a burst into one request at delay 0', async () => {
    const { relay } = make();
    relay.enqueue({ title: 'a' });
    relay.enqueue({ title: 'b' });
    relay.enqueue({ title: 'c' });
    expect(sends).toEqual([]); // nothing goes out synchronously
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.map((i) => i.title)).toEqual(['a', 'b', 'c']);
  });

  it('waits notifyFlushDelay after the first notification and stamps them deferred', async () => {
    const { relay } = make({ flushDelayMs: 5000 });
    relay.enqueue({ title: 'a' });
    await vi.advanceTimersByTimeAsync(4999);
    expect(sends).toEqual([]);
    relay.enqueue({ title: 'b' }); // joins the pending window, does not extend it
    await vi.advanceTimersByTimeAsync(1);
    expect(sends).toHaveLength(1);
    expect(sends[0]?.map((i) => [i.title, i.delivery])).toEqual([
      ['a', 'deferred'],
      ['b', 'deferred'],
    ]);
  });

  it('sends an urgent notification at once, alone, stamped immediate, ahead of the window', async () => {
    const { relay } = make({ flushDelayMs: 5000 });
    relay.enqueue({ title: 'calm' });
    relay.enqueue({ title: 'now', urgent: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toHaveLength(1);
    expect(sends[0]?.[0]).toMatchObject({ title: 'now', urgent: true, delivery: 'immediate' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(sends).toHaveLength(2);
    expect(sends[1]?.[0]).toMatchObject({ title: 'calm', delivery: 'deferred' });
  });

  it('stamps an urgent notification that rides a normal flush as deferred', async () => {
    // Mobile: an urgent item that was NOT sent ahead (it failed, then is retried in the FIFO) is deferred.
    let calls = 0;
    const { relay } = make({ flushDelayMs: 0 }, async () => {
      calls += 1;
      return calls === 1 ? { outcome: 'retry' } : SENT;
    });
    relay.enqueue({ title: 'u', urgent: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(sends[0]?.[0]).toMatchObject({ delivery: 'immediate' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(sends[1]?.[0]).toMatchObject({ title: 'u', delivery: 'deferred' });
  });

  it('splits a queue into batches of at most 50 notifications', async () => {
    const { relay } = make();
    for (let i = 0; i < 120; i++) {
      relay.enqueue({ title: `n${i}` });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(sends.map((batch) => batch.length)).toEqual([50, 50, 20]);
    expect(sends[0]?.[0]?.title).toBe('n0');
    expect(sends[2]?.[19]?.title).toBe('n119');
  });

  it('splits a batch before it would pass 256 KB', async () => {
    const { relay } = make();
    for (let i = 0; i < 4; i++) {
      relay.enqueue({ title: `n${i}`, body: 'x'.repeat(100 * 1024) });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(sends.map((batch) => batch.length)).toEqual([2, 2]);
  });

  it('fills a batch up to, but not past, 256 KB', async () => {
    const { relay } = make();
    for (let i = 0; i < 3; i++) {
      relay.enqueue({ title: `n${i}`, body: 'x'.repeat(90 * 1024) }); // 3 of them are ~270 KB
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(sends.map((batch) => batch.length)).toEqual([2, 1]);
  });

  it('treats exactly 256 KB as a full batch that still fits', async () => {
    const { relay } = make();
    // The size is measured as queued, before the delivery stamp, so that is the shell to size against.
    const shell = JSON.stringify({
      id: 'id1',
      timestamp: 1_700_000_000_000,
      title: 't',
      body: '',
    }).length;
    const body = 'x'.repeat(128 * 1024 - shell);
    relay.enqueue({ title: 't', body });
    relay.enqueue({ title: 't', body });
    relay.enqueue({ title: 't', body });
    await vi.advanceTimersByTimeAsync(0);
    expect(sends.map((batch) => batch.length)).toEqual([2, 1]);
  });

  it('arms one window for a whole burst, not one per notification', () => {
    const { relay } = make({ flushDelayMs: 100 });
    relay.enqueue({ title: 'a' });
    relay.enqueue({ title: 'b' });
    relay.enqueue({ title: 'c' });
    expect(vi.getTimerCount()).toBe(1);
  });

  it('still sends a single notification that alone is near the batch ceiling', async () => {
    const { relay } = make();
    relay.enqueue({ title: 'solo', body: 'x'.repeat(255 * 1024) });
    await vi.advanceTimersByTimeAsync(0);
    expect(sends.map((batch) => batch.length)).toEqual([1]);
  });

  it('starts a new window for a notification that arrives after a flush', async () => {
    const { relay } = make({ flushDelayMs: 100 });
    relay.enqueue({ title: 'a' });
    await vi.advanceTimersByTimeAsync(100);
    relay.enqueue({ title: 'b' });
    await vi.advanceTimersByTimeAsync(100);
    expect(sends.map((batch) => batch.map((i) => i.title))).toEqual([['a'], ['b']]);
  });

  it('does not start a second drain while one is in flight, and picks up what arrived meanwhile', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let first = true;
    const { relay, send } = make({}, async () => {
      if (first) {
        first = false;
        await gate;
      }
      return SENT;
    });
    relay.enqueue({ title: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    relay.enqueue({ title: 'b' });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1); // the second timer joined the running drain
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(sends.map((batch) => batch.map((i) => i.title))).toEqual([['a'], ['b']]);
  });
});

describe('retry and failure handling', () => {
  it('keeps a batch on a transient failure and retries it after 2 s, then 4 s, doubling to a 60 s cap', async () => {
    const { relay, send } = make({}, async () => ({ outcome: 'retry' }));
    relay.enqueue({ title: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3999);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(3);
    // 8, 16, 32, then capped at 60 s.
    for (const wait of [8000, 16000, 32000, 60000, 60000]) {
      const before = send.mock.calls.length;
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(send).toHaveBeenCalledTimes(before);
      await vi.advanceTimersByTimeAsync(1);
      expect(send).toHaveBeenCalledTimes(before + 1);
    }
    expect(relay.pending()).toBe(1);
  });

  it('resets the backoff once a send succeeds', async () => {
    let fail = true;
    const { relay, send } = make({}, async () => (fail ? { outcome: 'retry' } : SENT));
    relay.enqueue({ title: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000); // 2nd attempt, fails -> next wait 4 s
    fail = false;
    await vi.advanceTimersByTimeAsync(4000); // succeeds
    expect(relay.pending()).toBe(0);
    fail = true;
    relay.enqueue({ title: 'b' });
    await vi.advanceTimersByTimeAsync(0);
    const calls = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(2000); // back to the 2 s floor, not 8 s
    expect(send).toHaveBeenCalledTimes(calls + 1);
  });

  it('retries only the ids the collector named, keeping the original order, and never resends the settled', async () => {
    let calls = 0;
    const { relay } = make({}, async (items) => {
      calls += 1;
      return calls === 1
        ? { outcome: 'retry', retryIds: [items[0]?.id as string, items[2]?.id as string] }
        : SENT;
    });
    for (const title of ['a', 'b', 'c']) {
      relay.enqueue({ title });
    }
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(sends.map((batch) => batch.map((i) => i.title))).toEqual([
      ['a', 'b', 'c'],
      ['a', 'c'],
    ]);
    expect(relay.pending()).toBe(0);
  });

  it('puts a retried batch ahead of newer notifications so order is preserved', async () => {
    let calls = 0;
    const { relay } = make({}, async () => {
      calls += 1;
      return calls === 1 ? { outcome: 'retry' } : SENT;
    });
    relay.enqueue({ title: 'old' });
    await vi.advanceTimersByTimeAsync(0);
    relay.enqueue({ title: 'new' });
    await vi.advanceTimersByTimeAsync(2000);
    expect(
      sends
        .slice(1)
        .flat()
        .map((i) => i.title),
    ).toEqual(['old', 'new']);
  });

  it('puts a failed batch back in front of notifications that arrived while it was in flight', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const { relay } = make({}, async () => {
      calls += 1;
      if (calls === 1) {
        await gate;
        return { outcome: 'retry' };
      }
      return SENT;
    });
    relay.enqueue({ title: 'old' });
    await vi.advanceTimersByTimeAsync(0);
    relay.enqueue({ title: 'new' }); // arrives while 'old' is on the wire
    expect(relay.pending()).toBe(2);
    release?.();
    await vi.advanceTimersByTimeAsync(2000);
    expect(
      sends
        .slice(1)
        .flat()
        .map((i) => i.title),
    ).toEqual(['old', 'new']);
  });

  it('counts a notification in flight as pending until the request answers', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { relay } = make({}, async () => {
      await gate;
      return SENT;
    });
    relay.enqueue({ title: 'a' });
    relay.enqueue({ title: 'u', urgent: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(relay.pending()).toBe(2);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(relay.pending()).toBe(0);
  });

  it('does not send newer notifications early while a retry is backing off', async () => {
    let calls = 0;
    const { relay, send } = make({}, async () => {
      calls += 1;
      return calls === 1 ? { outcome: 'retry' } : SENT;
    });
    relay.enqueue({ title: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    relay.enqueue({ title: 'b' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(2);
    expect(sends[1]?.map((i) => i.title)).toEqual(['a', 'b']);
  });

  it('drops a rejected batch, reports it, and carries on with the next one', async () => {
    let calls = 0;
    const { relay, onError } = make({}, async () => {
      calls += 1;
      return calls === 1 ? { outcome: 'rejected' } : SENT;
    });
    for (let i = 0; i < 60; i++) {
      relay.enqueue({ title: `n${i}` });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(sends.map((batch) => batch.length)).toEqual([50, 10]);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringMatching(/rejected/) }),
    );
    expect(relay.pending()).toBe(0);
  });

  it('survives a sender that throws or rejects: the batch is retried', async () => {
    let calls = 0;
    const { relay } = make({}, async () => {
      calls += 1;
      if (calls === 1) {
        throw new Error('boom');
      }
      return SENT;
    });
    relay.enqueue({ title: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    expect(relay.pending()).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(relay.pending()).toBe(0);
  });

  it('retries a failed urgent send through the queue', async () => {
    let calls = 0;
    const { relay } = make({ flushDelayMs: 1000 }, async () => {
      calls += 1;
      return calls === 1 ? { outcome: 'retry' } : SENT;
    });
    relay.enqueue({ title: 'u', urgent: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(relay.pending()).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(relay.pending()).toBe(0);
    expect(sends).toHaveLength(2);
  });

  it('an urgent notification does not skip an active retry backoff', async () => {
    let calls = 0;
    const { relay } = make({ flushDelayMs: 1000 }, async () => {
      calls += 1;
      return calls === 1 ? { outcome: 'retry' } : SENT;
    });
    relay.enqueue({ title: 'first', urgent: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toHaveLength(1); // failed: the retry timer is now running
    relay.enqueue({ title: 'second', urgent: true });
    await vi.advanceTimersByTimeAsync(500);
    expect(sends).toHaveLength(1); // held for the backoff, not sent at once
    await vi.advanceTimersByTimeAsync(2000);
    expect(sends).toHaveLength(2);
    expect(sends[1]?.map((item) => item.title)).toEqual(['first', 'second']);
    expect(relay.pending()).toBe(0);
  });

  it('drops a rejected urgent send', async () => {
    const { relay, onError } = make({}, async () => ({ outcome: 'rejected' }));
    relay.enqueue({ title: 'u', urgent: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(relay.pending()).toBe(0);
    expect(onError).toHaveBeenCalled();
  });

  it('a failed urgent send at the 1000-item cap keeps the urgent item and drops the oldest queued one', async () => {
    let now = 1_700_000_000_000;
    let outcome: NotifyResult = SENT;
    const { relay, onError } = make(
      { flushDelayMs: 60_000, clock: { wallNow: () => now++, monotonicNow: () => 0 } },
      async () => outcome,
    );
    for (let i = 0; i < 1000; i++) {
      relay.enqueue({ title: `d${i}` });
    }
    outcome = { outcome: 'retry' };
    relay.enqueue({ title: 'urgent', urgent: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(relay.pending()).toBe(1000);
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ message: expect.stringContaining('dropped the oldest') }),
    );
    outcome = SENT;
    await relay.flush();
    const titles = sends.flat().map((item) => item.title);
    expect(titles).toContain('urgent');
    expect(titles).not.toContain('d0');
  });

  it('keeps at most 1000 pending notifications, dropping the oldest', async () => {
    const { relay, onError } = make({}, async () => ({ outcome: 'retry' }));
    for (let i = 0; i < 1005; i++) {
      relay.enqueue({ title: `n${i}` });
    }
    expect(relay.pending()).toBe(1000);
    expect(onError).toHaveBeenCalledTimes(5);
    await vi.advanceTimersByTimeAsync(0);
    expect(sends[0]?.[0]?.title).toBe('n5');
  });

  it('still names an overflow when the sender fails after a retry put items back', async () => {
    const { relay } = make({}, async () => ({ outcome: 'retry' }));
    for (let i = 0; i < 1000; i++) {
      relay.enqueue({ title: `n${i}` });
    }
    await vi.advanceTimersByTimeAsync(0); // first 50 sent, failed, put back at the front
    relay.enqueue({ title: 'late' });
    expect(relay.pending()).toBe(1000); // oldest dropped to admit it
  });
});

describe('flush and suspend', () => {
  it('flush sends what is pending now, without waiting for the delay, and resolves true', async () => {
    const { relay } = make({ flushDelayMs: 60_000 });
    relay.enqueue({ title: 'a' });
    relay.enqueue({ title: 'b' });
    await expect(relay.flush()).resolves.toBe(true);
    expect(sends).toHaveLength(1);
    expect(relay.pending()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000); // the cancelled window does not fire again
    expect(sends).toHaveLength(1);
  });

  it('flush leaves no timer behind: not the window, not a backoff', async () => {
    let ok = false;
    const { relay } = make({ flushDelayMs: 60_000 }, async () =>
      ok ? SENT : { outcome: 'retry' },
    );
    relay.enqueue({ title: 'a' });
    ok = true;
    await relay.flush();
    expect(vi.getTimerCount()).toBe(0);

    ok = false;
    relay.enqueue({ title: 'b' });
    await relay.flush(); // fails: one backoff timer is armed
    expect(vi.getTimerCount()).toBe(1);
    await relay.flush(); // fails again: the old backoff is replaced, not added to
    expect(vi.getTimerCount()).toBe(1);
    ok = true;
    await relay.flush(); // delivers: the backoff has nothing left to do
    expect(vi.getTimerCount()).toBe(0);
  });

  it('flush is false when an urgent send fails after the queue was already empty', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { relay } = make({}, async () => {
      await gate;
      return { outcome: 'retry' };
    });
    relay.enqueue({ title: 'u', urgent: true });
    await vi.advanceTimersByTimeAsync(0);
    const flushed = relay.flush();
    release?.();
    await expect(flushed).resolves.toBe(false);
    expect(relay.pending()).toBe(1);
  });

  it('flush resolves true when there is nothing to send', async () => {
    const { relay, send } = make();
    await expect(relay.flush()).resolves.toBe(true);
    expect(send).not.toHaveBeenCalled();
  });

  it('flush resolves false when the batch could not be delivered', async () => {
    const { relay } = make({}, async () => ({ outcome: 'retry' }));
    relay.enqueue({ title: 'a' });
    await expect(relay.flush()).resolves.toBe(false);
    expect(relay.pending()).toBe(1);
  });

  it('flush joins a drain already running instead of starting another', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { relay, send } = make({}, async () => {
      await gate;
      return SENT;
    });
    relay.enqueue({ title: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    const flushed = relay.flush();
    release?.();
    await expect(flushed).resolves.toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('flush waits for an urgent send that is still in flight', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { relay } = make({}, async () => {
      await gate;
      return SENT;
    });
    relay.enqueue({ title: 'u', urgent: true });
    await vi.advanceTimersByTimeAsync(0);
    let done = false;
    const flushed = relay.flush().then((result) => {
      done = true;
      return result;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    release?.();
    await expect(flushed).resolves.toBe(true);
  });

  it('flush retries immediately even while the backoff timer is pending, and re-arms it on failure', async () => {
    let ok = false;
    const { relay, send } = make({}, async () => (ok ? SENT : { outcome: 'retry' }));
    relay.enqueue({ title: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    await expect(relay.flush()).resolves.toBe(false);
    expect(send).toHaveBeenCalledTimes(2);
    ok = true;
    await vi.advanceTimersByTimeAsync(10_000); // the (single) re-armed retry delivers it
    expect(relay.pending()).toBe(0);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('suspend cancels the pending window and the backoff but keeps the queue', async () => {
    const { relay, send } = make({ flushDelayMs: 1000 });
    relay.enqueue({ title: 'a' });
    relay.suspend();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).not.toHaveBeenCalled();
    expect(relay.pending()).toBe(1);
    // while stopped a later notification is only queued; resume() sends it with the old one
    relay.enqueue({ title: 'b' });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(send).not.toHaveBeenCalled();
    relay.resume();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sends[0]?.map((i) => i.title)).toEqual(['a', 'b']);
  });

  it('suspend also cancels a backoff timer', async () => {
    const { relay, send } = make({}, async () => ({ outcome: 'retry' }));
    relay.enqueue({ title: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    relay.suspend();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('timers', () => {
  it('unrefs its timers so a pending notification never keeps a process alive', async () => {
    const unref = vi.fn();
    const handle = { unref };
    const timerHost = globalThis as unknown as {
      setTimeout: (cb: () => void, ms: number) => unknown;
    };
    const setTimeoutSpy = vi.spyOn(timerHost, 'setTimeout').mockReturnValue(handle as never);
    try {
      const { relay } = make();
      relay.enqueue({ title: 'a' });
      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      setTimeoutSpy.mockRestore();
    }
  });

  it('works with injected timers and a handle that has no unref', async () => {
    const scheduled: Array<() => void> = [];
    const cleared: unknown[] = [];
    const { relay } = make({
      timers: {
        setTimeout: (cb) => {
          scheduled.push(cb);
          return scheduled.length;
        },
        clearTimeout: (handle) => {
          cleared.push(handle);
        },
      },
    });
    relay.enqueue({ title: 'a' });
    expect(scheduled).toHaveLength(1);
    scheduled[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(sends).toHaveLength(1);
    relay.enqueue({ title: 'b' });
    relay.suspend();
    expect(cleared).toEqual([2]);
  });

  it('defaults the id to a fresh unique value per notification', async () => {
    const relay = createNotifyRelay({
      send: async (items) => {
        sends.push(items.map((item) => ({ ...item })));
        return SENT;
      },
      clock: { wallNow: () => 1, monotonicNow: () => 0 },
      flushDelayMs: 0,
    });
    relay.enqueue({ title: 'a' });
    relay.enqueue({ title: 'b' });
    await vi.advanceTimersByTimeAsync(0);
    const [a, b] = sends[0] as NotifyItem[];
    expect(a?.id).toMatch(/^[0-9a-f]{20,}$/);
    expect(a?.id).not.toBe(b?.id);
  });

  it('a throwing onError never breaks the relay', async () => {
    const relay = createNotifyRelay({
      send: async () => ({ outcome: 'rejected' }),
      clock: { wallNow: () => 1, monotonicNow: () => 0 },
      flushDelayMs: 0,
      onError: () => {
        throw new Error('sink');
      },
    });
    relay.enqueue({ title: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    expect(relay.pending()).toBe(0);
  });
});

describe('suspend / resume: a stopped SDK sends nothing (P4)', () => {
  it('flush after suspend sends nothing, keeps the queue and reports it undelivered', async () => {
    const { relay, send } = make({ flushDelayMs: 5000 });
    relay.enqueue({ title: 'a' });
    relay.suspend();
    await expect(relay.flush()).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
    expect(relay.pending()).toBe(1);
  });

  it('flush after suspend is true when nothing is pending', async () => {
    const { relay } = make();
    relay.suspend();
    await expect(relay.flush()).resolves.toBe(true);
  });

  it('a send that fails after suspend does not re-arm the retry timer', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { relay, send } = make({}, async () => {
      await gate;
      return { outcome: 'retry' };
    });
    relay.enqueue({ title: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    relay.suspend();
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0); // no backoff armed
    await vi.advanceTimersByTimeAsync(120_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a drain in progress at suspend sends no further batch', async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const { relay, send } = make({}, async () => {
      calls += 1;
      if (calls === 1) {
        await gate;
      }
      return SENT;
    });
    for (let i = 0; i < 120; i++) {
      relay.enqueue({ title: `n${i}` });
    }
    await vi.advanceTimersByTimeAsync(0);
    relay.suspend();
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('an urgent notification after suspend is queued, not sent', async () => {
    const { relay, send } = make();
    relay.suspend();
    relay.enqueue({ title: 'u', urgent: true });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    expect(relay.pending()).toBe(1);
  });

  it('resume clears the stopped state and sends what was kept', async () => {
    const { relay, send } = make();
    relay.enqueue({ title: 'a' });
    relay.suspend();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).not.toHaveBeenCalled();
    relay.resume();
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('resume with an empty queue arms nothing', () => {
    const { relay } = make();
    relay.suspend();
    relay.resume();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('queue caps: total bytes and age (P6)', () => {
  it('drops the oldest once the queued bytes pass 1 MB', async () => {
    const { relay, onError } = make({ flushDelayMs: 100_000 });
    const big = 'x'.repeat(200 * 1024);
    for (let i = 0; i < 7; i++) {
      relay.enqueue({ title: `n${i}`, body: big });
    }
    // 7 x ~200 KB > 1 MB: the two oldest go, five (~1000 KB) fit
    expect(relay.pending()).toBe(5);
    expect(onError).toHaveBeenCalledTimes(2);
    relay.suspend();
    relay.resume();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(sends.flat().map((i) => i.title)).toEqual(['n2', 'n3', 'n4', 'n5', 'n6']);
  });

  it('the 1 MB bound is inclusive: exactly 1 MB stays, one byte more drops the oldest (m24)', () => {
    const exact = (title: string, id: string, body: string) =>
      utf8ByteLength(JSON.stringify({ id, timestamp: 1_700_000_000_000, title, body }));
    const target = 256 * 1024; // the per-item maximum, so four of them are exactly 1 MiB
    const padFor = (title: string, id: string) => 'x'.repeat(target - exact(title, id, ''));
    const { relay, onError } = make({ flushDelayMs: 100_000 });
    for (let i = 0; i < 4; i++) {
      relay.enqueue({ title: `n${i}`, body: padFor(`n${i}`, `id${i + 1}`) });
    }
    expect(relay.pending()).toBe(4); // 4 x 262144 == 1048576: not over the bound
    expect(onError).not.toHaveBeenCalled();
    relay.enqueue({ title: 'n4', body: 'y' }); // one more small item tips it over
    expect(relay.pending()).toBe(4);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(String(onError.mock.calls[0]?.[0])).toContain('1 MB');
  });

  it('keeps a lone notification even when it alone is the largest allowed', () => {
    const { relay, onError } = make({ flushDelayMs: 100_000 });
    relay.enqueue({ title: 't', body: 'x'.repeat(250 * 1024) });
    expect(relay.pending()).toBe(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('drops a notification older than 72 h instead of sending it', async () => {
    let now = 1_700_000_000_000;
    const { relay, send, onError } = make(
      { clock: { wallNow: () => now, monotonicNow: () => 0 }, flushDelayMs: 100_000 },
      async () => SENT,
    );
    relay.enqueue({ title: 'old' });
    now += 72 * 3600_000 + 1;
    relay.enqueue({ title: 'fresh' });
    expect(relay.pending()).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    await relay.flush();
    expect(send.mock.calls[0]?.[0].map((i: NotifyItem) => i.title)).toEqual(['fresh']);
  });

  it('keeps one exactly 72 h old', async () => {
    let now = 1_700_000_000_000;
    const { relay } = make({
      clock: { wallNow: () => now, monotonicNow: () => 0 },
      flushDelayMs: 100_000,
    });
    relay.enqueue({ title: 'edge' });
    now += 72 * 3600_000;
    relay.enqueue({ title: 'fresh' });
    expect(relay.pending()).toBe(2);
  });

  it('drops an aged item that waited out a backoff before retrying it', async () => {
    let now = 1_700_000_000_000;
    let calls = 0;
    const { relay, send } = make(
      { clock: { wallNow: () => now, monotonicNow: () => 0 } },
      async () => {
        calls += 1;
        return calls === 1 ? { outcome: 'retry' } : SENT;
      },
    );
    relay.enqueue({ title: 'old' });
    await vi.advanceTimersByTimeAsync(0);
    now += 73 * 3600_000;
    await vi.advanceTimersByTimeAsync(2000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(relay.pending()).toBe(0);
  });
});

describe('urgent sends are tracked without an ever-growing chain (P7)', () => {
  it('flush waits for every urgent send in flight, in any completion order', async () => {
    const releases: Array<() => void> = [];
    const { relay } = make(
      {},
      () => new Promise<NotifyResult>((resolve) => releases.push(() => resolve(SENT))),
    );
    for (let i = 0; i < 3; i++) {
      relay.enqueue({ title: `u${i}`, urgent: true });
    }
    await vi.advanceTimersByTimeAsync(0);
    let done = false;
    const flushed = relay.flush().then((r) => {
      done = true;
      return r;
    });
    releases[2]?.();
    releases[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    releases[1]?.();
    await expect(flushed).resolves.toBe(true);
  });

  it('flush also waits for an urgent send that starts while it is waiting', async () => {
    const releases: Array<() => void> = [];
    const { relay } = make(
      {},
      () => new Promise<NotifyResult>((resolve) => releases.push(() => resolve(SENT))),
    );
    relay.enqueue({ title: 'u0', urgent: true });
    await vi.advanceTimersByTimeAsync(0);
    let done = false;
    const flushed = relay.flush().then((r) => {
      done = true;
      return r;
    });
    await vi.advanceTimersByTimeAsync(0); // flush is now parked on u0
    relay.enqueue({ title: 'u1', urgent: true });
    await vi.advanceTimersByTimeAsync(0);
    releases[0]?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(done).toBe(false);
    releases[1]?.();
    await expect(flushed).resolves.toBe(true);
  });

  it('flush resolves immediately once all urgent sends have finished', async () => {
    const { relay } = make();
    relay.enqueue({ title: 'u', urgent: true });
    await vi.advanceTimersByTimeAsync(0);
    await expect(relay.flush()).resolves.toBe(true);
  });
});

describe('collector verdicts: retry-after and kill (P9)', () => {
  it('waits the collector-given retryAfter instead of the backoff', async () => {
    let calls = 0;
    const { relay, send } = make({}, async () => {
      calls += 1;
      return calls === 1 ? { outcome: 'retry', retryAfterMs: 30_000 } : SENT;
    });
    relay.enqueue({ title: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(29_000);
    expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('never waits more than 10 minutes on a retryAfter', async () => {
    let calls = 0;
    const { relay, send } = make({}, async () => {
      calls += 1;
      return calls === 1 ? { outcome: 'retry', retryAfterMs: 86_400_000 } : SENT;
    });
    relay.enqueue({ title: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(600_000);
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('a retryAfter of 0 (or a hair above) is floored to the backoff step: never a hammer loop (R2P-2)', async () => {
    for (const hint of [0, 0.1]) {
      sends = [];
      const { relay, send } = make({}, async () => ({ outcome: 'retry', retryAfterMs: hint }));
      relay.enqueue({ title: 'a' });
      await vi.advanceTimersByTimeAsync(0);
      expect(send).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1999);
      expect(send).toHaveBeenCalledTimes(1); // the 2 s floor holds
      await vi.advanceTimersByTimeAsync(1);
      expect(send).toHaveBeenCalledTimes(2);
      // exponential backoff continues under a constant 0 hint: 4 s, 8 s ...
      await vi.advanceTimersByTimeAsync(3999);
      expect(send).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(send).toHaveBeenCalledTimes(3);
      await vi.advanceTimersByTimeAsync(8000);
      expect(send).toHaveBeenCalledTimes(4);
      relay.suspend();
    }
  });

  it('a collector hint above the backoff still wins; the backoff keeps growing underneath (R2P-2)', async () => {
    const results: NotifyResult[] = [
      { outcome: 'retry', retryAfterMs: 30_000 },
      { outcome: 'retry' },
      SENT,
    ];
    const { relay, send } = make({}, async () => results.shift() as NotifyResult);
    relay.enqueue({ title: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3999); // the second plain retry is on the 4 s step, not 2 s
    expect(send).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('halves the batch on repeated 429s (the collector may be refusing its size) and recovers (R2P-2)', async () => {
    const batchSizes: number[] = [];
    let limited = 4;
    const { relay } = make({ flushDelayMs: 50 }, async (items) => {
      batchSizes.push(items.length);
      if (items.length > 10 && limited > 0) {
        limited -= 1;
        return { outcome: 'retry', retryAfterMs: 1000, rateLimited: true };
      }
      return SENT;
    });
    for (let i = 0; i < 50; i++) {
      relay.enqueue({ title: `n${i}` });
    }
    await vi.advanceTimersByTimeAsync(50);
    for (let i = 0; i < 40; i++) {
      await vi.advanceTimersByTimeAsync(5000);
    }
    // 50 (429), 50 (429 -> repeated: halve), 25 (429 -> halve), 12 (429 -> halve) ... then success
    expect(batchSizes.slice(0, 3)).toEqual([50, 50, 25]);
    expect(Math.min(...batchSizes)).toBeLessThanOrEqual(12);
    expect(relay.pending()).toBe(0);
  });

  it('successes double the batch ceiling back up after it was halved (R2P-2)', async () => {
    const batchSizes: number[] = [];
    let calls = 0;
    const { relay } = make({ flushDelayMs: 50 }, async (items) => {
      batchSizes.push(items.length);
      calls += 1;
      return calls <= 3 ? { outcome: 'retry', rateLimited: true } : SENT;
    });
    for (let i = 0; i < 100; i++) {
      relay.enqueue({ title: `n${i}` });
    }
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(batchSizes).toEqual([50, 50, 25, 12, 24, 48, 16]);
  });

  it('a success resets the repeated-429 count (R2P-2)', async () => {
    const batchSizes: number[] = [];
    const results: NotifyResult[] = [
      { outcome: 'retry', rateLimited: true },
      SENT,
      { outcome: 'retry', rateLimited: true },
    ];
    const { relay } = make({ flushDelayMs: 50 }, async (items) => {
      batchSizes.push(items.length);
      return results.shift() ?? SENT;
    });
    for (let i = 0; i < 100; i++) {
      relay.enqueue({ title: `n${i}` });
    }
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(batchSizes).toEqual([50, 50, 50, 50]);
  });

  it('a non-429 retry in between resets the repeated-429 count (no halving) (R2P-2)', async () => {
    const batchSizes: number[] = [];
    const results: NotifyResult[] = [
      { outcome: 'retry', rateLimited: true },
      { outcome: 'retry' },
      { outcome: 'retry', rateLimited: true },
      SENT,
    ];
    const { relay } = make({ flushDelayMs: 50 }, async (items) => {
      batchSizes.push(items.length);
      return results.shift() ?? SENT;
    });
    for (let i = 0; i < 50; i++) {
      relay.enqueue({ title: `n${i}` });
    }
    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(batchSizes.slice(0, 4)).toEqual([50, 50, 50, 50]);
  });

  it('a kill verdict drops the queue, stops sending and tells the owner once', async () => {
    const onKill = vi.fn();
    const { relay, send } = make({ onKill }, async () => ({ outcome: 'kill' }));
    relay.enqueue({ title: 'a' });
    relay.enqueue({ title: 'b' });
    await vi.advanceTimersByTimeAsync(0);
    expect(onKill).toHaveBeenCalledTimes(1);
    expect(relay.pending()).toBe(0);
    relay.enqueue({ title: 'c' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('resume after a kill verdict sends nothing: the relay stays dead', async () => {
    const { relay, send } = make({}, async () => ({ outcome: 'kill' }));
    relay.enqueue({ title: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    relay.resume();
    relay.enqueue({ title: 'b' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(send).toHaveBeenCalledTimes(1);
    expect(relay.pending()).toBe(0);
  });

  it('a kill verdict also drops what had not been batched yet', async () => {
    const { relay } = make({}, async () => ({ outcome: 'kill' }));
    for (let i = 0; i < 60; i++) {
      relay.enqueue({ title: `n${i}` });
    }
    await vi.advanceTimersByTimeAsync(0);
    expect(relay.pending()).toBe(0);
  });

  it('a throwing onKill never breaks the relay', async () => {
    const { relay } = make(
      {
        onKill: () => {
          throw new Error('x');
        },
      },
      async () => ({ outcome: 'kill' }),
    );
    relay.enqueue({ title: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    expect(relay.pending()).toBe(0);
  });
});

describe('take / adopt — the relaunch() hand-over (R2L-6)', () => {
  it('take() removes the queued notifications and cancels the scheduled send', async () => {
    const { relay, send } = make({ flushDelayMs: 1000 });
    relay.enqueue({ title: 'a' });
    relay.enqueue({ title: 'b' });
    const taken = relay.take();
    expect(taken.map((item) => item.title)).toEqual(['a', 'b']);
    expect(relay.pending()).toBe(0);
    await vi.advanceTimersByTimeAsync(5000);
    expect(send).not.toHaveBeenCalled();
  });

  it('adopt() puts handed-over items AHEAD of newer ones and sends them', async () => {
    const donor = make({ flushDelayMs: 1000 });
    donor.relay.enqueue({ title: 'old' });
    const handed = donor.relay.take();
    const { relay } = make({ flushDelayMs: 0 });
    relay.enqueue({ title: 'newer' });
    relay.adopt(handed);
    await vi.advanceTimersByTimeAsync(0);
    expect(sends.flat().map((item) => item.title)).toEqual(['old', 'newer']);
  });

  it('adopt([]) is a no-op and adopt() after a kill verdict drops everything', async () => {
    const { relay, send } = make({}, async () => ({ outcome: 'kill' }));
    relay.adopt([]);
    await vi.advanceTimersByTimeAsync(10);
    expect(send).not.toHaveBeenCalled();
    relay.enqueue({ title: 'x' });
    await vi.advanceTimersByTimeAsync(0);
    expect(send).toHaveBeenCalledTimes(1);
    relay.adopt([{ id: 'z', timestamp: 1_700_000_000_000, title: 'late' }]);
    await vi.advanceTimersByTimeAsync(10);
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('take() hands back what a request still in flight later fails to deliver (R3L-5)', () => {
  const inFlight = () => {
    let settle: (result: NotifyResult) => void = () => {};
    const send: Send = () =>
      new Promise<NotifyResult>((resolve) => {
        settle = resolve;
      });
    return { send, settle: (result: NotifyResult) => settle(result) };
  };

  it('a failed batch that was in flight at take() goes to onHandBack, not back into the dead queue', async () => {
    const flight = inFlight();
    const onHandBack = vi.fn();
    const { relay } = make({ onHandBack }, flight.send);
    relay.enqueue({ title: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    expect(relay.take()).toEqual([]); // it is in a request, not queued
    flight.settle({ outcome: 'retry' });
    await vi.advanceTimersByTimeAsync(0);
    expect(onHandBack).toHaveBeenCalledTimes(1);
    expect(onHandBack.mock.calls[0]?.[0].map((item: NotifyItem) => item.title)).toEqual(['a']);
    expect(relay.pending()).toBe(0);
  });

  it('only the ids the collector asked to retry are handed back', async () => {
    const flight = inFlight();
    const onHandBack = vi.fn();
    const { relay } = make({ onHandBack, flushDelayMs: 1000 }, flight.send);
    relay.enqueue({ title: 'a' });
    relay.enqueue({ title: 'b' });
    await vi.advanceTimersByTimeAsync(1000);
    relay.take();
    flight.settle({ outcome: 'retry', retryIds: ['id2'] });
    await vi.advanceTimersByTimeAsync(0);
    expect(onHandBack.mock.calls[0]?.[0].map((item: NotifyItem) => item.title)).toEqual(['b']);
  });

  it('an urgent send that fails after take() is handed back too', async () => {
    const flight = inFlight();
    const onHandBack = vi.fn();
    const { relay } = make({ onHandBack }, flight.send);
    relay.enqueue({ title: 'now', urgent: true });
    await vi.advanceTimersByTimeAsync(0);
    relay.take();
    flight.settle({ outcome: 'retry' });
    await vi.advanceTimersByTimeAsync(0);
    expect(onHandBack).toHaveBeenCalledTimes(1);
    expect(relay.pending()).toBe(0);
  });

  it('a throwing onHandBack sink is reported and never breaks the relay', async () => {
    const flight = inFlight();
    const { relay, onError } = make(
      {
        onHandBack: () => {
          throw new Error('sink');
        },
      },
      flight.send,
    );
    relay.enqueue({ title: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    relay.take();
    flight.settle({ outcome: 'retry' });
    await vi.advanceTimersByTimeAsync(0);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'sink' }));
  });

  it('without take(), or after resume(), a failed batch is requeued as before', async () => {
    const flight = inFlight();
    const onHandBack = vi.fn();
    const { relay } = make({ onHandBack }, flight.send);
    relay.enqueue({ title: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    flight.settle({ outcome: 'retry' });
    await vi.advanceTimersByTimeAsync(0);
    expect(onHandBack).not.toHaveBeenCalled();
    expect(relay.pending()).toBe(1);

    const second = inFlight();
    const again = make({ onHandBack }, second.send);
    again.relay.enqueue({ title: 'b' });
    await vi.advanceTimersByTimeAsync(0);
    again.relay.take();
    again.relay.resume(); // a re-launch takes the relay back
    second.settle({ outcome: 'retry' });
    await vi.advanceTimersByTimeAsync(0);
    expect(onHandBack).not.toHaveBeenCalled();
    expect(again.relay.pending()).toBe(1);
  });

  it('without an onHandBack sink the failed batch stays in the queue (nothing to hand to)', async () => {
    const flight = inFlight();
    const { relay } = make({}, flight.send);
    relay.enqueue({ title: 'a' });
    await vi.advanceTimersByTimeAsync(0);
    relay.take();
    flight.settle({ outcome: 'retry' });
    await vi.advanceTimersByTimeAsync(0);
    expect(relay.pending()).toBe(1);
  });
});
