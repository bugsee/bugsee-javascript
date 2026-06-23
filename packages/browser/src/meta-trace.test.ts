import { describe, expect, it, vi } from 'vitest';
import { type MetaTraceEnv, readMetaTraceContinuation } from './meta-trace';

// A fake document whose <meta name="traceparent"> content is controllable.
const docWith = (content: string | null): MetaTraceEnv => ({
  document: {
    querySelector: (selectors: string) =>
      selectors === 'meta[name="traceparent"]' ? { getAttribute: () => content } : null,
  },
});

const TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01';

describe('readMetaTraceContinuation', () => {
  it('reads <meta name="traceparent"> and continues it as a CHILD (trace id + parent span + sampled)', () => {
    expect(readMetaTraceContinuation(docWith(TRACEPARENT))).toEqual({
      traceId: '0af7651916cd43dd8448eb211c80319c',
      parentSpanId: 'b7ad6b7169203331',
      sampled: true,
    });
  });

  it('adopts the upstream UNSAMPLED decision (flags 00 → sampled false)', () => {
    const c = readMetaTraceContinuation(
      docWith('00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-00'),
    );
    expect(c?.sampled).toBe(false);
  });

  it('returns undefined when there is no document (SSR / worker)', () => {
    expect(readMetaTraceContinuation({ document: undefined })).toBeUndefined();
  });

  it('returns undefined when the meta tag is absent (a fresh root pageload trace)', () => {
    expect(readMetaTraceContinuation(docWith(null))).toBeUndefined();
  });

  it('returns undefined for an invalid traceparent value', () => {
    expect(readMetaTraceContinuation(docWith('not-a-traceparent'))).toBeUndefined();
  });

  it('never throws when querySelector is hostile (guarded → undefined)', () => {
    const env: MetaTraceEnv = {
      document: {
        querySelector: () => {
          throw new Error('hostile querySelector');
        },
      },
    };
    expect(() => readMetaTraceContinuation(env)).not.toThrow();
    expect(readMetaTraceContinuation(env)).toBeUndefined();
  });

  it('defaults to the global document when no env is given', () => {
    vi.stubGlobal('document', {
      querySelector: () => ({ getAttribute: () => TRACEPARENT }),
    });
    try {
      expect(readMetaTraceContinuation()?.traceId).toBe('0af7651916cd43dd8448eb211c80319c');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
