import type { Interceptor } from '@bugsee/core';
import type { NetworkEvent, NetworkStage } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createFetchInterceptor, type FetchTarget } from './fetch-interceptor';

type FetchFn = (input: unknown, init?: unknown) => Promise<unknown>;
type Captured = { stage: NetworkStage; event: NetworkEvent };
type NetIc = Interceptor<Record<NetworkStage, NetworkEvent>>;

// A standalone fetch target (never touches the global): holds `current`, which the interceptor wraps
// on activate. `call` invokes whatever is currently installed (the wrapper once active).
function harness(impl: FetchFn) {
  let current: FetchFn = impl;
  const target: FetchTarget = {
    get: () => current,
    set: (fn) => {
      current = fn;
    },
  };
  return { target, call: (input: unknown, init?: unknown) => current(input, init), original: impl };
}

const okResponse = () => ({
  status: 200,
  statusText: 'OK',
  redirected: false,
  headers: {
    forEach: (cb: (v: string, k: string) => void) => cb('application/json', 'content-type'),
  },
});

// Subscribing (onAny) activates the interceptor (patches the target) and collects emitted events.
function collect(ic: NetIc): Captured[] {
  const events: Captured[] = [];
  ic.onAny((stage, event) => events.push({ stage, event }));
  return events;
}

describe('createFetchInterceptor — capture', () => {
  it('emits before then complete on a successful fetch (raw, unsanitized metadata)', async () => {
    const resp = okResponse();
    const { target, call } = harness(async () => resp);
    const ic = createFetchInterceptor({ now: () => 1000, newId: () => 'r1', target });
    const events = collect(ic);
    const result = await call('https://api/x', {
      method: 'post',
      headers: { authorization: 'secret' },
    });
    expect(result).toBe(resp); // response passed through unchanged
    expect(events.map((e) => e.stage)).toEqual(['before', 'complete']);
    expect(events[0]?.event).toMatchObject({
      id: 'r1',
      sequence: 'r1',
      mechanism: 'fetch',
      url: 'https://api/x',
      method: 'POST',
      type: 'before',
    });
    expect(events[0]?.event.custom?.headers).toEqual({ authorization: 'secret' }); // raw — not sanitized
    expect(events[1]?.event).toMatchObject({
      id: 'r1',
      type: 'complete',
      status: 200,
      statusText: 'OK',
      redirect: false,
    });
    expect(events[1]?.event.custom?.headers).toEqual({ 'content-type': 'application/json' });
    expect(events[1]?.event.custom?.timings?.duration).toBe(0); // fixed clock
  });

  it('emits before then error on a rejected fetch (and rethrows the error)', async () => {
    const { target, call } = harness(async () => {
      throw new Error('network down');
    });
    const ic = createFetchInterceptor({ now: () => 1, newId: () => 'r1', target });
    const events = collect(ic);
    await expect(call('https://api/x')).rejects.toThrow('network down');
    expect(events.map((e) => e.stage)).toEqual(['before', 'error']);
    expect(events[1]?.event).toMatchObject({ type: 'error', customError: 'network down' });
    expect(events[1]?.event.custom?.error).toBe('network down');
  });

  it('shares one id+sequence across a request and increments per request (default counter)', async () => {
    const { target, call } = harness(async () => okResponse());
    const ic = createFetchInterceptor({ now: () => 0, target });
    const events = collect(ic);
    await call('a');
    await call('b');
    expect(events.map((e) => e.event.id)).toEqual(['f1', 'f1', 'f2', 'f2']);
    expect(events[0]?.event.sequence).toBe('f1');
  });
});

describe('createFetchInterceptor — self-isolation', () => {
  it('skips the SDK own requests (X-Bugsee-Internal) but still calls through', async () => {
    const resp = okResponse();
    let called = 0;
    const { target, call } = harness(async () => {
      called += 1;
      return resp;
    });
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    const result = await call('https://api/x', { headers: { 'X-Bugsee-Internal': '1' } });
    expect(result).toBe(resp);
    expect(called).toBe(1);
    expect(events).toEqual([]);
  });

  it('honors a custom isInternal predicate', async () => {
    const { target, call } = harness(async () => okResponse());
    const ic = createFetchInterceptor({ target, isInternal: (url) => url.includes('/skip') });
    const events = collect(ic);
    await call('https://api/skip');
    await call('https://api/keep');
    expect(events.map((e) => e.event.url)).toEqual(['https://api/keep', 'https://api/keep']);
  });
});

