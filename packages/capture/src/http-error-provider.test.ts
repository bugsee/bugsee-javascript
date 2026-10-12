import {
  type Client,
  type Clock,
  createMultiKeyEmitter,
  hasDefaultSeverity,
  type MultiKeyEmitter,
  type ReportingRequest,
} from '@bugsee/core';
import { BugseeOption, type NetworkEvent, type NetworkStage } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createHttpErrorDetectionProvider } from './http-error-provider';
import type { NetworkSource } from './network-provider';

const mkSource = (): MultiKeyEmitter<Record<NetworkStage, NetworkEvent>> => createMultiKeyEmitter();
const netEvent = (over: Partial<NetworkEvent> = {}): NetworkEvent => ({
  timestamp: 1,
  id: 'n1',
  sequence: 'n1',
  mechanism: 'fetch',
  url: 'https://api.example.com/orders/list',
  method: 'GET',
  type: 'complete',
  status: 500,
  ...over,
});
const fixedClock = (monotonic = { now: 0 }): Clock => ({
  wallNow: () => 0,
  monotonicNow: () => monotonic.now,
});

const setup = (options?: Parameters<typeof createHttpErrorDetectionProvider>[1]) => {
  const source = mkSource();
  const provider = createHttpErrorDetectionProvider(source, options);
  const report = vi.fn<(request: ReportingRequest) => void>();
  provider.start({} as Client, report);
  return { source, provider, report };
};
const first = (report: ReturnType<typeof setup>['report']): ReportingRequest =>
  report.mock.calls[0]?.[0] as ReportingRequest;

