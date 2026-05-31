import { describe, expect, it } from 'vitest';
import {
  boundedText,
  decodeUtf8,
  FORM_URLENCODED_TYPE,
  hasContentType,
  headerValueCI,
  readSyncRequestBody,
  TEXT_PLAIN_TYPE,
} from './network-body';

const TE = (
  globalThis as unknown as { TextEncoder: new () => { encode: (s: string) => Uint8Array } }
).TextEncoder;
const USP = (
  globalThis as unknown as { URLSearchParams: new (i: Record<string, string>) => object }
).URLSearchParams;

describe('readSyncRequestBody', () => {
  it('returns neither field for null/undefined', () => {
    expect(readSyncRequestBody(undefined)).toEqual({});
    expect(readSyncRequestBody(null)).toEqual({});
  });

  it('captures a string body verbatim with the implied text/plain Content-Type', () => {
    expect(readSyncRequestBody('hello')).toEqual({ body: 'hello', contentType: TEXT_PLAIN_TYPE });
    expect(TEXT_PLAIN_TYPE).toBe('text/plain;charset=UTF-8');
  });

  it('captures a URLSearchParams body serialized with the form-urlencoded Content-Type', () => {
    expect(readSyncRequestBody(new USP({ a: '1', b: '2' }))).toEqual({
      body: 'a=1&b=2',
      contentType: FORM_URLENCODED_TYPE,
    });
    expect(FORM_URLENCODED_TYPE).toBe('application/x-www-form-urlencoded;charset=UTF-8');
  });

  it('reports cant_read_data for a non-sync-readable body (typed array)', () => {
    const out = readSyncRequestBody(new Uint8Array([1, 2, 3]));
    expect(out.reason).toBe('cant_read_data');
    expect('body' in out).toBe(false);
    expect('contentType' in out).toBe(false);
  });
});

describe('boundedText', () => {
  it('keeps a body at or under the byte cap', () => {
    expect(boundedText('12345', 5)).toEqual({ body: '12345' });
  });

  it('drops an over-cap body (by character length fast-path) as size_too_large', () => {
    const out = boundedText('123456', 5);
    expect(out.reason).toBe('size_too_large');
    expect('body' in out).toBe(false);
  });

  it('measures UTF-8 bytes, not characters, near the cap', () => {
    // '€' is 1 char but 3 UTF-8 bytes → over a 2-byte cap (length fast-path does not trigger).
    expect(boundedText('€', 2).reason).toBe('size_too_large');
    expect(boundedText('€', 3)).toEqual({ body: '€' });
  });
});

describe('hasContentType', () => {
  it('detects a Content-Type header case-insensitively', () => {
    expect(hasContentType({ 'content-type': 'x' })).toBe(true);
    expect(hasContentType({ 'Content-Type': 'x' })).toBe(true);
    expect(hasContentType({ accept: 'x' })).toBe(false);
    expect(hasContentType({})).toBe(false);
  });
});

describe('headerValueCI', () => {
  it('finds a header value case-insensitively', () => {
    expect(headerValueCI({ 'Content-Length': '42' }, 'content-length')).toBe('42');
    expect(headerValueCI({ 'CoNtEnT-tYpE': 'json' }, 'content-type')).toBe('json');
  });

  it('returns undefined when the header is absent', () => {
    expect(headerValueCI({ accept: '*/*' }, 'content-length')).toBeUndefined();
  });
});

describe('decodeUtf8', () => {
  it('concatenates and decodes UTF-8 chunks', () => {
    expect(decodeUtf8([new TE().encode('ab'), new TE().encode('cd')])).toBe('abcd');
  });

  it('reassembles a multibyte sequence genuinely split across two chunks before decoding', () => {
    // '€' is 3 UTF-8 bytes (E2 82 AC); split across two chunks. decodeUtf8 concatenates into one
    // buffer before decoding, so the character is recovered (per-chunk decode would yield U+FFFD).
    const bytes = new TE().encode('€');
    expect(decodeUtf8([bytes.slice(0, 2), bytes.slice(2)])).toBe('€');
  });

  it('returns undefined when TextDecoder is unavailable', () => {
    const slot = globalThis as unknown as { TextDecoder?: unknown };
    const saved = slot.TextDecoder;
    slot.TextDecoder = undefined;
    try {
      expect(decodeUtf8([new TE().encode('hi')])).toBeUndefined();
    } finally {
      slot.TextDecoder = saved;
    }
  });
});
