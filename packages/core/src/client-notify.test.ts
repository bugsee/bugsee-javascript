import type { EnvironmentEnvelope } from '@bugsee/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient } from './client';
import { BugseeError } from './errors';
import { BugseeStatus } from './launch-status';
import { createMemoryCaptureStore } from './memory-capture-store';
import { createOptionsContainer } from './options';
import type { NotifyItem, NotifyResult, UploadPipeline } from './transport';

// `client.notify()` (T7) through the real client: the launch gate, option parsing, the snapshot taken at
// the call, and the flush/stop drain. The relay's own batching and retry rules are in notify-relay.test.ts.

const env: EnvironmentEnvelope = {
  platform: { type: 'web', version: '1' },
  runtime: { type: 'web', version: '' },
  sdk: { version: '0', type: 'javascript' },
};
const FLUSH_DELAY = 'com.bugsee.option.config.notify-flush-delay';
const noScheduler = { setInterval: () => 'h', clearInterval: () => {} };
type Sender = (items: readonly NotifyItem[]) => Promise<NotifyResult>;

let batches: NotifyItem[][];
beforeEach(() => {
  vi.useFakeTimers();
  batches = [];
});
afterEach(() => {
  vi.useRealTimers();
});

const make = (
  over: {
    options?: Record<string, unknown>;
    sender?: Sender | null;
    onError?: (e: unknown) => void;
    uploadPipeline?: UploadPipeline;
  } = {},
) => {
  const sender = vi.fn<Sender>(async (items) => {
    batches.push(items.map((item) => ({ ...item })));
    return { outcome: 'sent' };
  });
  const onError = over.onError ?? vi.fn();
  const client = createClient({
    captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
    scheduler: noScheduler,
    launchOptions: createOptionsContainer(over.options ?? {}),
    ...(over.sender === null ? {} : { notifySender: over.sender ?? sender }),
    getEnvironment: () => env,
    appToken: 'tok',
    ...(over.uploadPipeline !== undefined ? { uploadPipeline: over.uploadPipeline } : {}),
    onError,
  });
  return { client, sender, onError };
};

describe('notify — gating', () => {
  it('is a no-op until launch() has been called', async () => {
    const { client, sender } = make();
    client.notify('too early');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sender).not.toHaveBeenCalled();
  });

  it('sends once launched, with the title, body, severity, fields and urgent flag', async () => {
    const { client } = make();
    client.launch();
    client.notify('Deploy finished', 'v1.2 is live', 'high', { env: 'prod' }, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(batches[0]?.[0]).toMatchObject({
      title: 'Deploy finished',
      body: 'v1.2 is live',
      severity: 3,
      fields: { env: 'prod' },
      urgent: true,
    });
  });

  it('accepts the title alone', async () => {
    const { client } = make();
    client.launch();
    client.notify('just a title');
    await vi.advanceTimersByTimeAsync(0);
    expect(batches[0]?.[0]).toMatchObject({ title: 'just a title' });
    expect(batches[0]?.[0]).not.toHaveProperty('body');
    expect(batches[0]?.[0]).not.toHaveProperty('urgent');
  });

  it('ignores an empty title', async () => {
    const { client, sender, onError } = make();
    client.launch();
    client.notify('');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sender).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('is a no-op after stop(), and works again after a re-launch', async () => {
    const { client, sender } = make();
    client.launch();
    await client.stop();
    client.notify('stopped');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sender).not.toHaveBeenCalled();
    client.launch();
    client.notify('back');
    await vi.advanceTimersByTimeAsync(0);
    expect(batches[0]?.[0]).toMatchObject({ title: 'back' });
  });

  it('is a silent no-op when the platform supplied no sender', async () => {
    const { client, onError } = make({ sender: null });
    client.launch();
    expect(() => client.notify('nowhere to go')).not.toThrow();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(onError).not.toHaveBeenCalled();
  });

  it('is a no-op once the collector has killed the SDK', async () => {
    const { client, sender } = make({
      uploadPipeline: {
        enqueue: async () => ({
          ok: false,
          error: new BugseeError('off', 0, { fatal: true, serverCode: 99_099 }),
        }),
        flush: async () => true,
        drop: () => {},
      },
    });
    client.launch();
    await client.logException(new Error('boom'));
    client.notify('after kill');
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sender).not.toHaveBeenCalled();
  });

  it('stops sending what was queued when the collector kills the SDK', async () => {
    const { client, sender } = make({
      options: { [FLUSH_DELAY]: 5000 },
      uploadPipeline: {
        enqueue: async () => ({
          ok: false,
          error: new BugseeError('off', 0, { fatal: true, serverCode: 99_099 }),
        }),
        flush: async () => true,
        drop: () => {},
      },
    });
    client.launch();
    client.notify('queued before the kill');
    await client.logException(new Error('boom'));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sender).not.toHaveBeenCalled();
  });

  it('a kill-state client does not flush queued notifications either', async () => {
    const { client, sender } = make({
      options: { [FLUSH_DELAY]: 5000 },
      uploadPipeline: {
        enqueue: async () => ({
          ok: false,
          error: new BugseeError('off', 0, { fatal: true, serverCode: 99_099 }),
        }),
        flush: async () => true,
        drop: () => {},
      },
    });
    client.launch();
    client.notify('queued before the kill');
    await client.logException(new Error('boom'));
    await client.flush();
    expect(sender).not.toHaveBeenCalled();
  });

  it('the relay answering 403 KillSdk switches the SDK off like a report verdict', async () => {
    const onError = vi.fn();
    const send = vi.fn<Sender>(async () => ({ outcome: 'kill' }));
    const { client } = make({ sender: send, onError });
    client.launch();
    client.notify('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(client.getStatus()).toBe(BugseeStatus.Stopped);
    expect(onError).toHaveBeenCalledTimes(1);
    expect((onError.mock.calls[0]?.[0] as BugseeError).fatal).toBe(true);
    client.notify('b');
    await vi.advanceTimersByTimeAsync(120_000);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('never throws, even if the relay does', async () => {
    const { client, onError } = make();
    client.launch();
    const hostile = new Proxy(
      {},
      {
        ownKeys: () => {
          throw new Error('keys');
        },
      },
    );
    expect(() => client.notify('t', 'b', 'high', hostile as Record<string, string>)).not.toThrow();
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'keys' }));
  });
});

