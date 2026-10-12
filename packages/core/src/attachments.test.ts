import { describe, expect, it, vi } from 'vitest';
import {
  addReportAttachment,
  decodeRequestFromMarker,
  encodeRequestForMarker,
  MAX_USER_ATTACHMENT_BYTES,
  MAX_USER_ATTACHMENTS,
  normalizeReportAttachments,
  resolveUserAttachments,
  sanitizeAttachmentFileName,
} from './attachments';
import { createReportingRequest } from './reporting';

const fixedName = (): string => 'rand';

describe('limits', () => {
  it('match iOS: 3 attachments of 3 MB', () => {
    expect(MAX_USER_ATTACHMENTS).toBe(3);
    expect(MAX_USER_ATTACHMENT_BYTES).toBe(3 * 1024 * 1024);
  });
});

describe('sanitizeAttachmentFileName', () => {
  it.each([
    ['report.txt', 'report.txt'],
    ['../../etc/passwd', 'passwd'],
    ['..\\..\\win\\system.ini', 'system.ini'],
    ['/abs/path/a.log', 'a.log'],
    ['a\u0000b\nc.txt', 'abc.txt'],
    ['..', 'attachment'],
    ['.', 'attachment'],
    ['', 'attachment'],
    ['dir/', 'attachment'],
    ['   ', 'attachment'],
  ])('%j -> %j', (input, expected) => {
    expect(sanitizeAttachmentFileName(input)).toBe(expected);
  });

  it('caps the length at 128 characters', () => {
    expect(sanitizeAttachmentFileName('a'.repeat(300))).toHaveLength(128);
  });
});

