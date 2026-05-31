import { Buffer } from 'node:buffer';
import type { NetworkEvent } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import {
  createNodeHttpInterceptor,
  type HttpModule,
  type NodeHttpInterceptorOptions,
  type NodeHttpTarget,
} from './http-interceptor';

// A fake ClientRequest: records 'response'/'error' listeners (the test fires them) and the
// write/end body-writing calls that reach the ORIGINAL methods (to verify pass-through).
class FakeReq {
  readonly #listeners: Record<string, Array<(arg: unknown) => void>> = {};
  readonly writes: unknown[][] = [];
  readonly ends: unknown[][] = [];
  on(event: string, listener: (arg: unknown) => void): this {
    let list = this.#listeners[event];
    if (list === undefined) {
      list = [];
      this.#listeners[event] = list;
    }
    list.push(listener);
    return this;
  }
  write(...args: unknown[]): boolean {
    this.writes.push(args);
    return true;
  }
  end(...args: unknown[]): this {
    this.ends.push(args);
    return this;
  }
  fire(event: string, arg?: unknown): void {
    for (const l of this.#listeners[event] ?? []) {
      l(arg);
    }
  }
  listenerCount(event: string): number {
    return this.#listeners[event]?.length ?? 0;
  }
}

// A fake { http, https } target. Each request/get is an INDEPENDENT fn that mints its own FakeReq
// (mirrors node: http.get does NOT route through the patched exports.request — lexical scope), so
// wrapping both never double-captures. `last` is the most-recently-created FakeReq.
function makeTarget(): { target: NodeHttpTarget; reqs: FakeReq[]; last: () => FakeReq } {
  const reqs: FakeReq[] = [];
  const mk =
    (): HttpModule['request'] =>
    (..._args: unknown[]) => {
      const r = new FakeReq();
      reqs.push(r);
      return r as unknown;
    };
  const target: NodeHttpTarget = {
    http: { request: mk(), get: mk() },
    https: { request: mk(), get: mk() },
  };
  return { target, reqs, last: () => reqs[reqs.length - 1] as FakeReq };
}

// Start a fresh interceptor over a fake target, collecting every emitted NetworkEvent via onAny.
function harness(extra: Omit<NodeHttpInterceptorOptions, 'target'> = {}) {
  const { target, last } = makeTarget();
  const interceptor = createNodeHttpInterceptor({ target, ...extra });
  const events: NetworkEvent[] = [];
  interceptor.onAny((_stage, payload) => events.push(payload as NetworkEvent));
  interceptor.start();
  return { interceptor, target, last, events };
}

// A fresh fake IncomingMessage per use (the interceptor patches its `push` per-instance to observe the
// response body, so a shared object would leak the patch across tests). `pushed` records what reached
// the ORIGINAL push (pass-through). Fire chunks with `res.push('chunk')` then `res.push(null)` (EOF).
class FakeRes {
  statusCode = 200;
  statusMessage = 'OK';
  headers: Record<string, unknown> = { 'content-type': 'text/html' };
  readonly pushed: unknown[] = [];
  push(chunk: unknown, enc?: unknown): boolean {
    this.pushed.push([chunk, enc]);
    return true;
  }
}
const mkRes = (
  over: Partial<Pick<FakeRes, 'statusCode' | 'statusMessage' | 'headers'>> = {},
): FakeRes => Object.assign(new FakeRes(), over);

// Run fn and return the value it throws (or a unique sentinel if it doesn't), so tests can assert
// the IDENTITY of a re-raised error, not merely that something threw.
const DID_NOT_THROW = Symbol('did-not-throw');
const caught = (fn: () => void): unknown => {
  try {
    fn();
    return DID_NOT_THROW;
  } catch (error) {
    return error;
  }
};