describe('createHttpErrorDetectionProvider (Android BugseeDetectionHttpError parity)', () => {
  it('is named "http-error" and gated by the detectHttpErrors option', () => {
    const provider = createHttpErrorDetectionProvider(mkSource());
    expect(provider.name).toBe('http-error');
    expect(provider.controllingOption).toBe(BugseeOption.DetectHttpErrors);
  });

  it('reports a 5xx as an error report with mechanism http-error', () => {
    const { source, report } = setup();
    source.emit('complete', netEvent({ status: 503, statusText: 'Service Unavailable' }));
    expect(report).toHaveBeenCalledTimes(1);
    const request = first(report);
    expect(request.source).toEqual({ type: 'error', mechanism: 'http-error' });
    expect(request.report.type).toBe('error');
    expect(request.report.summary).toBe('HTTP 503 Service Unavailable');
  });

  it('uses the bare summary when there is no status text', () => {
    const { source, report } = setup();
    source.emit('complete', netEvent({ status: 500 }));
    expect(first(report).report.summary).toBe('HTTP 500');
    expect(first(report).report.attributes).not.toHaveProperty('http_status_text');
  });

  it('carries severity High EXPLICITLY (so reportDefaultErrorPriority cannot override it)', () => {
    const { source, report } = setup();
    source.emit('complete', netEvent());
    const request = first(report);
    expect(request.report.severity).toBe('high');
    expect(hasDefaultSeverity(request.report)).toBe(false);
  });

  it('puts status, method and the normalized URL in attributes, not in the text', () => {
    const { source, report } = setup();
    source.emit(
      'complete',
      netEvent({
        status: 502,
        statusText: 'Bad Gateway',
        method: 'POST',
        url: 'https://u:pw@api.example.com/users/42/orders?token=SECRET#x',
      }),
    );
    const { report: r } = first(report);
    expect(r.attributes).toEqual({
      http_status_code: 502,
      http_method: 'POST',
      http_url: 'https://api.example.com/users/{id}/orders',
      http_status_text: 'Bad Gateway',
    });
    expect(r.summary).toBe('HTTP 502 Bad Gateway');
    expect(r.description).toBe('');
    expect(JSON.stringify(r)).not.toContain('SECRET');
    expect(JSON.stringify(r)).not.toContain('pw@');
  });

  it('omits the method and URL attributes when the event has none', () => {
    const { source, report } = setup();
    source.emit(
      'complete',
      netEvent({ method: undefined as unknown as string, url: undefined as unknown as string }),
    );
    expect(first(report).report.attributes).toEqual({ http_status_code: 500 });
  });

  it('files the crash document under the HttpError::Server domain with an endpoint+status frame', () => {
    const { source, report } = setup();
    source.emit('complete', netEvent({ status: 500, url: 'https://a.test/users/42' }));
    const crash = first(report).report.crash;
    expect(crash).toMatchObject({
      exception_type: 'error',
      ndkCrash: false,
      handled: true,
      exception: { name: 'HttpError', reason: 'HTTP 500', domain: 'HttpError::Server' },
    });
    const frames = (crash as { exception: { frames: Array<{ trace: string; user: boolean }> } })
      .exception.frames;
    expect(frames).toHaveLength(1);
    expect(frames[0]?.trace).toBe('HttpError.GET https://a.test/users/{id} 500');
    expect(frames[0]?.user).toBe(false);
  });

  it('reports only 5xx: 4xx, 3xx, 2xx, 499 and 600 are ignored', () => {
    const { source, report } = setup();
    for (const status of [200, 301, 399, 400, 404, 429, 499, 600, 0]) {
      source.emit('complete', netEvent({ status }));
    }
    source.emit('complete', netEvent({ status: undefined }));
    expect(report).not.toHaveBeenCalled();
    source.emit('complete', netEvent({ status: 500 }));
    source.emit('complete', netEvent({ status: 599, url: 'https://x.test/a' }));
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('ignores transport failures (no HTTP status) and aborted requests', () => {
    const { source, report } = setup();
    source.emit('error', netEvent({ type: 'error', status: undefined, customError: 'boom' }));
    source.emit(
      'error',
      netEvent({ type: 'error', status: undefined, customError: 'AbortError: aborted' }),
    );
    source.emit('abort', netEvent({ type: 'abort', status: undefined }));
    source.emit('abort', netEvent({ type: 'abort', status: 500 }));
    expect(report).not.toHaveBeenCalled();
  });

  it('accepts a 5xx on the error stage too (Android accepts both completed and errored)', () => {
    const { source, report } = setup();
    source.emit('error', netEvent({ type: 'error', status: 500 }));
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('ignores before / redirect stages even when they carry a 5xx status', () => {
    const { source, report } = setup();
    source.emit('before', netEvent({ type: 'before', status: 500 }));
    source.emit('redirect', netEvent({ type: 'redirect', status: 500 }));
    expect(report).not.toHaveBeenCalled();
  });

  it('de-duplicates per session on (method, normalized URL, status)', () => {
    const { source, report } = setup();
    source.emit('complete', netEvent({ url: 'https://a.test/users/1' }));
    source.emit('complete', netEvent({ url: 'https://a.test/users/2' })); // same template
    source.emit('complete', netEvent({ url: 'https://a.test/users/3?x=1' })); // query ignored
    expect(report).toHaveBeenCalledTimes(1);
    source.emit('complete', netEvent({ url: 'https://a.test/users/1', status: 503 })); // other status
    source.emit('complete', netEvent({ url: 'https://a.test/users/1', method: 'POST' })); // other method
    source.emit('complete', netEvent({ url: 'https://a.test/other' })); // other endpoint
    expect(report).toHaveBeenCalledTimes(4);
  });

  it('the method is case-insensitive in the de-dup key and reported upper-case', () => {
    const { source, report } = setup();
    source.emit('complete', netEvent({ method: 'get' }));
    source.emit('complete', netEvent({ method: 'GET' }));
    source.emit('complete', netEvent({ method: 'Get' }));
    expect(report).toHaveBeenCalledTimes(1);
    const request = first(report);
    expect(request.report.attributes.http_method).toBe('GET');
    expect(
      (request.report.crash as { exception: { frames: Array<{ trace: string }> } }).exception
        .frames[0]?.trace,
    ).toBe('HttpError.GET https://api.example.com/orders/list 500');
  });

  it('a method-less event de-duplicates under the HTTP placeholder', () => {
    const { source, report } = setup();
    const e = netEvent({ method: undefined as unknown as string });
    source.emit('complete', e);
    source.emit('complete', e);
    expect(report).toHaveBeenCalledTimes(1);
    expect(
      (first(report).report.crash as { exception: { frames: Array<{ trace: string }> } }).exception
        .frames[0]?.trace,
    ).toBe('HttpError.HTTP https://api.example.com/orders/list 500');
  });

  it('forgets the de-dup set when stopped (a new session reports again)', () => {
    const { source, provider, report } = setup();
    source.emit('complete', netEvent());
    provider.stop();
    provider.start({} as Client, report);
    source.emit('complete', netEvent());
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('keeps a rate-limited failure reportable later (the de-dup slot is not consumed)', () => {
    const monotonic = { now: 0 };
    const { source, report } = setup({
      clock: fixedClock(monotonic),
      rateLimit: { limit: 1, windowMs: 1000 },
    });
    source.emit('complete', netEvent({ url: 'https://a.test/a' }));
    source.emit('complete', netEvent({ url: 'https://a.test/b' })); // dropped by the backstop
    expect(report).toHaveBeenCalledTimes(1);
    monotonic.now = 1001;
    source.emit('complete', netEvent({ url: 'https://a.test/b' }));
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('bounds the de-dup set: past the cap new endpoints are dropped, known ones stay quiet', () => {
    const { source, report } = setup({
      maxEndpoints: 2,
      rateLimit: { limit: 100, windowMs: 1000 },
    });
    source.emit('complete', netEvent({ url: 'https://a.test/a' }));
    source.emit('complete', netEvent({ url: 'https://a.test/b' }));
    source.emit('complete', netEvent({ url: 'https://a.test/c' }));
    source.emit('complete', netEvent({ url: 'https://a.test/a' }));
    expect(report).toHaveBeenCalledTimes(2);
  });

  it('is rate limited as a backstop, and the window reopens', () => {
    const monotonic = { now: 0 };
    const { source, report } = setup({
      clock: fixedClock(monotonic),
      rateLimit: { limit: 2, windowMs: 1000 },
    });
    for (let i = 0; i < 5; i++) {
      source.emit('complete', netEvent({ url: `https://a.test/e${i}x` }));
    }
    expect(report).toHaveBeenCalledTimes(2);
    monotonic.now = 1001;
    source.emit('complete', netEvent({ url: 'https://a.test/another' }));
    expect(report).toHaveBeenCalledTimes(3);
  });

  it('has a default budget on the system clock', () => {
    const { source, report } = setup();
    for (let i = 0; i < 200; i++) {
      source.emit('complete', netEvent({ url: `https://a.test/e${i}x` }));
    }
    expect(report.mock.calls.length).toBeGreaterThan(0);
    expect(report.mock.calls.length).toBeLessThan(200);
  });

  it('redacts a secret in the status text', () => {
    const { source, report } = setup();
    source.emit(
      'complete',
      netEvent({ statusText: 'failed at https://x.test/a?token=SECRET', status: 500 }),
    );
    expect(JSON.stringify(first(report).report)).not.toContain('SECRET');
  });

  it('strips a query string and credentials from the URL', () => {
    const { source, report } = setup();
    source.emit(
      'complete',
      netEvent({ url: 'https://user:p@ss@api.example.com/x?api_key=SECRET' }),
    );
    expect(first(report).report.attributes.http_url).toBe('https://api.example.com/x');
  });

  it.each(['fetch', 'xhr', 'http'] as const)('covers the %s mechanism', (mechanism) => {
    const { source, report } = setup();
    source.emit('complete', netEvent({ mechanism, status: 500 }));
    expect(report).toHaveBeenCalledTimes(1);
  });

  it.each([
    'ws',
    'sse',
    'webtransport',
    'sendBeacon',
  ] as const)('ignores the %s mechanism', (mechanism) => {
    const { source, report } = setup();
    source.emit('complete', netEvent({ mechanism, status: 500 }));
    source.emit('error', netEvent({ mechanism, type: 'error', status: 500 }));
    expect(report).not.toHaveBeenCalled();
  });

  it('stop releases the source subscription (so the interceptor can unpatch)', () => {
    const off = vi.fn();
    const source = {
      on: vi.fn(),
      once: vi.fn(),
      onAny: vi.fn(() => off),
    } as unknown as NetworkSource;
    const provider = createHttpErrorDetectionProvider(source);
    provider.start({} as Client, vi.fn());
    expect(source.onAny).toHaveBeenCalledTimes(1);
    expect(off).not.toHaveBeenCalled();
    provider.stop();
    expect(off).toHaveBeenCalledTimes(1);
  });

  it('stop unsubscribes from the source', () => {
    const { source, provider, report } = setup();
    provider.stop();
    source.emit('complete', netEvent({ status: 500 }));
    expect(report).not.toHaveBeenCalled();
  });

  it('never throws into the network path on a malformed event', () => {
    const { source, report } = setup();
    expect(() =>
      source.emit('complete', netEvent({ url: 42 as unknown as string, status: 500 })),
    ).not.toThrow();
    expect(report).toHaveBeenCalledTimes(1);
  });
});