describe('notify — snapshot and the flush delay option', () => {
  it('stamps the user, attributes and environment as of the call', async () => {
    const { client } = make();
    client.launch();
    client.setUserIdentifier('user-7');
    client.setAttribute('plan', 'pro');
    client.notify('hello');
    client.setUserIdentifier('user-8');
    client.clearAllAttributes();
    await vi.advanceTimersByTimeAsync(0);
    expect(batches[0]?.[0]).toMatchObject({
      user: { email: 'user-7' }, // Android parity: integrations read name/email only
      attributes: { plan: 'pro' },
      environment: env,
    });
  });

  it('keeps the user and attributes when the environment cannot be built', async () => {
    const onError = vi.fn();
    const client = createClient({
      captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
      scheduler: noScheduler,
      notifySender: async (items) => {
        batches.push(items.map((item) => ({ ...item })));
        return { outcome: 'sent' };
      },
      getEnvironment: () => {
        throw new Error('no env');
      },
      appToken: 'tok',
      onError,
    });
    client.launch();
    client.setUserIdentifier('u');
    client.notify('x');
    await vi.advanceTimersByTimeAsync(0);
    expect(batches[0]?.[0]).toMatchObject({ user: { email: 'u' } });
    expect(batches[0]?.[0]).not.toHaveProperty('environment');
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'no env' }));
  });

  it('omits the environment when the platform supplied no builder', async () => {
    const client = createClient({
      scheduler: noScheduler,
      notifySender: async (items) => {
        batches.push(items.map((item) => ({ ...item })));
        return { outcome: 'sent' };
      },
    });
    client.launch();
    client.notify('x');
    await vi.advanceTimersByTimeAsync(0);
    expect(batches[0]?.[0]).not.toHaveProperty('environment');
  });

  it('defaults the flush delay to 0: a burst leaves as one immediate batch', async () => {
    const { client } = make();
    client.launch();
    client.notify('a');
    client.notify('b');
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.map((i) => i.delivery)).toEqual(['immediate', 'immediate']);
  });

  it('honours notifyFlushDelay and stamps the batch deferred', async () => {
    const { client } = make({ options: { [FLUSH_DELAY]: 3000 } });
    client.launch();
    client.notify('a');
    await vi.advanceTimersByTimeAsync(2999);
    expect(batches).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches[0]?.[0]).toMatchObject({ title: 'a', delivery: 'deferred' });
  });

  it('lets an urgent notification skip the delay', async () => {
    const { client } = make({ options: { [FLUSH_DELAY]: 60_000 } });
    client.launch();
    client.notify('now', undefined, undefined, undefined, true);
    await vi.advanceTimersByTimeAsync(0);
    expect(batches[0]?.[0]).toMatchObject({ title: 'now', delivery: 'immediate' });
  });

  it.each([
    ['negative', -5],
    ['not a number', 'soon'],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['null', null],
  ])('falls back to 0 for a %s notifyFlushDelay', async (_label, value) => {
    const { client } = make({ options: { [FLUSH_DELAY]: value } });
    client.launch();
    client.notify('a');
    await vi.advanceTimersByTimeAsync(0);
    expect(batches).toHaveLength(1);
    expect(batches[0]?.[0]?.delivery).toBe('immediate'); // the window really is 0, not merely short
  });

  it('accepts a fractional delay by flooring it', async () => {
    const { client } = make({ options: { [FLUSH_DELAY]: 10.9 } });
    client.launch();
    client.notify('a');
    await vi.advanceTimersByTimeAsync(9);
    expect(batches).toEqual([]);
    await vi.advanceTimersByTimeAsync(1);
    expect(batches).toHaveLength(1);
  });
});

