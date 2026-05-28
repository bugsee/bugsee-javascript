import type { NetworkEvent } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import {
  createNodeHttpInterceptor,
  type HttpModule,
  type NodeHttpInterceptorOptions,
  type NodeHttpTarget,
} from './http-interceptor';

// A fake ClientRequest: records 'response'/'error' listeners; the test fires them.
class FakeReq {
  readonly #listeners: Record<string, Array<(arg: unknown) => void>> = {};
  on(event: string, listener: (arg: unknown) => void): this {
    let list = this.#listeners[event];
    if (list === undefined) {
      list = [];
      this.#listeners[event] = list;
    }
    list.push(listener);
    return this;
  }
  fire(event: string, arg?: unknown): void {
    for (const l of this.#listeners[event] ?? []) {
      l(arg);
    }
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

const okResponse = {
  statusCode: 200,
  statusMessage: 'OK',
  headers: { 'content-type': 'text/html' },
};

describe('createNodeHttpInterceptor', () => {
  it('emits before then complete for an http.request(string url), sharing id/sequence', () => {
    const { target, last, events } = harness();
    target.http.request('http://api.test/x');
    last().fire('response', okResponse);

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

  it('computes complete.custom.timings.duration from the injected clock', () => {
    let t = 1000;
    const { target, last, events } = harness({ now: () => t });
    target.http.request('http://api.test/x');
    t = 1750;
    last().fire('response', okResponse);
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
    last().fire('response', {
      statusCode: 204,
      statusMessage: 'No Content',
      headers: { 'set-cookie': ['c1=1', 'c2=2'] },
    });
    expect(events[0]?.custom?.headers).toEqual({ 'x-multi': 'a, b' });
    expect(events[1]?.custom?.headers).toEqual({ 'set-cookie': 'c1=1, c2=2' });
  });

  it('emits an error event with the message of a thrown Error', () => {
    const { target, last, events } = harness();
    target.http.request('http://api.test/e');
    last().fire('error', new Error('boom'));
    expect(events.map((e) => e.type)).toEqual(['before', 'error']);
    expect(events[1]).toMatchObject({ type: 'error', customError: 'boom' });
    expect(events[1]?.custom?.error).toBe('boom');
  });

  it('stringifies a non-Error error value', () => {
    const { target, last, events } = harness();
    target.http.request('http://api.test/e');
    last().fire('error', 'kaput');
    expect(events[1]?.customError).toBe('kaput');
  });

  it('skips SDK self-traffic via the default X-Bugsee-Internal header', () => {
    const { target, last, events } = harness();
    target.http.request('http://ingest.test', { headers: { 'X-Bugsee-Internal': '1' } });
    last().fire('response', okResponse); // listeners were never attached
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
