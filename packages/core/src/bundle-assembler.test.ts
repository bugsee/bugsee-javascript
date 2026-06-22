import type { EnvironmentEnvelope, FileType } from '@bugsee/protocol';
import { strFromU8, unzipSync } from '@bugsee/util';
import { describe, expect, it } from 'vitest';
import { assembleBundle, type BundleAssemblyContext } from './bundle-assembler';
import { CaptureDataEntryBase } from './capture-data-entry';
import type { CaptureDataEntry } from './contracts';
import { createReportingRequest } from './reporting';

const env: EnvironmentEnvelope = {
  platform: { type: 'web', version: '124' },
  sdk: { version: '1.0.0', type: 'javascript' },
};

const context = (over: Partial<BundleAssemblyContext> = {}): BundleAssemblyContext => ({
  appToken: 'tok_123',
  environment: env,
  attributes: {},
  clock: { wallNow: () => 1_700_000_000_000, monotonicNow: () => 0 },
  fileName: () => 'fixed.bundle.zip',
  ...over,
});

const entry = (type: FileType, timestamp: number, data: unknown): CaptureDataEntry =>
  new CaptureDataEntryBase(type, timestamp, data);

// Parse the request.json / manifest.json out of an assembled bundle zip.
function unzip(body: Uint8Array) {
  const files = unzipSync(body);
  const text = (name: string) => strFromU8(files[name] as Uint8Array);
  return {
    names: Object.keys(files),
    request: JSON.parse(text('request.json')),
    manifest: JSON.parse(text('manifest.json')),
    apptoken: text('apptoken'),
    text,
  };
}

describe('assembleBundle — request.json', () => {
  it('builds request.json from the report, source mechanism and environment', () => {
    const request = createReportingRequest({
      source: { type: 'crash', mechanism: 'uncaught', origin: 'window.onerror' },
      id: 'r1',
      summary: 'Boom',
      description: 'stack...',
      email: 'a@b.c',
      labels: ['p1'],
      signatures: ['sig'],
    });
    const bundle = assembleBundle(request, new Map(), context());
    expect(bundle.request).toEqual({
      type: 'crash',
      summary: 'Boom',
      severity: 5, // 'blocker' -> 5
      source: { mechanism: 'uncaught', origin: 'window.onerror' },
      created_on: '2023-11-14T22:13:20.000Z',
      environment: env,
      description: 'stack...',
      labels: ['p1'],
      email: 'a@b.c',
      signatures: ['sig'],
    });
  });

  it('defaults the summary from the issue type when absent', () => {
    const crash = createReportingRequest({ source: { type: 'crash' }, id: 'r1' });
    expect(assembleBundle(crash, new Map(), context()).request.summary).toBe('Crash');
    // error-class triggers (error/assert) -> issue type 'error'
    const error = createReportingRequest({ source: { type: 'error' }, id: 'r2' });
    expect(assembleBundle(error, new Map(), context()).request.summary).toBe('Error');
    // everything else -> issue type 'bug'
    const bug = createReportingRequest({ source: { type: 'code_upload' }, id: 'r3' });
    expect(assembleBundle(bug, new Map(), context()).request.summary).toBe('Bug Report');
  });

  it('defaults source.mechanism to programmatic when the source has none', () => {
    const request = createReportingRequest({ source: { type: 'shake' }, id: 'r1' });
    expect(assembleBundle(request, new Map(), context()).request.source).toEqual({
      mechanism: 'programmatic',
    });
  });

  it('omits empty labels/signatures and absent description/email/origin', () => {
    const request = createReportingRequest({ source: { type: 'code_upload' }, id: 'r1' });
    const json = assembleBundle(request, new Map(), context()).request;
    expect('labels' in json).toBe(false);
    expect('signatures' in json).toBe(false);
    expect('description' in json).toBe(false);
    expect('email' in json).toBe(false);
    expect('origin' in json.source).toBe(false);
  });

  it('takes email from the global userIdentifier when the report has none (Android parity)', () => {
    const request = createReportingRequest({ source: { type: 'error' }, id: 'r1' });
    const json = assembleBundle(request, new Map(), context({ userIdentifier: 'alice' })).request;
    expect(json.email).toBe('alice');
  });

  it('lets a per-report email override the global userIdentifier', () => {
    const request = createReportingRequest({
      source: { type: 'error' },
      id: 'r1',
      email: 'rep@x.c',
    });
    const json = assembleBundle(request, new Map(), context({ userIdentifier: 'alice' })).request;
    expect(json.email).toBe('rep@x.c');
  });

  it('omits email when the userIdentifier is null or empty', () => {
    const request = createReportingRequest({ source: { type: 'error' }, id: 'r1' });
    expect(
      'email' in assembleBundle(request, new Map(), context({ userIdentifier: null })).request,
    ).toBe(false);
    expect(
      'email' in assembleBundle(request, new Map(), context({ userIdentifier: '' })).request,
    ).toBe(false);
  });

  it('embeds request.json verbatim in the zip', () => {
    const request = createReportingRequest({ source: { type: 'crash' }, id: 'r1' });
    const bundle = assembleBundle(request, new Map(), context());
    expect(unzip(bundle.body).request).toEqual(bundle.request);
  });
});

