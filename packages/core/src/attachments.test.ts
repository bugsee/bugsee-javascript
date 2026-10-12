import { describe, expect, it, vi } from 'vitest';
import {
  addReportAttachment,
  decodeRequestFromMarker,
  encodeRequestForMarker,
  limitAttachmentsForMarker,
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

  it('carries an SDK-internal binary attachment (a native-crash .dmp) across the JSON hop, with no user attachments', () => {
    const dmp = new Uint8Array([77, 68, 77, 80, 0, 255]);
    const request = createReportingRequest({
      source: { type: 'crash' },
      attachments: [
        { name: 'crash.dmp', data: dmp },
        { name: 'note.txt', data: 'text' },
      ],
    });
    const wire = JSON.stringify(encodeRequestForMarker(request));
    expect(wire).not.toContain('"0":77');
    const onError = vi.fn();
    const back = decodeRequestFromMarker(JSON.parse(wire), onError);
    expect(back.report.attachments?.[0]).toEqual({ name: 'crash.dmp', data: dmp });
    expect(back.report.attachments?.[1]).toEqual({ name: 'note.txt', data: 'text' });
    expect(onError).not.toHaveBeenCalled();
  });

  it('decoding survives hostile lists: a non-list, null / primitive elements are dropped, the rest kept', () => {
    const onError = vi.fn();
    const request = {
      source: { type: 'crash' },
      report: {
        userAttachments: [null, 7, { name: 'ok', data: 'x' }],
        attachments: 'nope',
      },
    } as never;
    const back = decodeRequestFromMarker(request, onError);
    expect(back.report.userAttachments).toEqual([{ name: 'ok', data: 'x' }]);
    expect(back.report.attachments).toEqual([]);
    expect(onError).toHaveBeenCalledTimes(3);
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

describe('a throwing sink never loses the attachments or the report (R2P-6)', () => {
  const boom = (): never => {
    throw new Error('the app\u2019s onError is broken');
  };

  it('resolveUserAttachments keeps the good ones whatever is wrong with the rest', () => {
    const out = resolveUserAttachments(
      [
        { name: 'ok', data: 'fine' },
        { name: '', data: 'x' },
        'junk',
        { name: 'big', data: new Uint8Array(MAX_USER_ATTACHMENT_BYTES + 1) },
        { name: 'empty', data: '' },
        { name: 'm', data: 'x', mimeType: 7, fileName: 8 },
        { name: 'over', data: 'cap' },
        { name: 'over2', data: 'cap' },
      ] as never,
      boom,
      fixedName,
    );
    expect(out.map((a) => a.name)).toEqual(['ok', 'm', 'over']);
  });

  it('a hostile getter plus a throwing sink still yields the others', () => {
    const hostile = {
      get name(): string {
        throw new Error('getter');
      },
    };
    const out = resolveUserAttachments(
      [hostile, { name: 'ok', data: 'x' }] as never,
      boom,
      fixedName,
    );
    expect(out.map((a) => a.name)).toEqual(['ok']);
  });

  it('a non-array value with a throwing sink returns no attachments instead of throwing', () => {
    expect(resolveUserAttachments('nope' as never, boom, fixedName)).toEqual([]);
  });
});

describe('marker hardening (R2P-9)', () => {
  const requestWith = (attachments: unknown) => {
    const request = createReportingRequest({ source: { type: 'code_upload' } });
    request.report.userAttachments = attachments as never;
    return request;
  };

  it('decode drops an attachment whose dataBase64 is not a string, and reports it', () => {
    for (const bad of [42, null, {}, true, ['AAAA']]) {
      const onError = vi.fn();
      const back = decodeRequestFromMarker(
        requestWith([
          { name: 'bad', data: '', dataBase64: bad },
          { name: 'ok', data: 'fine' },
        ]),
        onError,
      );
      expect(
        back.report.userAttachments?.map((a) => a.name),
        String(bad),
      ).toEqual(['ok']);
      expect(onError, String(bad)).toHaveBeenCalledTimes(1);
    }
  });

  it('limitAttachmentsForMarker applies the count and size limits to a COPY (frozen reports)', () => {
    const request = requestWith([
      { name: 'a', data: 'x' },
      { name: 'huge', data: new Uint8Array(MAX_USER_ATTACHMENT_BYTES + 1) },
      { name: 'b', data: 'y' },
      { name: 'c', data: 'z' },
      { name: 'd', data: 'w' },
    ]);
    Object.freeze(request.report);
    const limited = limitAttachmentsForMarker(request);
    expect(limited.report.userAttachments?.map((a) => a.name)).toEqual(['a', 'b', 'c']);
    expect(request.report.userAttachments).toHaveLength(5); // the original is untouched
    expect(limited).not.toBe(request);
  });

  it('limitAttachmentsForMarker returns the request itself when there are none, and drops a hostile list', () => {
    const none = createReportingRequest({ source: { type: 'code_upload' } });
    expect(limitAttachmentsForMarker(none)).toBe(none);
    const hostile = createReportingRequest({ source: { type: 'code_upload' } });
    Object.defineProperty(hostile.report, 'userAttachments', {
      enumerable: true,
      get() {
        throw new Error('getter');
      },
    });
    expect(limitAttachmentsForMarker(hostile).report.userAttachments ?? []).toEqual([]);
  });
});
