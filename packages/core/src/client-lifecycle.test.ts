import type { EnvironmentEnvelope } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createClient } from './client';
import { BugseeError } from './errors';
import { LifecycleEvents } from './lifecycle-events';
import type { UploadPipeline, UploadResult } from './transport';
import type { TriggerPipeline } from './trigger-pipeline';

const getEnvironment = (): EnvironmentEnvelope => ({
  platform: { type: 'web', version: '1' },
  runtime: { type: 'web', version: '' },
  sdk: { version: '0', type: 'javascript' },
});

const setup = (
  enqueue: UploadPipeline['enqueue'] = async () => ({ ok: true }),
  extra: { onError?: (e: unknown) => void } = {},
) => {
  const uploadPipeline: UploadPipeline = { enqueue, flush: async () => true, drop: vi.fn() };
  const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment, ...extra });
  const events: Array<[string, unknown]> = [];
  client.setLifecycleEventsListener((type, data) => events.push([type, data]));
  const types = (): string[] => events.map(([type]) => type);
  return { client, events, types };
};

describe('lifecycle events — launch and stop', () => {
  it('emits Launching then Launched around launch()', () => {
    const { client, types } = setup();
    client.launch();
    expect(types()).toEqual([LifecycleEvents.Launching, LifecycleEvents.Launched]);
  });

  it('emits Launching BEFORE providers start and Launched AFTER', () => {
    const order: string[] = [];
    const client = createClient();
    client.setLifecycleEventsListener((type) => order.push(type));
    client.addCaptureProvider({
      name: 'p',
      init: () => {},
      start: () => order.push('provider-start'),
      stop: () => {},
    });
    client.launch();
    expect(order).toEqual([LifecycleEvents.Launching, 'provider-start', LifecycleEvents.Launched]);
  });

  it('does not emit again for an ignored second launch()', () => {
    const { client, types } = setup();
    client.launch();
    client.launch();
    expect(types()).toHaveLength(2);
  });

  it('emits Stopping then Stopped around stop(), Stopped after the drain', async () => {
    const { client, types, events } = setup();
    client.launch();
    events.length = 0;
    const done = client.stop();
    expect(types()).toEqual([LifecycleEvents.Stopping]);
    await done;
    expect(types()).toEqual([LifecycleEvents.Stopping, LifecycleEvents.Stopped]);
  });

  it('emits nothing for stop() on a client that is not launched', async () => {
    const { client, types } = setup();
    await client.stop();
    expect(types()).toEqual([]);
  });

  it('a throwing listener never breaks launch/stop and is reported to onError', async () => {
    const onError = vi.fn();
    const client = createClient({ onError });
    const boom = new Error('listener');
    client.setLifecycleEventsListener(() => {
      throw boom;
    });
    expect(() => client.launch()).not.toThrow();
    expect(client.isLaunched()).toBe(true);
    await expect(client.stop()).resolves.toBe(true);
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('null clears the listener', () => {
    const { client, types } = setup();
    client.setLifecycleEventsListener(null);
    client.launch();
    expect(types()).toEqual([]);
  });
});

describe('lifecycle events — report pipeline', () => {
  it('emits assembly then upload events with the report id, in order, on success', async () => {
    const { client, events, types } = setup();
    await client.logException(new Error('boom'));
    expect(types()).toEqual([
      LifecycleEvents.BeforeReportAssembled,
      LifecycleEvents.AfterReportAssembled,
      LifecycleEvents.BeforeReportUploaded,
      LifecycleEvents.AfterReportUploaded,
    ]);
    const ids = new Set(events.map(([, data]) => (data as { reportId: string }).reportId));
    expect(ids.size).toBe(1);
    expect([...ids][0]).toEqual(expect.any(String));
  });

  it('classifies a permanent refusal as ReportUploadFailed', async () => {
    const { client, types } = setup(async () => ({ ok: false, permanent: true }));
    await client.logException(new Error('boom'));
    expect(types().slice(-2)).toEqual([
      LifecycleEvents.BeforeReportUploaded,
      LifecycleEvents.ReportUploadFailed,
    ]);
  });

  it('classifies a retained retryable failure as ReportUploadFailedWithFutureRetry', async () => {
    const { client, types } = setup(async () => ({ ok: false, retained: true }));
    await client.logException(new Error('boom'));
    expect(types().at(-1)).toBe(LifecycleEvents.ReportUploadFailedWithFutureRetry);
  });

  it('a refusal is ReportUploadFailed even if the queue also flagged it retained', async () => {
    const { client, types } = setup(async () => ({ ok: false, permanent: true, retained: true }));
    await client.logException(new Error('boom'));
    expect(types().at(-1)).toBe(LifecycleEvents.ReportUploadFailed);
  });

  it('a failure nothing will retry (not retained, not permanent) is ReportUploadFailed', async () => {
    const { client, types } = setup(async () => ({ ok: false }));
    await client.logException(new Error('boom'));
    expect(types().at(-1)).toBe(LifecycleEvents.ReportUploadFailed);
  });

  it('a failed assembly emits ReportAssemblyFailed (with the error) and no upload events', async () => {
    // Breaking the environment builder makes assembly throw.
    const uploadPipeline: UploadPipeline = {
      enqueue: async () => ({ ok: true }),
      flush: async () => true,
      drop: vi.fn(),
    };
    const failing = createClient({
      uploadPipeline,
      appToken: 'tok',
      getEnvironment: () => {
        throw new Error('env');
      },
    });
    const seen: Array<[string, unknown]> = [];
    failing.setLifecycleEventsListener((t, d) => seen.push([t, d]));
    const result = await failing.logException(new Error('boom'));
    expect(result.ok).toBe(false);
    expect(seen.map(([t]) => t)).toEqual([
      LifecycleEvents.BeforeReportAssembled,
      LifecycleEvents.ReportAssemblyFailed,
    ]);
    const data = seen[1]?.[1] as { reportId: string; error: unknown };
    expect(data.error).toBeInstanceOf(Error);
    expect((data.error as Error).message).toBe('env');
    expect(data.reportId).toEqual(expect.any(String));
  });

  it('a non-conforming pipeline result is isolated: after still runs, onError hears of it', async () => {
    const onError = vi.fn();
    const after = vi.fn();
    const { client } = setup((async () => null) as unknown as UploadPipeline['enqueue'], {
      onError,
    });
    client.setReportHandler({ after });
    await client.logException(new Error('boom'));
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(onError).toHaveBeenCalled();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('emits no report events for a vetoed report', async () => {
    const { client, types } = setup();
    client.setReportHandler({ before: () => null });
    await client.logException(new Error('boom'));
    expect(types()).toEqual([]);
  });

  it('emits no upload events when an injected trigger pipeline never assembles', async () => {
    const triggerPipeline: TriggerPipeline = { report: async () => ({ ok: true }) };
    const client = createClient({ triggerPipeline });
    const listener = vi.fn();
    client.setLifecycleEventsListener(listener);
    await client.logException(new Error('boom'));
    expect(listener).not.toHaveBeenCalled();
  });

  it('a throwing listener cannot break the report, and the result is unchanged', async () => {
    const onError = vi.fn();
    const { client } = setup(async () => ({ ok: true }), { onError });
    client.setLifecycleEventsListener(() => {
      throw new Error('listener');
    });
    await expect(client.logException(new Error('boom'))).resolves.toEqual({ ok: true });
    expect(onError).toHaveBeenCalled();
  });

  it('upload() reports the same events', async () => {
    const { client, types } = setup();
    await client.upload({ summary: 's' });
    expect(types()).toContain(LifecycleEvents.AfterReportUploaded);
  });

  it('an enqueue that reports a BugseeError result still classifies by result flags', async () => {
    const { client, types } = setup(async () => ({
      ok: false,
      error: new BugseeError('x', 503),
      retained: true,
    }));
    await client.logException(new Error('boom'));
    expect(types().at(-1)).toBe(LifecycleEvents.ReportUploadFailedWithFutureRetry);
  });
});

describe('lifecycle events — emitLifecycleEvent hook', () => {
  it('forwards a hook-emitted event with its data to the listener', () => {
    const { client, events } = setup();
    client.emitLifecycleEvent(LifecycleEvents.BeforeReportShown, { x: 1 });
    expect(events).toEqual([[LifecycleEvents.BeforeReportShown, { x: 1 }]]);
  });
});

describe('ReportHandler.after', () => {
  const settle = async (): Promise<void> => {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
  };

  it('runs after the report settles, with the (post-before) request', async () => {
    const calls: string[] = [];
    let release: (r: UploadResult) => void = () => {};
    const { client } = setup(
      () =>
        new Promise<UploadResult>((resolve) => {
          release = resolve;
        }),
    );
    client.setReportHandler({
      before: (r) => {
        r.report.summary = 'masked';
        return r;
      },
      after: (r) => {
        calls.push(r.report.summary ?? '');
      },
    });
    const pending = client.logException(new Error('boom'));
    await settle();
    expect(calls).toEqual([]); // not before the hand-off completes
    release({ ok: true });
    await pending;
    await settle();
    expect(calls).toEqual(['masked']);
  });

  it('runs for upload() and also after a failed upload', async () => {
    const after = vi.fn();
    const { client } = setup(async () => ({ ok: false }));
    client.setReportHandler({ after });
    await client.upload({ summary: 's' });
    await settle();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('is not run for a vetoed report', async () => {
    const after = vi.fn();
    const { client } = setup();
    client.setReportHandler({ before: () => null, after });
    await client.logException(new Error('boom'));
    await settle();
    expect(after).not.toHaveBeenCalled();
  });

  it('a throwing after never breaks reporting and goes to onError', async () => {
    const onError = vi.fn();
    const { client } = setup(async () => ({ ok: true }), { onError });
    const boom = new Error('after');
    client.setReportHandler({
      after: () => {
        throw boom;
      },
    });
    await expect(client.logException(new Error('x'))).resolves.toEqual({ ok: true });
    await settle();
    expect(onError).toHaveBeenCalledWith(boom);
  });

  it('runs even when the pipeline rejects', async () => {
    const after = vi.fn();
    const triggerPipeline: TriggerPipeline = {
      report: () => Promise.reject(new Error('pipeline')),
    };
    const client = createClient({ triggerPipeline });
    client.setReportHandler({ after });
    await client.logException(new Error('boom')).catch(() => undefined);
    await settle();
    expect(after).toHaveBeenCalledTimes(1);
  });

  it('is skipped when the handler has no after', async () => {
    const { client } = setup();
    client.setReportHandler({ before: (r) => r });
    await expect(client.logException(new Error('x'))).resolves.toEqual({ ok: true });
  });

  it('runs for detection-triggered reports too', async () => {
    const after = vi.fn();
    const uploadPipeline: UploadPipeline = {
      enqueue: async () => ({ ok: true }),
      flush: async () => true,
      drop: vi.fn(),
    };
    const client = createClient({ uploadPipeline, appToken: 'tok', getEnvironment });
    client.setReportHandler({ after });
    let trigger: (request: Parameters<typeof after>[0]) => void = () => {};
    client.addDetectionProvider({
      name: 'd',
      start: (_ctx: unknown, report: typeof trigger) => {
        trigger = report;
      },
      stop: () => {},
    } as never);
    client.launch();
    const { createReportingRequest } = await import('./reporting');
    trigger(
      createReportingRequest({
        source: { type: 'error', mechanism: 'programmatic' },
        summary: 's',
      }),
    );
    await settle();
    expect(after).toHaveBeenCalledTimes(1);
  });
});