describe('notify — flush() and stop()', () => {
  it('flush() sends pending notifications without waiting for the delay', async () => {
    const { client } = make({ options: { [FLUSH_DELAY]: 60_000 } });
    client.launch();
    client.notify('a');
    await expect(client.flush()).resolves.toBe(true);
    expect(batches).toHaveLength(1);
  });

  it('flush() is false while a notification cannot be delivered', async () => {
    const { client } = make({ sender: async () => ({ outcome: 'retry' }) });
    client.launch();
    client.notify('a');
    await expect(client.flush()).resolves.toBe(false);
  });

  it('stop() delivers what is pending, then no timer fires for anything left over', async () => {
    const { client, sender } = make({ options: { [FLUSH_DELAY]: 60_000 } });
    client.launch();
    client.notify('a');
    await expect(client.stop()).resolves.toBe(true);
    expect(batches[0]?.[0]).toMatchObject({ title: 'a' });
    expect(sender).toHaveBeenCalledTimes(1);
  });

  it('stop() cancels the retry of a notification that could not be delivered', async () => {
    const send = vi.fn<Sender>(async () => ({ outcome: 'retry' }));
    const { client } = make({ sender: send });
    client.launch();
    client.notify('a');
    await client.stop();
    const calls = send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(send).toHaveBeenCalledTimes(calls);
  });

  it('flush() after stop() sends nothing; a re-launch sends what was kept', async () => {
    let online = false;
    const send = vi.fn<Sender>(async (items) => {
      if (!online) {
        return { outcome: 'retry' };
      }
      batches.push(items.map((item) => ({ ...item })));
      return { outcome: 'sent' };
    });
    const { client } = make({ sender: send });
    client.launch();
    client.notify('kept');
    await client.stop();
    const calls = send.mock.calls.length;
    online = true;
    await expect(client.flush()).resolves.toBe(false);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(send).toHaveBeenCalledTimes(calls);
    client.launch();
    await vi.advanceTimersByTimeAsync(0);
    expect(batches[0]?.[0]).toMatchObject({ title: 'kept' });
  });

  it('stop(timeout) does not wait forever for a sender that never answers', async () => {
    const { client } = make({ sender: () => new Promise<NotifyResult>(() => {}) });
    client.launch();
    client.notify('a');
    const stopped = client.stop(500);
    await vi.advanceTimersByTimeAsync(500);
    await expect(stopped).resolves.toBe(false);
  });

  it('flush() is false when the report uploads did not drain, even if the notifications did', async () => {
    const { client } = make({
      uploadPipeline: {
        enqueue: async () => ({ ok: true }),
        flush: async () => false,
        drop: () => {},
      },
    });
    client.launch();
    client.notify('a');
    await expect(client.flush()).resolves.toBe(false);
    expect(batches).toHaveLength(1);
  });

  it('flush() with no notifications and no relay is still true', async () => {
    const { client } = make({ sender: null });
    await expect(client.flush()).resolves.toBe(true);
  });
});