describe('createFetchInterceptor — request shape extraction', () => {
  it('extracts url + method + array headers from a Request-like input', async () => {
    const { target, call } = harness(async () => okResponse());
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    await call({ url: 'https://r/path', method: 'put', headers: [['x-test', '1']] });
    expect(events[0]?.event.url).toBe('https://r/path');
    expect(events[0]?.event.method).toBe('PUT');
    expect(events[0]?.event.custom?.headers).toEqual({ 'x-test': '1' });
  });

  it('reads the url from a URL-like input (href) and defaults the method to GET', async () => {
    const { target, call } = harness(async () => okResponse());
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    await call({ href: 'https://u/' });
    expect(events[0]?.event.url).toBe('https://u/');
    expect(events[0]?.event.method).toBe('GET');
  });

  it('stringifies a non-string, non-Request input as the url', async () => {
    const { target, call } = harness(async () => okResponse());
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    await call(123 as unknown);
    expect(events[0]?.event.url).toBe('123');
  });
});

describe('createFetchInterceptor — request body', () => {
  const customOf = (events: Captured[]) => events[0]?.event.custom as Record<string, unknown>;

  it('captures a string request body on the before event (raw), keeping the user Content-Type', async () => {
    const { target, call } = harness(async () => okResponse());
    const ic = createFetchInterceptor({ target, newId: () => 'r1' });
    const events = collect(ic);
    await call('https://api/x', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"password":"hunter2"}',
    });
    // The interceptor emits the body RAW (the provider sanitizes); it sits on the request event.
    expect(events[0]?.event.type).toBe('before');
    expect(events[0]?.event.custom?.body).toBe('{"password":"hunter2"}');
    expect(events[0]?.event.custom?.headers).toEqual({ 'content-type': 'application/json' }); // user CT kept
    expect('no_body_reason' in customOf(events)).toBe(false); // mutually exclusive with body
  });

  it('captures an empty-string request body (falsy but present)', async () => {
    const { target, call } = harness(async () => okResponse());
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    await call('https://api/x', { method: 'POST', body: '' });
    expect('body' in customOf(events)).toBe(true); // present, not dropped as a falsy value
    expect(events[0]?.event.custom?.body).toBe('');
    expect('no_body_reason' in customOf(events)).toBe(false);
  });

  it('synthesizes the implied text/plain Content-Type for an unlabeled string body', async () => {
    // fetch defaults a string body to text/plain;charset=UTF-8 on the wire — capture that so the
    // downstream gate does not drop the body as no_content_type.
    const { target, call } = harness(async () => okResponse());
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    await call('https://api/x', { method: 'POST', body: 'plain text' });
    expect(events[0]?.event.custom?.body).toBe('plain text');
    expect(events[0]?.event.custom?.headers).toEqual({
      'content-type': 'text/plain;charset=UTF-8',
    });
  });

  it('captures a URLSearchParams body + synthesizes the form-urlencoded Content-Type', async () => {
    const USP = (
      globalThis as unknown as { URLSearchParams: new (i: Record<string, string>) => object }
    ).URLSearchParams;
    const { target, call } = harness(async () => okResponse());
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    await call('https://api/x', { method: 'POST', body: new USP({ a: '1', b: '2' }) });
    expect(events[0]?.event.custom?.body).toBe('a=1&b=2');
    expect(events[0]?.event.custom?.headers).toEqual({
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
    });
  });

  it('does not override a Content-Type the caller already set (case-insensitive)', async () => {
    const { target, call } = harness(async () => okResponse());
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    await call('https://api/x', {
      method: 'POST',
      headers: { 'Content-Type': 'app/custom' },
      body: 'x',
    });
    expect(events[0]?.event.custom?.headers).toEqual({ 'Content-Type': 'app/custom' });
  });

  it('records cant_read_data for a non-sync-readable body (typed array / Blob / stream)', async () => {
    const { target, call } = harness(async () => okResponse());
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    await call('https://api/x', { method: 'POST', body: new Uint8Array([1, 2, 3]) });
    expect(events[0]?.event.custom?.no_body_reason).toBe('cant_read_data');
    expect('body' in customOf(events)).toBe(false); // mutually exclusive with reason
    // No implied Content-Type for an unreadable body → no spurious content-type header is synthesized.
    expect('content-type' in (events[0]?.event.custom?.headers ?? {})).toBe(false);
  });

  it('records cant_read_data for a Request passed as input that carries a (stream) body', async () => {
    const { target, call } = harness(async () => okResponse());
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    // A Request-like input (string url) whose body is an unreadable stream, with no init.
    await call({ url: 'https://r/', method: 'POST', body: { locked: false } });
    expect(events[0]?.event.custom?.no_body_reason).toBe('cant_read_data');
    expect('body' in customOf(events)).toBe(false);
  });

  it('captures no body or reason for a Request input that carries no body', async () => {
    const { target, call } = harness(async () => okResponse());
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    await call({ url: 'https://r/', method: 'GET' }); // Request-like input, no body, no init
    expect('body' in customOf(events)).toBe(false);
    expect('no_body_reason' in customOf(events)).toBe(false);
  });

  it('does not treat a non-Request object input (no url) carrying a stray body as a request body', async () => {
    // A URL-like input has `href`, not `url`, and never carries a body — only a Request (string `url`)
    // is treated as a body carrier.
    const { target, call } = harness(async () => okResponse());
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    await call({ href: 'https://u/', body: { x: 1 } });
    expect('no_body_reason' in customOf(events)).toBe(false);
    expect('body' in customOf(events)).toBe(false);
  });

  it('omits both body and reason keys when there is no request body', async () => {
    const { target, call } = harness(async () => okResponse());
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    await call('https://api/x', { method: 'GET' });
    expect('body' in customOf(events)).toBe(false);
    expect('no_body_reason' in customOf(events)).toBe(false);
  });

  it('treats an explicit null body as no body (omits both keys, not cant_read_data)', async () => {
    const { target, call } = harness(async () => okResponse());
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    await call('https://api/x', { method: 'POST', body: null });
    expect('body' in customOf(events)).toBe(false);
    expect('no_body_reason' in customOf(events)).toBe(false);
  });

  it('does not consume or replace the body passed to the underlying fetch', async () => {
    let seenInit: unknown;
    const { target, call } = harness(async (_input, init) => {
      seenInit = init;
      return okResponse();
    });
    const ic = createFetchInterceptor({ target });
    collect(ic);
    const init = { method: 'POST', body: 'original-payload' };
    await call('https://api/x', init);
    expect((seenInit as { body?: unknown }).body).toBe('original-payload'); // untouched
  });
});

