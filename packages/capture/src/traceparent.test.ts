import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OutgoingRequest } from './request-decorator';
import { createTraceparentDecorator, type TraceContextSource } from './traceparent';

const TID = '0123456789abcdef0123456789abcdef'; // 32 hex (16-byte trace id)
const SID = 'aaaaaaaaaaaaaaaa'; // 16 hex (8-byte span id)

const span = (over: Partial<TraceContextSource> = {}): TraceContextSource => ({
  getTraceId: () => TID,
  getSpanId: () => SID,
  isSampled: () => true,
  ...over,
});

const req = (url: string, headers: Record<string, string> = {}): OutgoingRequest => ({
  url,
  method: 'GET',
  headers,
});

afterEach(() => vi.unstubAllGlobals());

describe('createTraceparentDecorator', () => {
  it('injects a W3C traceparent on a same-origin request (00-traceId-spanId-flags)', () => {
    const d = createTraceparentDecorator({
      getActiveSpan: () => span(),
      origin: 'https://app.test',
    });
    expect(d(req('https://app.test/api/x'))).toEqual({ traceparent: `00-${TID}-${SID}-01` });
  });

  it('treats a relative URL as same-origin (resolved against the app origin)', () => {
    const d = createTraceparentDecorator({
      getActiveSpan: () => span(),
      origin: 'https://app.test',
    });
    expect(d(req('/api/x'))).toEqual({ traceparent: `00-${TID}-${SID}-01` });
  });

  it('does NOT propagate cross-origin by default (no trace-topology leak)', () => {
    const d = createTraceparentDecorator({
      getActiveSpan: () => span(),
      origin: 'https://app.test',
    });
    expect(d(req('https://third-party.test/x'))).toBeUndefined();
  });

  it('propagates cross-origin to a string-allowlisted host', () => {
    const d = createTraceparentDecorator({
      getActiveSpan: () => span(),
      origin: 'https://app.test',
      allowlist: ['api.internal.test'],
    });
    expect(d(req('https://api.internal.test/x'))).toEqual({ traceparent: `00-${TID}-${SID}-01` });
    expect(d(req('https://evil.test/x'))).toBeUndefined(); // not allowlisted
  });

  it('propagates cross-origin to a RegExp-allowlisted host', () => {
    const d = createTraceparentDecorator({
      getActiveSpan: () => span(),
      origin: 'https://app.test',
      allowlist: [/\.internal\.test\//], // matched against the FULL url string
    });
    expect(d(req('https://a.internal.test/x'))).toBeDefined();
    expect(d(req('https://a.public.test/x'))).toBeUndefined();
  });

  it('sets the sampled flag from the active transaction (unsampled → 00)', () => {
    const d = createTraceparentDecorator({
      getActiveSpan: () => span({ isSampled: () => false }),
      origin: 'https://app.test',
    });
    expect(d(req('https://app.test/x'))).toEqual({ traceparent: `00-${TID}-${SID}-00` });
  });

  it('defaults the flag to sampled (01) when the source has no isSampled()', () => {
    const d = createTraceparentDecorator({
      getActiveSpan: () => ({ getTraceId: () => TID, getSpanId: () => SID }),
      origin: 'https://app.test',
    });
    expect(d(req('https://app.test/x'))).toEqual({ traceparent: `00-${TID}-${SID}-01` });
  });

  it('emits nothing when there is no active trace', () => {
    const d = createTraceparentDecorator({
      getActiveSpan: () => undefined,
      origin: 'https://app.test',
    });
    expect(d(req('https://app.test/x'))).toBeUndefined();
  });

  it('does NOT override an existing traceparent (respects an upstream trace context)', () => {
    const d = createTraceparentDecorator({
      getActiveSpan: () => span(),
      origin: 'https://app.test',
    });
    expect(d(req('https://app.test/x', { TraceParent: 'existing' }))).toBeUndefined(); // case-insensitive
  });

  it('with no app origin (e.g. node), propagates ONLY to allowlisted URLs', () => {
    const sameOriginUnknown = createTraceparentDecorator({
      getActiveSpan: () => span(),
      origin: undefined,
      allowlist: ['svc.internal'],
    });
    expect(sameOriginUnknown(req('https://svc.internal/x'))).toBeDefined();
    expect(sameOriginUnknown(req('https://anything.else/x'))).toBeUndefined();
  });

  it('the default resolver treats a URL it cannot parse as cross-origin (the URL ctor throws)', () => {
    vi.stubGlobal(
      'URL',
      class {
        constructor() {
          throw new Error('parse failure');
        }
      },
    );
    // No injected resolveOrigin → the default uses the (now throwing) global URL.
    const d = createTraceparentDecorator({
      getActiveSpan: () => span(),
      origin: 'https://app.test',
    });
    expect(d(req('https://app.test/x'))).toBeUndefined(); // throws → not same-origin, not allowlisted
  });

  it('falls back to cross-origin when the global URL constructor is unavailable', () => {
    vi.stubGlobal('URL', undefined);
    const d = createTraceparentDecorator({
      getActiveSpan: () => span(),
      origin: 'https://app.test',
      allowlist: ['app.test'],
    });
    expect(d(req('https://app.test/x'))).toBeDefined(); // same-origin undeterminable → allowlist matches
    expect(d(req('https://other.test/x'))).toBeUndefined();
  });

  it('treats an unparseable URL as cross-origin (allowlist only)', () => {
    const calls: string[] = [];
    const d = createTraceparentDecorator({
      getActiveSpan: () => span(),
      origin: 'https://app.test',
      resolveOrigin: (url) => {
        calls.push(url);
        return undefined; // simulate a parse failure
      },
    });
    expect(d(req('::::bad'))).toBeUndefined(); // unparseable + not allowlisted → no propagation
    expect(calls).toContain('::::bad');
  });
});