describe('createNodeHttpInterceptor', () => {
  it('emits before then complete for an http.request(string url), sharing id/sequence', () => {
    const { target, last, events } = harness();
    target.http.request('http://api.test/x');
    last().fire('response', mkRes());

    expect(events.map((e) => e.type)).toEqual(['before', 'complete']);
    const [before, complete] = events;
    expect(before).toMatchObject({
      mechanism: 'http',
      url: 'http://api.test/x',
      method: 'GET',
      type: 'before',
    });
    expect(before?.id).toBe('h1'); // default newId counter
    expect(complete).toMatchObject({
      id: 'h1',
      sequence: 'h1',
      mechanism: 'http',
      type: 'complete',
      status: 200,
      statusText: 'OK',
    });
    expect(complete?.custom?.headers).toEqual({ 'content-type': 'text/html' });
    expect(typeof before?.timestamp).toBe('number'); // default now = Date.now
  });

  it('stamps before/complete timestamps and the duration from the injected clock', () => {
    let t = 1000;
    const { target, last, events } = harness({ now: () => t });
    target.http.request('http://api.test/x');
    t = 1750;
    last().fire('response', mkRes());
    expect(events[0]?.timestamp).toBe(1000); // before, stamped at request start
    expect(events[1]?.timestamp).toBe(1750); // complete, stamped at response
    expect(events[1]?.custom?.timings).toEqual({ duration: 750 });
  });

  it('wraps https.get and builds the url from an options object (default https protocol)', () => {
    const { target, events } = harness();
    target.https.get({
      hostname: 'h.test',
      port: 8443,
      path: '/p',
      method: 'post',
      headers: { 'X-A': '1' },
    });
    expect(events[0]).toMatchObject({
      mechanism: 'http',
      url: 'https://h.test:8443/p',
      method: 'POST', // uppercased
    });
    expect(events[0]?.custom?.headers).toEqual({ 'X-A': '1' });
  });

  it('builds the url from minimal options: protocol from options, host fallback, default path', () => {
    const { target, events } = harness();
    target.http.request({ protocol: 'http:', host: 'only-host.test' });
    expect(events[0]?.url).toBe('http://only-host.test/');
  });

  it('omits an explicit port 0 from the built url (0 = "any", not a real target)', () => {
    const { target, events } = harness();
    target.http.request({ host: 'h.test', port: 0, path: '/p' });
    expect(events[0]?.url).toBe('http://h.test/p');
  });

  it('falls back to localhost and http when options carry neither host nor protocol', () => {
    const { target, events } = harness();
    target.http.request({ method: 'GET' });
    expect(events[0]?.url).toBe('http://localhost/');
  });

  it('reads the url from a URL object (href) and options from the second arg', () => {
    const { target, events } = harness();
    target.http.request({ href: 'http://u.test/p' }, { method: 'put', headers: {} });
    expect(events[0]).toMatchObject({ url: 'http://u.test/p', method: 'PUT' });
  });

  it('reads options from the second arg when the first is a url string', () => {
    const { target, events } = harness();
    target.http.request('http://api.test/y', { method: 'delete' });
    expect(events[0]).toMatchObject({ url: 'http://api.test/y', method: 'DELETE' });
  });

  it('joins array-valued headers with a comma (request and response)', () => {
    const { target, last, events } = harness();
    target.http.request('http://api.test/z', { headers: { 'x-multi': ['a', 'b'] } });
    last().fire(
      'response',
      mkRes({
        statusCode: 204,
        statusMessage: 'No Content',
        headers: { 'set-cookie': ['c1=1', 'c2=2'] },
      }),
    );
    expect(events[0]?.custom?.headers).toEqual({ 'x-multi': 'a, b' });
    expect(events[1]?.custom?.headers).toEqual({ 'set-cookie': 'c1=1, c2=2' });
  });

  it('emits an error event (with timestamp) and re-raises the ORIGINAL error when sole listener', () => {
    const { target, last, events } = harness({ now: () => 4242 });
    target.http.request('http://api.test/e');
    // The app installed no 'error' listener, so node would throw — capturing must preserve that,
    // re-raising the SAME object (not a re-wrap, which would lose its type/.code/.stack).
    const err = new Error('boom');
    expect(caught(() => last().fire('error', err))).toBe(err);
    expect(events.map((e) => e.type)).toEqual(['before', 'error']); // captured before re-raising
    expect(events[1]).toMatchObject({ type: 'error', customError: 'boom', timestamp: 4242 });
    expect(events[1]?.custom?.error).toBe('boom');
  });

  it('re-raises a non-Error error value UNCHANGED (no Error wrapping)', () => {
    const { target, last, events } = harness();
    target.http.request('http://api.test/e');
    expect(caught(() => last().fire('error', 'kaput'))).toBe('kaput'); // the raw string, not Error('kaput')
    expect(events[1]?.customError).toBe('kaput');
  });

  it('does NOT re-raise when the request has its own error listener (app handles it)', () => {
    const { target, events } = harness();
    const req = target.http.request('http://api.test/e') as FakeReq;
    const appErrors: unknown[] = [];
    req.on('error', (e) => appErrors.push(e)); // the app's handler → no longer the sole listener
    const err = new Error('handled');
    expect(() => req.fire('error', err)).not.toThrow(); // capture, but leave the app's handling intact
    expect(events[1]).toMatchObject({ type: 'error', customError: 'handled' });
    expect(appErrors).toEqual([err]); // the app's listener still ran
  });

  it('skips SDK self-traffic via the default X-Bugsee-Internal header', () => {
    const { target, last, events } = harness();
    target.http.request('http://ingest.test', { headers: { 'X-Bugsee-Internal': '1' } });
    last().fire('response', mkRes()); // listeners were never attached
    expect(events).toEqual([]);
  });

  it('honours a custom isInternal predicate (by url)', () => {
    const { target, events } = harness({ isInternal: (url) => url.includes('skip-me') });
    target.http.request('http://skip-me.test/a');
    target.http.request('http://keep.test/b');
    expect(events.map((e) => e.url)).toEqual(['http://keep.test/b']);
  });

  it('numbers requests with the default counter across calls', () => {
    const { target, events } = harness();
    target.http.request('http://api.test/1');
    target.https.request('http://api.test/2');
    expect(events.map((e) => e.id)).toEqual(['h1', 'h2']);
  });

  it('uses an injected newId', () => {
    const { target, events } = harness({ newId: () => 'fixed' });
    target.http.request('http://api.test/x');
    expect(events[0]?.id).toBe('fixed');
  });

  it('restores request and get on both modules when stopped', () => {
    const { target } = makeTarget();
    const origs = {
      hr: target.http.request,
      hg: target.http.get,
      sr: target.https.request,
      sg: target.https.get,
    };
    const interceptor = createNodeHttpInterceptor({ target });
    interceptor.start();
    expect(target.http.request).not.toBe(origs.hr);
    expect(target.https.get).not.toBe(origs.sg);
    interceptor.stop();
    expect(target.http.request).toBe(origs.hr);
    expect(target.http.get).toBe(origs.hg);
    expect(target.https.request).toBe(origs.sr);
    expect(target.https.get).toBe(origs.sg);
  });

  it('patches only while a subscriber is present (subscriber-presence)', () => {
    const { target } = makeTarget();
    const orig = target.http.request;
    const interceptor = createNodeHttpInterceptor({ target });
    expect(target.http.request).toBe(orig); // idle: not patched
    const off = interceptor.onAny(() => {});
    expect(target.http.request).not.toBe(orig); // subscriber present: patched
    off();
    expect(target.http.request).toBe(orig); // last subscriber gone: restored
  });

  it('falls back to a localhost url when the first arg is absent or null (no usable url/options)', () => {
    const { target, events } = harness();
    target.http.request(); // first === undefined → not string, not object
    target.http.request(null); // first === null → fails the `!== null` guard
    expect(events.map((e) => e.url)).toEqual(['http://localhost/', 'http://localhost/']);
  });

  it('defaults the target to the real node:http/https modules when none is supplied', () => {
    // Construct only (never started) so the real modules are left unpatched; this exercises the
    // `?? { http, https }` default-target fallback.
    expect(createNodeHttpInterceptor().name).toBe('node-http');
  });
});