describe('resolveUserAttachments', () => {
  it('returns [] for undefined input', () => {
    expect(resolveUserAttachments(undefined, vi.fn(), fixedName)).toEqual([]);
  });

  it('resolves bytes and strings with defaults and a namespaced bundle file name', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const out = resolveUserAttachments(
      [
        { name: 'blob', data: bytes },
        { name: 'note', data: 'héllo', mimeType: 'text/markdown', fileName: 'n.md' },
        { name: 'text', data: 'x' },
      ],
      vi.fn(),
      (() => {
        let n = 0;
        return () => {
          n += 1;
          return `r${n}`;
        };
      })(),
    );
    expect(out).toEqual([
      {
        bundleName: 'r1.attachment.bgsfile',
        name: 'blob',
        mimeType: 'application/octet-stream',
        fileName: 'blob',
        data: bytes,
      },
      {
        bundleName: 'r2.attachment.bgsfile',
        name: 'note',
        mimeType: 'text/markdown',
        fileName: 'n.md',
        data: 'héllo',
      },
      {
        bundleName: 'r3.attachment.bgsfile',
        name: 'text',
        mimeType: 'text/plain',
        fileName: 'text',
        data: 'x',
      },
    ]);
  });

  it('sanitizes a traversal fileName and derives it from the name when absent', () => {
    const [a, b] = resolveUserAttachments(
      [
        { name: 'a', data: 'x', fileName: '../../evil.sh' },
        { name: '../b.txt', data: 'x' },
      ],
      vi.fn(),
      fixedName,
    );
    expect(a?.fileName).toBe('evil.sh');
    expect(b?.fileName).toBe('b.txt');
    expect(a?.bundleName).not.toContain('/');
  });

  it('drops attachments past the third and reports each', () => {
    const onError = vi.fn();
    const inputs = [1, 2, 3, 4, 5].map((n) => ({ name: `f${n}`, data: 'x' }));
    const out = resolveUserAttachments(inputs, onError, fixedName);
    expect(out.map((a) => a.name)).toEqual(['f1', 'f2', 'f3']);
    expect(onError).toHaveBeenCalledTimes(2);
    expect((onError.mock.calls[0]?.[0] as Error).message).toMatch(/f4/);
    expect((onError.mock.calls[0]?.[0] as Error).message).toMatch(/at most 3/);
  });

  it('drops an oversize attachment (bytes and utf-8 strings) without counting it against the budget', () => {
    const onError = vi.fn();
    const out = resolveUserAttachments(
      [
        { name: 'big', data: new Uint8Array(MAX_USER_ATTACHMENT_BYTES + 1) },
        { name: 'bigstr', data: '€'.repeat(MAX_USER_ATTACHMENT_BYTES / 3 + 1) },
        { name: 'exact', data: new Uint8Array(MAX_USER_ATTACHMENT_BYTES) },
        { name: 'ok', data: 'x' },
      ],
      onError,
      fixedName,
    );
    expect(out.map((a) => a.name)).toEqual(['exact', 'ok']);
    expect(onError).toHaveBeenCalledTimes(2);
    expect((onError.mock.calls[0]?.[0] as Error).message).toMatch(/big.*3 MB/);
  });

  it('drops malformed entries and reports them', () => {
    const onError = vi.fn();
    const bad = [
      null,
      'str',
      { name: '', data: 'x' },
      { name: 5, data: 'x' },
      { name: 'nodata' },
      { name: 'num', data: 42 },
    ] as never;
    expect(resolveUserAttachments(bad, onError, fixedName)).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(6);
  });

  it('reports a non-array input and attaches nothing', () => {
    const onError = vi.fn();
    expect(resolveUserAttachments('nope' as never, onError, fixedName)).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('uses a random 20-char default bundle name per attachment', () => {
    const [a, b] = resolveUserAttachments(
      [
        { name: 'a', data: 'x' },
        { name: 'b', data: 'x' },
      ],
      vi.fn(),
    );
    expect(a?.bundleName).toMatch(/^[a-z0-9]{20}\.attachment\.bgsfile$/);
    expect(a?.bundleName).not.toBe(b?.bundleName);
  });

  it('never lets two attachments share a bundle name even if the generator repeats', () => {
    const out = resolveUserAttachments(
      [
        { name: 'a', data: 'x' },
        { name: 'b', data: 'x' },
      ],
      vi.fn(),
      fixedName,
    );
    expect(new Set(out.map((a) => a.bundleName)).size).toBe(2);
  });
});

describe('addReportAttachment', () => {
  it('appends to the report without replacing earlier ones', () => {
    const { report } = createReportingRequest({ source: { type: 'code_upload' } });
    addReportAttachment(report, { name: 'a', data: 'x' });
    addReportAttachment(report, { name: 'b', data: 'y' });
    expect(report.userAttachments?.map((a) => a.name)).toEqual(['a', 'b']);
  });
});

describe('resolveUserAttachments hardening (P2, P9)', () => {
  it('drops a non-string fileName / mimeType, keeps the attachment, and reports each', () => {
    const onError = vi.fn();
    const out = resolveUserAttachments(
      [{ name: 'x', data: 'y', fileName: 42, mimeType: {} } as never],
      onError,
      fixedName,
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ name: 'x', fileName: 'x', mimeType: 'text/plain' });
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('never lets one hostile attachment lose the others (throwing getter)', () => {
    const onError = vi.fn();
    const hostile = {
      get name(): string {
        throw new Error('boom');
      },
      data: 'y',
    };
    const out = resolveUserAttachments(
      [hostile as never, { name: 'ok', data: 'z' }],
      onError,
      fixedName,
    );
    expect(out.map((a) => a.name)).toEqual(['ok']);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('reports an attachment that throws a non-Error as unreadable', () => {
    const onError = vi.fn();
    const hostile = {
      get name(): string {
        throw 'plain string';
      },
      data: 'y',
    };
    expect(resolveUserAttachments([hostile as never], onError, fixedName)).toEqual([]);
    expect(String(onError.mock.calls[0]?.[0])).toContain('unreadable');
  });

  it('names a hostile attachment (3rd+ getter call) as unreadable even when labelling it throws', () => {
    const onError = vi.fn();
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error('trap');
        },
      },
    );
    expect(resolveUserAttachments([hostile as never], onError, fixedName)).toEqual([]);
    expect(String(onError.mock.calls[0]?.[0])).toContain('(unreadable)');
  });

  it('drops empty data (iOS parity) and reports it', () => {
    const onError = vi.fn();
    const out = resolveUserAttachments(
      [
        { name: 'a', data: '' },
        { name: 'b', data: new Uint8Array(0) },
        { name: 'c', data: 'x' },
      ],
      onError,
      fixedName,
    );
    expect(out.map((a) => a.name)).toEqual(['c']);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('strips bidi override characters from the file name', () => {
    expect(sanitizeAttachmentFileName('a\u202Etxt.exe\u2066\u200F')).toBe('atxt.exe');
  });

  it('does not split a surrogate pair at the 128-character cut', () => {
    const name = `${'a'.repeat(127)}\u{1F600}`;
    const cut = sanitizeAttachmentFileName(name);
    expect(cut).toBe('a'.repeat(127));
  });
});

describe('normalizeReportAttachments + marker round trip (P1)', () => {
  const binary = new Uint8Array([0, 1, 2, 254, 255]);

  it('applies the limits to the report in place, once, at submit time', () => {
    const onError = vi.fn();
    const request = createReportingRequest({
      source: { type: 'code_upload' },
      userAttachments: [
        { name: 'a', data: 'x' },
        { name: 'b', data: 'y' },
        { name: 'c', data: 'z' },
        { name: 'd', data: 'w' },
      ],
    });
    normalizeReportAttachments(request.report, onError);
    expect(request.report.userAttachments?.map((a) => a.name)).toEqual(['a', 'b', 'c']);
    expect(request.report.userAttachments?.[0]).toEqual({
      name: 'a',
      data: 'x',
      mimeType: 'text/plain',
      fileName: 'a',
    });
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('leaves a report without attachments untouched', () => {
    const request = createReportingRequest({ source: { type: 'code_upload' } });
    normalizeReportAttachments(request.report, vi.fn());
    expect(request.report.userAttachments).toBeUndefined();
  });

  it('round-trips binary data through JSON as base64', () => {
    const request = createReportingRequest({
      source: { type: 'code_upload' },
      userAttachments: [
        { name: 'bin', data: binary, mimeType: 'application/x-test', fileName: 'b.bin' },
        { name: 'txt', data: 'héllo' },
      ],
    });
    normalizeReportAttachments(request.report, vi.fn());
    const wire = JSON.stringify(encodeRequestForMarker(request));
    expect(wire.length).toBeLessThan(600); // base64, not {"0":..} per byte
    const back = decodeRequestFromMarker(JSON.parse(wire), vi.fn());
    const [bin, txt] = back.report.userAttachments as { data: unknown }[];
    expect(bin?.data).toBeInstanceOf(Uint8Array);
    expect(Array.from(bin?.data as Uint8Array)).toEqual(Array.from(binary));
    expect(txt?.data).toBe('héllo');
    expect(back.report.userAttachments?.[0]).toMatchObject({
      name: 'bin',
      mimeType: 'application/x-test',
      fileName: 'b.bin',
    });
    // the live request is not mutated by encoding
    expect(request.report.userAttachments?.[0]?.data).toBeInstanceOf(Uint8Array);
  });

  it('passes a request with no user attachments through unchanged', () => {
    const request = createReportingRequest({ source: { type: 'code_upload' } });
    expect(encodeRequestForMarker(request)).toBe(request);
    expect(decodeRequestFromMarker(request, vi.fn())).toBe(request);
  });

  it('drops an attachment whose marker payload is corrupt, reports it, keeps the rest', () => {
    const onError = vi.fn();
    const request = createReportingRequest({ source: { type: 'code_upload' } });
    request.report.userAttachments = [
      { name: 'bad', data: '', dataBase64: '***not base64***' },
      { name: 'ok', data: 'fine' },
    ] as never;
    const back = decodeRequestFromMarker(request, onError);
    expect(back.report.userAttachments?.map((a) => a.name)).toEqual(['ok']);
    expect(onError).toHaveBeenCalledTimes(1);
  });
});