describe('createFetchInterceptor — response body', () => {
  const TE = (
    globalThis as unknown as { TextEncoder: new () => { encode: (s: string) => Uint8Array } }
  ).TextEncoder;
  const RS = (globalThis as unknown as { ReadableStream: new (src: object) => unknown })
    .ReadableStream;

  // A real ReadableStream that emits each part (UTF-8) as its own chunk, then closes.
  const streamOf = (...parts: string[]): unknown => {
    const chunks = parts.map((p) => new TE().encode(p));
    let i = 0;
    return new RS({
      pull(c: { enqueue: (chunk: unknown) => void; close: () => void }) {
        if (i < chunks.length) {
          c.enqueue(chunks[i]);
          i += 1;
        } else {
          c.close();
        }
      },
    });
  };

  // A fake Response: `clone()` returns an object whose `body` getter yields `cloneBody()`. `bodyGuard`
  // (if given) replaces the ORIGINAL response.body getter to detect any direct (app-disturbing) read.
  const responseWith = (opts: {
    headers?: Record<string, string>;
    cloneBody?: () => unknown;
    noClone?: boolean;
    cloneThrows?: boolean;
    onOriginalBodyRead?: () => void;
  }): unknown => {
    const headers = {
      forEach: (cb: (v: string, k: string) => void) => {
        for (const [k, v] of Object.entries(opts.headers ?? {})) {
          cb(v, k);
        }
      },
    };
    const resp: Record<string, unknown> = {
      status: 200,
      statusText: 'OK',
      redirected: false,
      headers,
    };
    Object.defineProperty(resp, 'body', {
      get() {
        opts.onOriginalBodyRead?.();
        return null;
      },
    });
    if (opts.cloneThrows) {
      resp.clone = () => {
        throw new Error('already used');
      };
    } else if (!opts.noClone) {
      resp.clone = () => ({
        get body() {
          return opts.cloneBody ? opts.cloneBody() : null;
        },
      });
    }
    return resp;
  };

  const setTimeoutG = (
    globalThis as unknown as { setTimeout: (cb: () => void, ms: number) => void }
  ).setTimeout;
  const tick = () => new Promise<void>((r) => setTimeoutG(() => r(), 0));
  const settle = async (pred: () => boolean) => {
    for (let i = 0; i < 50 && !pred(); i++) {
      await tick();
    }
  };
  const overrideEvent = (events: Captured[]) =>
    events.find((e) => e.event.override === true)?.event;

  it('captures a response body via the clone as an override amendment event', async () => {
    const { target, call } = harness(async () =>
      responseWith({
        headers: { 'content-type': 'application/json' },
        cloneBody: () => streamOf('{"x":1}'),
      }),
    );
    const ic = createFetchInterceptor({ target, newId: () => 'r1', now: () => 7 });
    const events = collect(ic);
    await call('https://api/x');
    await settle(() => overrideEvent(events) !== undefined);
    const amend = overrideEvent(events);
    expect(amend?.id).toBe('r1');
    expect(amend?.type).toBe('complete');
    expect(amend?.custom?.body).toBe('{"x":1}');
    expect(amend?.custom?.headers).toEqual({ 'content-type': 'application/json' }); // CT for the gate
    expect('no_body_reason' in (amend?.custom ?? {})).toBe(false);
    // The immediate metadata `complete` (no override) is still emitted first, body-less.
    const meta = events.find((e) => e.stage === 'complete' && e.event.override !== true)?.event;
    expect('body' in (meta?.custom ?? {})).toBe(false);
  });

  it('accumulates a multi-chunk response body', async () => {
    const { target, call } = harness(async () =>
      responseWith({ cloneBody: () => streamOf('ab', 'cd', 'ef') }),
    );
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    await call('https://api/x');
    await settle(() => overrideEvent(events) !== undefined);
    expect(overrideEvent(events)?.custom?.body).toBe('abcdef');
  });

  it('drops an over-cap response body (bounded read) as size_too_large', async () => {
    const { target, call } = harness(async () =>
      responseWith({ cloneBody: () => streamOf('way too long') }),
    );
    const ic = createFetchInterceptor({ target, maxBodyBytes: 5 });
    const events = collect(ic);
    await call('https://api/x');
    await settle(() => overrideEvent(events) !== undefined);
    expect(overrideEvent(events)?.custom?.no_body_reason).toBe('size_too_large');
    expect('body' in (overrideEvent(events)?.custom ?? {})).toBe(false);
  });

  it('cancels the reader when stopping early on an over-cap body (releases the tee branch)', async () => {
    const cancel = vi.fn(() => Promise.resolve());
    let calls = 0;
    const { target, call } = harness(async () =>
      responseWith({
        cloneBody: () => ({
          getReader: () => ({
            read: () => {
              calls += 1;
              // Always returns a 4-byte chunk, never done → only the cap stops it.
              return Promise.resolve({ done: false, value: new TE().encode('abcd') });
            },
            cancel,
          }),
        }),
      }),
    );
    const ic = createFetchInterceptor({ target, maxBodyBytes: 5 });
    const events = collect(ic);
    await call('https://api/x');
    await settle(() => overrideEvent(events) !== undefined);
    expect(overrideEvent(events)?.custom?.no_body_reason).toBe('size_too_large');
    expect(cancel).toHaveBeenCalledTimes(1); // stopped and released, did not drain the stream
    expect(calls).toBeLessThan(5); // bounded — did not read the (infinite) stream to completion
  });

  it('keeps a body exactly at the byte cap', async () => {
    const { target, call } = harness(async () =>
      responseWith({ cloneBody: () => streamOf('12345') }),
    );
    const ic = createFetchInterceptor({ target, maxBodyBytes: 5 });
    const events = collect(ic);
    await call('https://api/x');
    await settle(() => overrideEvent(events) !== undefined);
    expect(overrideEvent(events)?.custom?.body).toBe('12345');
  });

  it('fast-skips reading entirely when Content-Length already exceeds the cap', async () => {
    const readGuard = vi.fn();
    const { target, call } = harness(async () =>
      responseWith({
        headers: { 'Content-Length': '999999' }, // capitalized → exercises case-insensitive lookup
        cloneBody: () => ({
          getReader: () => {
            readGuard();
            throw new Error('must not read');
          },
        }),
      }),
    );
    const ic = createFetchInterceptor({ target, maxBodyBytes: 100 });
    const events = collect(ic);
    await call('https://api/x');
    await settle(() => overrideEvent(events) !== undefined);
    expect(overrideEvent(events)?.custom?.no_body_reason).toBe('size_too_large');
    expect(readGuard).not.toHaveBeenCalled(); // never touched the stream
  });

  it('emits no amendment when the response has no body (e.g. 204)', async () => {
    const { target, call } = harness(async () => responseWith({ cloneBody: () => null }));
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    await call('https://api/x');
    await tick();
    await tick();
    expect(overrideEvent(events)).toBeUndefined();
    expect(events.map((e) => e.stage)).toEqual(['before', 'complete']);
  });

  it('does not read or clone when captureBodies is off', async () => {
    let cloned = 0;
    const { target, call } = harness(async () =>
      responseWith({
        cloneBody: () => {
          cloned += 1;
          return streamOf('x');
        },
      }),
    );
    const ic = createFetchInterceptor({ target, captureBodies: false });
    const events = collect(ic);
    await call('https://api/x');
    await tick();
    await tick();
    expect(cloned).toBe(0);
    expect(overrideEvent(events)).toBeUndefined();
  });

  it('reports cant_read_data when the stream read rejects', async () => {
    const { target, call } = harness(async () =>
      responseWith({
        cloneBody: () => ({
          getReader: () => ({
            read: () => Promise.reject(new Error('boom')),
            cancel: () => Promise.resolve(),
          }),
        }),
      }),
    );
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    await call('https://api/x');
    await settle(() => overrideEvent(events) !== undefined);
    expect(overrideEvent(events)?.custom?.no_body_reason).toBe('cant_read_data');
  });

  it('reports cant_read_data when the clone body is not a readable stream', async () => {
    const { target, call } = harness(async () => responseWith({ cloneBody: () => ({}) })); // no getReader
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    await call('https://api/x');
    await settle(() => overrideEvent(events) !== undefined);
    expect(overrideEvent(events)?.custom?.no_body_reason).toBe('cant_read_data');
  });

  it('reports cant_read_data when TextDecoder is unavailable', async () => {
    const slot = globalThis as unknown as { TextDecoder?: unknown };
    const saved = slot.TextDecoder;
    slot.TextDecoder = undefined;
    try {
      const { target, call } = harness(async () =>
        responseWith({ cloneBody: () => streamOf('hi') }),
      );
      const ic = createFetchInterceptor({ target });
      const events = collect(ic);
      await call('https://api/x');
      await settle(() => overrideEvent(events) !== undefined);
      expect(overrideEvent(events)?.custom?.no_body_reason).toBe('cant_read_data');
    } finally {
      slot.TextDecoder = saved;
    }
  });

  it('emits no amendment when the response cannot be cloned', async () => {
    const { target, call } = harness(async () =>
      responseWith({ noClone: true, cloneBody: () => streamOf('x') }),
    );
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    await call('https://api/x');
    await tick();
    await tick();
    expect(overrideEvent(events)).toBeUndefined();
  });

  it('emits no amendment when clone() throws (e.g. body already used)', async () => {
    const { target, call } = harness(async () => responseWith({ cloneThrows: true }));
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    await call('https://api/x');
    await tick();
    await tick();
    expect(overrideEvent(events)).toBeUndefined();
  });

  it('reads only the clone, never the original response body (no app disturbance)', async () => {
    let originalRead = 0;
    const resp = responseWith({
      cloneBody: () => streamOf('safe'),
      onOriginalBodyRead: () => {
        originalRead += 1;
      },
    });
    const { target, call } = harness(async () => resp);
    const ic = createFetchInterceptor({ target });
    const events = collect(ic);
    const result = await call('https://api/x');
    expect(result).toBe(resp); // original response returned unchanged
    await settle(() => overrideEvent(events) !== undefined);
    expect(overrideEvent(events)?.custom?.body).toBe('safe');
    expect(originalRead).toBe(0); // the SDK never touched response.body
  });
});