describe('assembleBundle — manifest.json & files', () => {
  const request = () => createReportingRequest({ source: { type: 'error' }, id: 'r1' });

  it('writes the root files (request.json, manifest.json, apptoken)', () => {
    const out = unzip(assembleBundle(request(), new Map(), context()).body);
    expect(out.names.sort()).toEqual(['apptoken', 'manifest.json', 'request.json']);
    expect(out.apptoken).toBe('tok_123');
  });

  it('builds the manifest with version, attrs and a file inventory per captured type', () => {
    const captured = new Map<FileType, CaptureDataEntry[]>([
      ['network', [entry('network', 100, { url: 'u' })]],
      ['log', [entry('log', 50, { message: 'hi' })]],
    ]);
    const out = unzip(
      assembleBundle(request(), captured, context({ attributes: { plan: 'pro' } })).body,
    );
    expect(out.manifest.version).toBe(2);
    expect(out.manifest.attrs).toEqual({ plan: 'pro' });
    expect(out.manifest.files).toEqual(
      expect.arrayContaining([
        { filename: 'network.json', type: 'network' },
        { filename: 'logs.json', type: 'log' },
      ]),
    );
  });

  it('serializes each captured file type to its default filename as a JSON array of payloads', () => {
    const captured = new Map<FileType, CaptureDataEntry[]>([
      ['network', [entry('network', 1, { url: 'a' }), entry('network', 2, { url: 'b' })]],
    ]);
    const out = unzip(assembleBundle(request(), captured, context()).body);
    expect(out.names).toContain('network.json');
    expect(JSON.parse(out.text('network.json'))).toEqual([{ url: 'a' }, { url: 'b' }]);
  });

  it('wraps the performance file type as { transactions: [...] } (§8.8), not a bare array', () => {
    const captured = new Map<FileType, CaptureDataEntry[]>([
      [
        'performance',
        [
          entry('performance', 1, { traceId: 't1', name: 'a' }),
          entry('performance', 2, { traceId: 't2', name: 'b' }),
        ],
      ],
      ['network', [entry('network', 3, { url: 'u' })]],
    ]);
    const out = unzip(assembleBundle(request(), captured, context()).body);
    expect(JSON.parse(out.text('performance.json'))).toEqual({
      transactions: [
        { traceId: 't1', name: 'a' },
        { traceId: 't2', name: 'b' },
      ],
    });
    // Only `performance` is object-wrapped; the other file types stay bare arrays.
    expect(JSON.parse(out.text('network.json'))).toEqual([{ url: 'u' }]);
  });

  it('serializes the profile file type as the single bare V8 CPU profile object (not an array)', () => {
    const cpuProfile = {
      nodes: [{ id: 1 }],
      startTime: 10,
      endTime: 70,
      samples: [1],
      timeDeltas: [0],
    };
    const captured = new Map<FileType, CaptureDataEntry[]>([
      ['profile', [entry('profile', 5, cpuProfile)]],
      ['network', [entry('network', 6, { url: 'u' })]],
    ]);
    const out = unzip(assembleBundle(request(), captured, context()).body);
    // profile.json is the bare .cpuprofile object …
    expect(JSON.parse(out.text('profile.json'))).toEqual(cpuProfile);
    // … while other file types stay bare arrays.
    expect(JSON.parse(out.text('network.json'))).toEqual([{ url: 'u' }]);
  });

  it('sets time.start to the earliest entry timestamp and time.end to now', () => {
    const captured = new Map<FileType, CaptureDataEntry[]>([
      ['log', [entry('log', 1_699_999_999_000, {}), entry('log', 1_700_000_000_000, {})]],
    ]);
    const out = unzip(assembleBundle(request(), captured, context()).body);
    expect(out.manifest.time).toEqual({ start: 1_699_999_999_000, end: 1_700_000_000_000 });
  });

  it('uses now for both time bounds and an empty file inventory when nothing was captured', () => {
    const out = unzip(assembleBundle(request(), new Map(), context()).body);
    expect(out.manifest.time).toEqual({ start: 1_700_000_000_000, end: 1_700_000_000_000 });
    expect(out.manifest.files).toEqual([]);
  });

  it('names an attachment-typed file after the type (no default filename for attachments)', () => {
    const captured = new Map<FileType, CaptureDataEntry[]>([
      ['attachment', [entry('attachment', 1, { note: 'x' })]],
    ]);
    const out = unzip(assembleBundle(request(), captured, context()).body);
    expect(out.manifest.files).toContainEqual({ filename: 'attachment', type: 'attachment' });
  });
});

