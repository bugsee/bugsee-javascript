import { describe, expect, it } from 'vitest';
import {
  type ConsumedSpan,
  consumedRootToTransaction,
  consumedSpanToSpanWire,
  fromOtlpStatus,
} from './from-otlp';

describe('fromOtlpStatus', () => {
  it('maps OTel status codes to Bugsee SpanStatus (inverse of the produce mapping)', () => {
    expect(fromOtlpStatus({ code: 1 })).toBe('OK'); // OK
    expect(fromOtlpStatus({ code: 0 })).toBe('UNKNOWN'); // UNSET
    expect(fromOtlpStatus({ code: 2 })).toBe('ERROR'); // ERROR, no message
  });
  it('round-trips a specific error status carried in the OTel status message', () => {
    expect(fromOtlpStatus({ code: 2, message: 'TIMEOUT' })).toBe('TIMEOUT');
    expect(fromOtlpStatus({ code: 2, message: 'DEADLINE_EXCEEDED' })).toBe('DEADLINE_EXCEEDED');
    expect(fromOtlpStatus({ code: 2, message: 'CANCELLED' })).toBe('CANCELLED');
  });
  it('falls back to ERROR for an unrecognised error message, and UNKNOWN for an unknown code', () => {
    expect(fromOtlpStatus({ code: 2, message: 'boom' })).toBe('ERROR');
    expect(fromOtlpStatus({ code: 99 })).toBe('UNKNOWN');
  });
});

const span = (over: Partial<ConsumedSpan> = {}): ConsumedSpan => ({
  traceId: '0123456789abcdef0123456789abcdef',
  spanId: 'aaaaaaaaaaaaaaaa',
  parentSpanId: 'bbbbbbbbbbbbbbbb',
  name: 'HTTP GET /api',
  kind: 3, // CLIENT
  startTimeMs: 1000,
  endTimeMs: 1080,
  status: { code: 2, message: 'TIMEOUT' },
  attributes: { 'http.method': 'GET' },
  ...over,
});

describe('consumedSpanToSpanWire', () => {
  it('maps a consumed OTel span to a Bugsee SpanWire (name→operation, kind→attribute, status, duration)', () => {
    expect(consumedSpanToSpanWire(span())).toEqual({
      spanId: 'aaaaaaaaaaaaaaaa',
      parentSpanId: 'bbbbbbbbbbbbbbbb',
      operation: 'HTTP GET /api',
      status: 'TIMEOUT',
      startTimestampMs: 1000,
      endTimestampMs: 1080,
      durationNanos: 80_000_000, // (1080 - 1000) * 1e6
      attributes: { 'http.method': 'GET', 'otel.span.kind': 3 },
    });
  });

  it('omits parentSpanId for a root-less span and omits attributes when there are none', () => {
    const wire = consumedSpanToSpanWire(
      span({ parentSpanId: undefined, kind: undefined, attributes: undefined }),
    );
    expect(wire.parentSpanId).toBeUndefined();
    expect(wire.attributes).toBeUndefined();
    expect(Object.keys(wire).sort()).toEqual([
      'durationNanos',
      'endTimestampMs',
      'operation',
      'spanId',
      'startTimestampMs',
      'status',
    ]);
  });

  it('clamps a negative duration to 0', () => {
    expect(consumedSpanToSpanWire(span({ startTimeMs: 1080, endTimeMs: 1000 })).durationNanos).toBe(
      0,
    );
  });
});

describe('consumedRootToTransaction', () => {
  it('builds a TransactionWire from the root consumed span and the assembled child spans', () => {
    const children = [consumedSpanToSpanWire(span())];
    expect(
      consumedRootToTransaction(
        span({
          spanId: 'cccccccccccccccc',
          parentSpanId: undefined,
          name: 'GET /checkout',
          kind: 2, // SERVER
          status: { code: 1 }, // OK
          startTimeMs: 990,
          endTimeMs: 1100,
          attributes: undefined,
        }),
        children,
      ),
    ).toEqual({
      traceId: '0123456789abcdef0123456789abcdef',
      name: 'GET /checkout',
      operation: 'GET /checkout',
      status: 'OK',
      startTimestampMs: 990,
      endTimestampMs: 1100,
      durationNanos: 110_000_000,
      isSnapshot: false,
      attributes: { 'otel.span.kind': 2 },
      spans: children,
    });
  });

  it('omits attributes when the root has neither kind nor attributes', () => {
    const txn = consumedRootToTransaction(
      span({ parentSpanId: undefined, kind: undefined, attributes: undefined }),
      [],
    );
    expect(txn.attributes).toBeUndefined();
    expect(txn.spans).toEqual([]);
  });
});
