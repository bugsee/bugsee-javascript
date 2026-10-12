import {
  type Client,
  type Clock,
  createMultiKeyEmitter,
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
  url: 'https://api.example.com/orders/42',
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

describe('createHttpErrorDetectionProvider', () => {
  it('is named "http-error" and gated by the detectHttpErrors option', () => {
    const provider = createHttpErrorDetectionProvider(mkSource());
    expect(provider.name).toBe('http-error');
    expect(provider.controllingOption).toBe(BugseeOption.DetectHttpErrors);
  });

  it('reports a failed response (>= 400) as an error report with mechanism http-error', () => {
    const { source, report } = setup();
    source.emit('complete', netEvent({ status: 503, statusText: 'Service Unavailable' }));
    expect(report).toHaveBeenCalledTimes(1);
    const request = report.mock.calls[0]?.[0] as ReportingRequest;
    expect(request.source).toEqual({ type: 'error', mechanism: 'http-error' });
    expect(request.report.type).toBe('error');
    expect(request.report.summary).toBe('HTTP 503 GET https://api.example.com/orders/42');
    expect(request.report.description).toBe(
      'GET https://api.example.com/orders/42 -> 503 Service Unavailable',
    );
  });

  it('treats 400 as the first failing status and 399 as success', () => {
    const { source, report } = setup();
    source.emit('complete', netEvent({ status: 399 }));
    expect(report).not.toHaveBeenCalled();
    source.emit('complete', netEvent({ status: 400 }));
    expect(report).toHaveBeenCalledTimes(1);
  });

  it('ignores successful responses and a complete with no status', () => {
    const { source, report } = setup();
    source.emit('complete', netEvent({ status: 200 }));
    source.emit('complete', netEvent({ status: undefined }));
    expect(report).not.toHaveBeenCalled();
  });

  it('reports a network failure (error stage) with the redacted failure text', () => {
    const { source, report } = setup();
    source.emit(
      'error',
      netEvent({
        type: 'error',
        status: undefined,
        customError: 'TypeError: Failed to fetch https://api.example.com/orders/42?token=SECRET',
      }),
    );
    const request = report.mock.calls[0]?.[0] as ReportingRequest;
    expect(request.report.summary).toBe(
      'HTTP request failed: GET https://api.example.com/orders/42',
    );
    expect(request.report.description).not.toContain('SECRET');
    expect(request.report.description).toContain('Failed to fetch');
  });

  it('reports an error stage with no failure text using the bare summary', () => {
    const { source, report } = setup();
    source.emit('error', netEvent({ type: 'error', status: undefined, customError: undefined }));
    const request = report.mock.calls[0]?.[0] as ReportingRequest;
    expect(request.report.description).toBe('GET https://api.example.com/orders/42 failed');
  });

  it('keeps the query string and fragment (where secrets live) out of the summary and description', () => {
    const { source, report } = setup();
    source.emit(
      'complete',
      netEvent({ url: 'https://api.example.com/x?api_key=SECRET#frag', status: 404 }),
    );
    const request = report.mock.calls[0]?.[0] as ReportingRequest;
    expect(request.report.summary).toBe('HTTP 404 GET https://api.example.com/x');
    expect(JSON.stringify(request.report)).not.toContain('SECRET');
  });

  it('runs the path through the default URL redaction (a token-shaped path segment)', () => {
    const { source, report } = setup();
    source.emit(
      'complete',
      netEvent({
        url: 'https://a.test/confirm/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijk',
        status: 404,
      }),
    );
    const request = report.mock.calls[0]?.[0] as ReportingRequest;
    expect(request.report.summary).toBe('HTTP 404 GET https://a.test/confirm/<redacted>');
  });

  it('strips URL credentials, including a password containing an @', () => {
    const { source, report } = setup();
    source.emit('complete', netEvent({ url: 'https://user:p@ss@api.example.com/x', status: 401 }));
    const request = report.mock.calls[0]?.[0] as ReportingRequest;
    expect(request.report.summary).toBe('HTTP 401 GET https://api.example.com/x');
  });

  it('strips URL credentials', () => {
    const { source, report } = setup();
    source.emit(
      'complete',
      netEvent({ url: 'https://user:hunter2@api.example.com/x', status: 401 }),
    );
    expect(JSON.stringify(report.mock.calls[0]?.[0])).not.toContain('hunter2');
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
    source.emit('error', netEvent({ mechanism, type: 'error', status: undefined }));
    expect(report).not.toHaveBeenCalled();
  });

  it('ignores before / redirect / abort stages even when they carry a failing status', () => {
    const { source, report } = setup();
    source.emit('before', netEvent({ type: 'before', status: 500 }));
    source.emit('redirect', netEvent({ type: 'redirect', status: 500 }));
    source.emit('abort', netEvent({ type: 'abort', status: 500 }));
    expect(report).not.toHaveBeenCalled();
  });

  it('is rate limited: beyond the budget further failures are dropped, and the window reopens', () => {
    const monotonic = { now: 0 };
    const { source, report } = setup({
      clock: fixedClock(monotonic),
      rateLimit: { limit: 2, windowMs: 1000 },
    });
    for (let i = 0; i < 5; i++) {
      source.emit('complete', netEvent({ status: 500 }));
    }
    expect(report).toHaveBeenCalledTimes(2);
    monotonic.now = 1001;
    source.emit('complete', netEvent({ status: 500 }));
    expect(report).toHaveBeenCalledTimes(3);
  });

  it('has a default budget (not unbounded) on the system clock', () => {
    const { source, report } = setup();
    for (let i = 0; i < 200; i++) {
      source.emit('complete', netEvent({ status: 500 }));
    }
    expect(report.mock.calls.length).toBeGreaterThan(0);
    expect(report.mock.calls.length).toBeLessThan(200);
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