describe('createNodeHttpInterceptor — request body', () => {
  const override = (events: NetworkEvent[]) => events.find((e) => e.override === true);

  it('captures a body written via write()+end() as an override before amendment (passthrough)', () => {
    const { target, last, events } = harness({ newId: () => 'h1' });
    const req = target.http.request('http://api.test/x') as FakeReq;
    req.write('hello ');
    req.write('world');
    req.end();
    last().fire('response', mkRes());
    // before (metadata) → before (override, with body) → complete
    expect(events.map((e) => `${e.type}${e.override ? ':o' : ''}`)).toEqual([
      'before',
      'before:o',
      'complete',
    ]);
    expect(override(events)).toMatchObject({ id: 'h1', type: 'before', override: true });
    expect(override(events)?.custom?.body).toBe('hello world');
    // the original write/end were called through unchanged
    expect(req.writes).toEqual([['hello '], ['world']]);
    expect(req.ends).toEqual([[]]);
  });

  it('captures a body passed to end() and includes the request headers (for the gate)', () => {
    const { target, last, events } = harness();
    target.http.request({ host: 'api.test', headers: { 'content-type': 'application/json' } });
    (last() as FakeReq).end('{"a":1}');
    expect(override(events)?.custom?.body).toBe('{"a":1}');
    expect(override(events)?.custom?.headers).toEqual({ 'content-type': 'application/json' });
  });

  it('captures a Buffer chunk (node bodies are usually Buffers)', () => {
    const { target, last, events } = harness();
    target.http.request('http://api.test/x');
    (last() as FakeReq).end(Buffer.from('buffer-body'));
    expect(override(events)?.custom?.body).toBe('buffer-body');
  });

  it('captures a Uint8Array chunk by its raw bytes (not its String() form)', () => {
    const { target, last, events } = harness();
    target.http.request('http://api.test/x');
    (last() as FakeReq).end(new Uint8Array([104, 105])); // 'hi' — String() would give "104,105"
    expect(override(events)?.custom?.body).toBe('hi');
  });

  it('emits no amendment for a body-less request (end with no chunk)', () => {
    const { target, last, events } = harness();
    target.http.request('http://api.test/x');
    (last() as FakeReq).end();
    last().fire('response', mkRes());
    expect(events.some((e) => e.override)).toBe(false);
    expect(events.map((e) => e.type)).toEqual(['before', 'complete']);
  });

  it('treats end(callback) as a body-less request (first arg is a function)', () => {
    const { target, last, events } = harness();
    target.http.request('http://api.test/x');
    (last() as FakeReq).end(() => {});
    expect(events.some((e) => e.override)).toBe(false);
  });

  it('drops an over-cap request body as size_too_large', () => {
    const { target, last, events } = harness({ maxBodyBytes: 5 });
    target.http.request('http://api.test/x');
    (last() as FakeReq).end('way too long');
    expect(override(events)?.custom?.no_body_reason).toBe('size_too_large');
    expect('body' in (override(events)?.custom ?? {})).toBe(false);
  });

  it('keeps a request body exactly at the byte cap', () => {
    const { target, last, events } = harness({ maxBodyBytes: 5 });
    target.http.request('http://api.test/x');
    (last() as FakeReq).end('12345'); // exactly 5 bytes
    expect(override(events)?.custom?.body).toBe('12345');
  });

  it('accumulates across multiple write() calls and a final end(chunk)', () => {
    const { target, last, events } = harness();
    target.http.request('http://api.test/x');
    const req = last() as FakeReq;
    req.write('a');
    req.write('b');
    req.end('c');
    expect(override(events)?.custom?.body).toBe('abc');
  });

  it('decodes a written chunk using its declared encoding (base64)', () => {
    // 'aGVsbG8=' is 'hello' base64-encoded; honoring the encoding yields 'hello' (vs the literal).
    const { target, last, events } = harness();
    target.http.request('http://api.test/x');
    (last() as FakeReq).write('aGVsbG8=', 'base64');
    (last() as FakeReq).end();
    expect(override(events)?.custom?.body).toBe('hello');
  });

  it('emits the request-body amendment only once even if end() is called twice', () => {
    const { target, last, events } = harness();
    target.http.request('http://api.test/x');
    const req = last() as FakeReq;
    req.end('first');
    req.end('second'); // re-entrant finalize is guarded
    expect(events.filter((e) => e.override).length).toBe(1);
    expect(override(events)?.custom?.body).toBe('first');
  });

  it('does not patch write/end when captureBodies is off (no amendment, still passes through)', () => {
    const { target, events } = harness({ captureBodies: false });
    const req = target.http.request('http://api.test/x') as FakeReq;
    req.end('a body');
    expect(events.some((e) => e.override)).toBe(false);
    expect(req.ends).toEqual([['a body']]); // original end still called
  });

  it('ignores a null chunk (write(null)) — treated as no body', () => {
    const { target, last, events } = harness();
    target.http.request('http://api.test/x');
    (last() as FakeReq).write(null);
    (last() as FakeReq).end();
    expect(events.some((e) => e.override)).toBe(false); // null is not captured as the literal "null"
  });

  it('captures a Uint8Array SUBVIEW by its bytes (respects byteOffset/length)', () => {
    const { target, last, events } = harness();
    target.http.request('http://api.test/x');
    (last() as FakeReq).end(new Uint8Array([97, 98, 99, 100]).subarray(1, 3)); // bytes 98,99 = 'bc'
    expect(override(events)?.custom?.body).toBe('bc');
  });

  it('does not capture the body of a self-isolated (X-Bugsee-Internal) request', () => {
    const { target, last, events } = harness();
    target.http.request({ host: 'api.test', headers: { 'X-Bugsee-Internal': '1' } });
    (last() as FakeReq).end('internal body');
    expect(events).toEqual([]); // skipped entirely — no before, no amendment
  });
});

