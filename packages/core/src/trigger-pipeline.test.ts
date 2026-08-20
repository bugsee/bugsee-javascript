import { createDeferred } from '@bugsee/util';
import { describe, expect, it, vi } from 'vitest';
import { BugseeError } from './errors';
import { createReportingRequest, type ReportingRequest } from './reporting';
import type { Bundle, UploadPipeline, UploadResult } from './transport';
import { createTriggerPipeline } from './trigger-pipeline';

const bundle = (name = 'b.bundle.zip'): Bundle => ({
  request: {
    type: 'error',
    summary: 's',
    severity: 3,
    source: { type: 'crash', mechanism: 'uncaught' },
    created_on: 'x',
    environment: {
      platform: { type: 'web', version: '1' },
      sdk: { version: '0', type: 'javascript' },
    },
  },
  body: new Uint8Array([1]),
  fileName: name,
});

const request = (id: string): ReportingRequest =>
  createReportingRequest({ source: { type: 'code_upload' }, id });

function fakeUpload(): { uploadPipeline: UploadPipeline; enqueue: ReturnType<typeof vi.fn> } {
  const enqueue = vi.fn(async (): Promise<UploadResult> => ({ ok: true }));
  return {
    uploadPipeline: { enqueue, flush: async () => true, drop: () => {} },
    enqueue,
  };
}

describe('createTriggerPipeline', () => {
  it('assembles for the request and enqueues the bundle, returning the upload result', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const b = bundle();
    const assemble = vi.fn(async () => b);
    const req = request('boom');
    const result = await createTriggerPipeline({ assemble, uploadPipeline }).report(req);
    expect(assemble).toHaveBeenCalledWith(req);
    expect(enqueue).toHaveBeenCalledWith(b);
    expect(result).toEqual({ ok: true });
  });

  it('serializes a concurrent request behind the in-flight assembly', async () => {
    const { uploadPipeline } = fakeUpload();
    const d1 = createDeferred<Bundle>();
    const d2 = createDeferred<Bundle>();
    const assemble = vi
      .fn<(r: ReportingRequest) => Promise<Bundle>>()
      .mockReturnValueOnce(d1.promise)
      .mockReturnValueOnce(d2.promise);
    const pipeline = createTriggerPipeline({ assemble, uploadPipeline });

    const t1 = pipeline.report(request('one'));
    const t2 = pipeline.report(request('two'));
    expect(assemble).toHaveBeenCalledTimes(1); // second is queued, not yet assembling

    d1.resolve(bundle('one.zip'));
    await t1;
    await vi.waitFor(() => expect(assemble).toHaveBeenCalledTimes(2)); // second now assembling

    d2.resolve(bundle('two.zip'));
    expect((await t2).ok).toBe(true);
  });

  it('drops requests beyond the queue depth', async () => {
    const { uploadPipeline } = fakeUpload();
    const gate = createDeferred<Bundle>();
    const assemble = vi.fn(() => gate.promise); // first stays in-flight
    const pipeline = createTriggerPipeline({ assemble, uploadPipeline, maxQueueDepth: 2 });

    pipeline.report(request('1')); // in-flight
    pipeline.report(request('2')); // queued (depth 1)
    pipeline.report(request('3')); // queued (depth 2)
    const dropped = await pipeline.report(request('4')); // queue full -> dropped
    expect(dropped.ok).toBe(false);
    expect(dropped.error?.message).toMatch(/queue overflow/);

    gate.resolve(bundle());
  });

  it('processes queued requests in FIFO order after the current one', async () => {
    const { uploadPipeline } = fakeUpload();
    const order: string[] = [];
    const gates = new Map<string, ReturnType<typeof createDeferred<Bundle>>>();
    const assemble = vi.fn((r: ReportingRequest) => {
      order.push(r.id);
      const d = createDeferred<Bundle>();
      gates.set(r.id, d);
      return d.promise;
    });
    const pipeline = createTriggerPipeline({ assemble, uploadPipeline });

    const t1 = pipeline.report(request('a'));
    pipeline.report(request('b'));
    pipeline.report(request('c'));
    expect(order).toEqual(['a']); // only the first is assembling

    gates.get('a')?.resolve(bundle());
    await t1;
    await vi.waitFor(() => expect(order).toEqual(['a', 'b']));
    gates.get('b')?.resolve(bundle());
    await vi.waitFor(() => expect(order).toEqual(['a', 'b', 'c']));
    gates.get('c')?.resolve(bundle());
  });

  it('returns a failed result when assembly throws, without stalling the queue', async () => {
    const { uploadPipeline, enqueue } = fakeUpload();
    const assemble = vi
      .fn<(r: ReportingRequest) => Promise<Bundle>>()
      .mockRejectedValueOnce(new Error('assembly boom'))
      .mockResolvedValueOnce(bundle('next.zip'));
    const pipeline = createTriggerPipeline({ assemble, uploadPipeline });

    const t1 = pipeline.report(request('fails'));
    const t2 = pipeline.report(request('ok'));
    const r1 = await t1;
    expect(r1.ok).toBe(false);
    expect(r1.error?.message).toMatch(/assembly failed/);
    expect((await t2).ok).toBe(true); // queue advanced despite the first failing
    expect(enqueue).toHaveBeenCalledTimes(1); // only the successful assembly reached enqueue
  });

  it('preserves a BugseeError thrown by assembly', async () => {
    const { uploadPipeline } = fakeUpload();
    const boom = new BugseeError('custom', 99);
    const assemble = vi.fn<(r: ReportingRequest) => Promise<Bundle>>().mockRejectedValueOnce(boom);
    const result = await createTriggerPipeline({ assemble, uploadPipeline }).report(request('x'));
    expect(result.error).toBe(boom);
  });

  it('starts a fresh assembly (not queued) once the queue has drained', async () => {
    const { uploadPipeline } = fakeUpload();
    const assemble = vi.fn(async () => bundle());
    const pipeline = createTriggerPipeline({ assemble, uploadPipeline });
    await pipeline.report(request('first'));
    await pipeline.report(request('second'));
    expect(assemble).toHaveBeenCalledTimes(2);
  });
});