describe('assembleBundle — file name', () => {
  it('uses the injected file name', () => {
    const request = createReportingRequest({ source: { type: 'crash' }, id: 'r1' });
    expect(assembleBundle(request, new Map(), context()).fileName).toBe('fixed.bundle.zip');
  });

  it('defaults to a random <20 chars>.bundle.zip name', () => {
    const request = createReportingRequest({ source: { type: 'crash' }, id: 'r1' });
    const bundle = assembleBundle(request, new Map(), context({ fileName: undefined }));
    expect(bundle.fileName).toMatch(/^[a-z0-9]{20}\.bundle\.zip$/);
  });
});

describe('assembleBundle — request context merge (framework adapters)', () => {
  const errReq = (over = {}) =>
    createReportingRequest({
      source: { type: 'error', mechanism: 'programmatic' },
      id: 'r1',
      ...over,
    });

  it('emits context_id and prefers the request-context user + attributes over the global ones', () => {
    const bundle = assembleBundle(
      errReq(),
      new Map(),
      context({
        userIdentifier: 'global@x.com',
        attributes: { app: 'a', shared: 'global' },
        requestContext: {
          contextId: 'ctx-1',
          user: 'req@x.com',
          attributes: { route: '/checkout', shared: 'req' },
        },
      }),
    );
    expect(bundle.request.context_id).toBe('ctx-1');
    expect(bundle.request.email).toBe('req@x.com'); // request-context user wins over the global user
    expect(unzip(bundle.body).manifest.attrs).toEqual({
      app: 'a',
      shared: 'req',
      route: '/checkout',
    });
  });

  it('falls back to the global user/attributes when the request context omits them', () => {
    const bundle = assembleBundle(
      errReq(),
      new Map(),
      context({
        userIdentifier: 'global@x.com',
        attributes: { app: 'a' },
        requestContext: { contextId: 'ctx-1' },
      }),
    );
    expect(bundle.request.context_id).toBe('ctx-1');
    expect(bundle.request.email).toBe('global@x.com');
    expect(unzip(bundle.body).manifest.attrs).toEqual({ app: 'a' });
  });

  it('treats an empty request-context user as absent — falls back to the global user', () => {
    const bundle = assembleBundle(
      errReq(),
      new Map(),
      context({ userIdentifier: 'global@x.com', requestContext: { contextId: 'ctx-1', user: '' } }),
    );
    expect(bundle.request.email).toBe('global@x.com');
  });

  it('carries the active trace_id + span_id on the report (the cross-project join key, T8)', () => {
    const bundle = assembleBundle(
      errReq(),
      new Map(),
      context({
        requestContext: {
          contextId: 'ctx-1',
          trace: { traceId: 't1', spanId: 's1', sampled: true },
        },
      }),
    );
    expect(bundle.request.context_id).toBe('ctx-1');
    expect(bundle.request.trace_id).toBe('t1'); // the cross-project join key
    expect(bundle.request.span_id).toBe('s1');
  });

  it('omits trace_id/span_id when the context has no active trace', () => {
    const bundle = assembleBundle(
      errReq(),
      new Map(),
      context({ requestContext: { contextId: 'ctx-1' } }),
    );
    expect(bundle.request.context_id).toBe('ctx-1');
    expect('trace_id' in bundle.request).toBe(false);
    expect('span_id' in bundle.request).toBe(false);
  });

  it('an explicit report email still wins over the request-context user', () => {
    const bundle = assembleBundle(
      errReq({ email: 'report@x.com' }),
      new Map(),
      context({
        userIdentifier: 'global@x.com',
        requestContext: { contextId: 'ctx-1', user: 'req@x.com' },
      }),
    );
    expect(bundle.request.email).toBe('report@x.com');
  });

  it('omits context_id and stays global when no request context is present', () => {
    const bundle = assembleBundle(
      errReq(),
      new Map(),
      context({ userIdentifier: 'global@x.com', attributes: { app: 'a' } }),
    );
    expect(bundle.request.context_id).toBeUndefined();
    expect(bundle.request.email).toBe('global@x.com');
    expect(unzip(bundle.body).manifest.attrs).toEqual({ app: 'a' });
  });
});