describe('createNodeHttpInterceptor — response body', () => {
  // The response-body amendment is a `complete` override (distinct from a request-body `before` override).
  const resOverride = (events: NetworkEvent[]) =>
    events.find((e) => e.override === true && e.type === 'complete');

  it('captures a response body by passively observing push (complete override, passthrough)', () => {
    const { target, last, events } = harness({ newId: () => 'h1', now: () => 4242 });
    const res = mkRes();
    target.http.request('http://api.test/x');
    last().fire('response', res); // interceptor patches res.push
    res.push(Buffer.from('part1'));
    res.push(Buffer.from('part2'));
    res.push(null); // EOF → finalize
    // full correlation identity on the amendment (id/sequence/mechanism/url/method + timestamp)
    expect(resOverride(events)).toMatchObject({
      id: 'h1',
      sequence: 'h1',
      mechanism: 'http',
      url: 'http://api.test/x',
      method: 'GET',
      type: 'complete',
      override: true,
      timestamp: 4242,
    });
    expect(resOverride(events)?.custom?.body).toBe('part1part2');
    expect('no_body_reason' in (resOverride(events)?.custom ?? {})).toBe(false); // body XOR reason
    expect(resOverride(events)?.custom?.headers).toEqual({ 'content-type': 'text/html' });
    // every chunk (incl. the null EOF) reached the original push — the stream is unaltered
    expect(res.pushed).toEqual([
      [Buffer.from('part1'), undefined],
      [Buffer.from('part2'), undefined],
      [null, undefined],
    ]);
  });

  it('emits no amendment for a body-less response (push(null) with no chunks)', () => {
    const { target, last, events } = harness();
    const res = mkRes();
    target.http.request('http://api.test/x');
    last().fire('response', res);
    res.push(null);
    expect(resOverride(events)).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(['before', 'complete']);
  });

  it('drops an over-cap response body as size_too_large', () => {
    const { target, last, events } = harness({ maxBodyBytes: 5 });
    const res = mkRes();
    target.http.request('http://api.test/x');
    last().fire('response', res);
    res.push(Buffer.from('way too long'));
    res.push(null);
    expect(resOverride(events)?.custom?.no_body_reason).toBe('size_too_large');
    expect('body' in (resOverride(events)?.custom ?? {})).toBe(false);
  });

  it('does not read a Content-Encoding-compressed body (gzip → cant_read_data, push not observed)', () => {
    const { target, last, events } = harness();
    const res = mkRes({
      headers: { 'content-type': 'application/json', 'content-encoding': 'gzip' },
    });
    target.http.request('http://api.test/x');
    last().fire('response', res); // cant_read_data emitted synchronously, push left unpatched
    expect(resOverride(events)?.custom?.no_body_reason).toBe('cant_read_data');
    expect('body' in (resOverride(events)?.custom ?? {})).toBe(false);
    res.push(Buffer.from('compressed-bytes')); // not observed (push was never patched)
    res.push(null);
    expect(events.filter((e) => e.override).length).toBe(1); // still just the cant_read_data one
  });

  it('treats content-encoding "identity" as readable (not compressed)', () => {
    const { target, last, events } = harness();
    const res = mkRes({
      headers: { 'content-type': 'text/plain', 'content-encoding': 'identity' },
    });
    target.http.request('http://api.test/x');
    last().fire('response', res);
    res.push(Buffer.from('plain'));
    res.push(null);
    expect(resOverride(events)?.custom?.body).toBe('plain');
  });

  it('does not observe the response body when captureBodies is off', () => {
    const { target, last, events } = harness({ captureBodies: false });
    const res = mkRes();
    target.http.request('http://api.test/x');
    last().fire('response', res);
    res.push(Buffer.from('secret response'));
    res.push(null);
    expect(events.some((e) => e.override)).toBe(false);
  });

  it('treats a padded/uppercase content-encoding "identity" as readable (trim + lowercase)', () => {
    const { target, last, events } = harness();
    const res = mkRes({
      headers: { 'content-type': 'text/plain', 'content-encoding': ' IDENTITY ' },
    });
    target.http.request('http://api.test/x');
    last().fire('response', res);
    res.push(Buffer.from('plain'));
    res.push(null);
    expect(resOverride(events)?.custom?.body).toBe('plain');
  });

  it('emits the response-body amendment only once even if push(null) fires twice', () => {
    const { target, last, events } = harness();
    const res = mkRes();
    target.http.request('http://api.test/x');
    last().fire('response', res);
    res.push(Buffer.from('once'));
    res.push(null);
    res.push(null); // re-entrant EOF is guarded
    expect(events.filter((e) => e.override && e.type === 'complete').length).toBe(1);
  });

  it('treats an empty content-encoding as readable', () => {
    const { target, last, events } = harness();
    const res = mkRes({ headers: { 'content-type': 'text/plain', 'content-encoding': '' } });
    target.http.request('http://api.test/x');
    last().fire('response', res);
    res.push(Buffer.from('plain'));
    res.push(null);
    expect(resOverride(events)?.custom?.body).toBe('plain');
  });

  it('emits the response-body amendment on the complete channel (not before)', () => {
    const { target, last } = makeTarget();
    const ic = createNodeHttpInterceptor({ target, newId: () => 'h1' });
    const completeBodies: Array<string | null | undefined> = [];
    ic.on('complete', (e) => completeBodies.push((e as NetworkEvent).custom?.body));
    ic.start();
    const res = mkRes();
    target.http.request('http://api.test/x');
    last().fire('response', res);
    res.push(Buffer.from('chan-body'));
    res.push(null);
    expect(completeBodies).toContain('chan-body'); // arrived on the 'complete' channel
  });
});