describe('createFetchInterceptor — default global target', () => {
  it('wraps globalThis.fetch when no target is given', async () => {
    const slot = globalThis as unknown as { fetch?: FetchFn };
    const real = slot.fetch;
    const resp = okResponse();
    slot.fetch = async () => resp;
    try {
      const ic = createFetchInterceptor({ now: () => 0, newId: () => 'g' });
      const events = collect(ic); // activates → wraps globalThis.fetch
      const result = await (slot.fetch as FetchFn)('https://g/');
      expect(result).toBe(resp);
      expect(events.map((e) => e.stage)).toEqual(['before', 'complete']);
      expect(events[0]?.event.url).toBe('https://g/');
    } finally {
      slot.fetch = real;
    }
  });
});

describe('createFetchInterceptor — activation', () => {
  it('wraps the target fetch on activate and restores it on the last unsubscribe', () => {
    const impl: FetchFn = async () => okResponse();
    const { target } = harness(impl);
    const ic = createFetchInterceptor({ target });
    const off = ic.onAny(() => {});
    expect(target.get()).not.toBe(impl); // wrapped while active
    off();
    expect(target.get()).toBe(impl); // restored when idle
  });

  it('is a safe no-op when the target has no fetch to wrap', () => {
    const target: FetchTarget = {
      get: () => undefined,
      set: () => {
        throw new Error('must not install a wrapper when there is no fetch');
      },
    };
    const ic = createFetchInterceptor({ target });
    expect(() => ic.onAny(() => {})).not.toThrow();
  });
});
