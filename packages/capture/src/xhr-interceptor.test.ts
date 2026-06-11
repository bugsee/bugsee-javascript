import type { Interceptor } from '@bugsee/core';
import type { NetworkEvent, NetworkStage } from '@bugsee/protocol';
import { describe, expect, it } from 'vitest';
import {
  createXhrInterceptor,
  type XhrInterceptorOptions,
  type XhrTarget,
} from './xhr-interceptor';

// A fresh fake XMLHttpRequest CLASS per call, so prototype-patching in one test never leaks to another.
function makeXhr() {
  return class FakeXhr {
    status = 0;
    statusText = '';
    responseHeaders = '';
    responseType = '';
    responseText = '';
    response: unknown = undefined;
    readonly opened: Array<{ method: string; url: string }> = [];
    readonly sent: unknown[] = [];
    readonly reqHeaders: Record<string, string> = {};
    readonly #listeners = new Map<string, Array<() => void>>();
    open(method: string, url: string): void {
      this.opened.push({ method, url });
    }
    send(body?: unknown): void {
      this.sent.push(body);
    }
    setRequestHeader(name: string, value: string): void {
      this.reqHeaders[name] = value;
    }
    addEventListener(type: string, listener: () => void): void {
      const arr = this.#listeners.get(type) ?? [];
      arr.push(listener);
      this.#listeners.set(type, arr);
    }
    getAllResponseHeaders(): string {
      return this.responseHeaders;
    }
    fire(type: string): void {
      for (const listener of this.#listeners.get(type) ?? []) {
        listener();
      }
    }
  };
}

function setup(opts: Partial<XhrInterceptorOptions> = {}) {
  const Xhr = makeXhr();
  const target: XhrTarget = { get: () => Xhr };
  const ic: Interceptor<Record<NetworkStage, NetworkEvent>> = createXhrInterceptor({
    now: () => 100,
    newId: () => 'x1',
    target,
    ...opts,
  });
  const events: Array<[NetworkStage, NetworkEvent]> = [];
  ic.onAny((stage, event) => events.push([stage, event])); // activate → patches Xhr.prototype
  return { Xhr, ic, events };
}

describe('createXhrInterceptor — capture', () => {
  it('emits before then complete on load (method upcased, req+resp headers, passthrough)', () => {
    const { Xhr, events } = setup();
    const xhr = new Xhr();
    xhr.open('get', 'https://api/x');
    xhr.setRequestHeader('authorization', 'secret');
    xhr.send('payload');
    xhr.status = 200;
    xhr.statusText = 'OK';
    xhr.responseHeaders = 'content-type: application/json\r\nx-a: b\r\n';
    xhr.responseText = '{"ok":true}';
    xhr.fire('load');
    expect(events.map(([s]) => s)).toEqual(['before', 'complete']);
    expect(events[0]?.[1]).toMatchObject({
      id: 'x1',
      sequence: 'x1',
      mechanism: 'xhr',
      url: 'https://api/x',
      method: 'GET',
      type: 'before',
    });
    // request body captured + implied Content-Type synthesized (caller set none)
    expect(events[0]?.[1].custom?.headers).toEqual({
      authorization: 'secret',
      'content-type': 'text/plain;charset=UTF-8',
    });
    expect(events[0]?.[1].custom?.body).toBe('payload');
    expect(events[1]?.[1]).toMatchObject({ type: 'complete', status: 200, statusText: 'OK' });
    expect(events[1]?.[1].custom?.headers).toEqual({
      'content-type': 'application/json',
      'x-a': 'b',
    });
    expect(events[1]?.[1].custom?.body).toBe('{"ok":true}'); // response body captured (responseText)
    // original methods were called through
    expect(xhr.opened).toEqual([{ method: 'get', url: 'https://api/x' }]);
    expect(xhr.sent).toEqual(['payload']);
    expect(xhr.reqHeaders).toEqual({ authorization: 'secret' });
  });

  it('emits error on a network error, timeout, and a separate abort stage', () => {
    const error = setup();
    const e1 = new error.Xhr();
    e1.open('GET', 'u');
    e1.send();
    e1.fire('error');
    expect(error.events.map(([s]) => s)).toEqual(['before', 'error']);
    expect(error.events[1]?.[1]).toMatchObject({ type: 'error', customError: 'network error' });

    const timeout = setup();
    const e2 = new timeout.Xhr();
    e2.open('GET', 'u');
    e2.send();
    e2.fire('timeout');
    expect(timeout.events[1]?.[1]).toMatchObject({ type: 'error', customError: 'timeout' });

    const abort = setup();
    const e3 = new abort.Xhr();
    e3.open('GET', 'u');
    e3.send();
    e3.fire('abort');
    expect(abort.events.map(([s]) => s)).toEqual(['before', 'abort']);
    expect(abort.events[1]?.[1]).toMatchObject({ type: 'abort', customError: 'aborted' });
  });

  it('shares one id+sequence across a request and increments per request (default counter)', () => {
    const { Xhr, events } = setup({ newId: undefined });
    const a = new Xhr();
    a.open('GET', 'a');
    a.send();
    a.fire('load');
    const b = new Xhr();
    b.open('GET', 'b');
    b.send();
    b.fire('load');
    expect(events.map(([, e]) => e.id)).toEqual(['x1', 'x1', 'x2', 'x2']);
  });

  it('uses the default clock (Date.now) when none is injected', () => {
    const { Xhr, events } = setup({ now: undefined });
    const xhr = new Xhr();
    xhr.open('GET', 'u');
    xhr.send();
    xhr.fire('load');
    expect(events[1]?.[1].timestamp).toBeGreaterThan(0); // Date.now() was used
  });

  it('parses response headers, skipping blank/malformed lines', () => {
    const { Xhr, events } = setup();
    const xhr = new Xhr();
    xhr.open('GET', 'u');
    xhr.send();
    xhr.responseHeaders = 'content-type: text/plain\r\nmalformed-no-colon\r\n\r\n';
    xhr.fire('load');
    expect(events[1]?.[1].custom?.headers).toEqual({ 'content-type': 'text/plain' });
  });
});

describe('createXhrInterceptor — body capture', () => {
  const before = (events: Array<[NetworkStage, NetworkEvent]>) => events[0]?.[1].custom ?? {};
  const complete = (events: Array<[NetworkStage, NetworkEvent]>) =>
    events.find(([s]) => s === 'complete')?.[1].custom ?? {};

  it('captures a URLSearchParams request body + synthesizes the form Content-Type', () => {
    const USP = (
      globalThis as unknown as { URLSearchParams: new (i: Record<string, string>) => object }
    ).URLSearchParams;
    const { Xhr, events } = setup();
    const xhr = new Xhr();
    xhr.open('POST', 'u');
    xhr.send(new USP({ a: '1', b: '2' }));
    expect(before(events).body).toBe('a=1&b=2');
    expect(before(events).headers).toEqual({
      'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
    });
  });

  it('does not override a Content-Type the caller already set', () => {
    const { Xhr, events } = setup();
    const xhr = new Xhr();
    xhr.open('POST', 'u');
    xhr.setRequestHeader('Content-Type', 'app/custom');
    xhr.send('x');
    expect(before(events).headers).toEqual({ 'Content-Type': 'app/custom' });
    expect(before(events).body).toBe('x');
  });

  it('omits the request body keys when there is no body', () => {
    const { Xhr, events } = setup();
    const xhr = new Xhr();
    xhr.open('GET', 'u');
    xhr.send();
    expect('body' in before(events)).toBe(false);
    expect('no_body_reason' in before(events)).toBe(false);
  });

  it('records cant_read_data for a non-sync-readable request body', () => {
    const { Xhr, events } = setup();
    const xhr = new Xhr();
    xhr.open('POST', 'u');
    xhr.send(new Uint8Array([1, 2, 3]));
    expect(before(events).no_body_reason).toBe('cant_read_data');
    expect('body' in before(events)).toBe(false);
  });

  it('captures a text response body (responseType "text")', () => {
    const { Xhr, events } = setup();
    const xhr = new Xhr();
    xhr.open('GET', 'u');
    xhr.send();
    xhr.responseType = 'text';
    xhr.responseText = 'hello world';
    xhr.fire('load');
    expect(complete(events).body).toBe('hello world');
    expect('no_body_reason' in complete(events)).toBe(false);
  });

  it('captures a json response body by re-serializing the parsed response', () => {
    const { Xhr, events } = setup();
    const xhr = new Xhr();
    xhr.open('GET', 'u');
    xhr.send();
    xhr.responseType = 'json';
    xhr.response = { a: 1, b: 'x' };
    xhr.fire('load');
    expect(complete(events).body).toBe('{"a":1,"b":"x"}');
  });

  it('records cant_read_data for a json response that is not serializable (circular)', () => {
    const { Xhr, events } = setup();
    const xhr = new Xhr();
    xhr.open('GET', 'u');
    xhr.send();
    xhr.responseType = 'json';
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    xhr.response = circular;
    xhr.fire('load');
    expect(complete(events).no_body_reason).toBe('cant_read_data');
  });

  it('records cant_read_data for a json response of undefined', () => {
    const { Xhr, events } = setup();
    const xhr = new Xhr();
    xhr.open('GET', 'u');
    xhr.send();
    xhr.responseType = 'json';
    xhr.response = undefined;
    xhr.fire('load');
    expect(complete(events).no_body_reason).toBe('cant_read_data');
  });

  it('records cant_read_data for a binary/document responseType (arraybuffer)', () => {
    const { Xhr, events } = setup();
    const xhr = new Xhr();
    xhr.open('GET', 'u');
    xhr.send();
    xhr.responseType = 'arraybuffer';
    xhr.fire('load');
    expect(complete(events).no_body_reason).toBe('cant_read_data');
    expect('body' in complete(events)).toBe(false);
  });

  it('drops an over-cap response body as size_too_large', () => {
    const { Xhr, events } = setup({ maxBodyBytes: 5 });
    const xhr = new Xhr();
    xhr.open('GET', 'u');
    xhr.send();
    xhr.responseText = 'way too long';
    xhr.fire('load');
    expect(complete(events).no_body_reason).toBe('size_too_large');
    expect('body' in complete(events)).toBe(false);
  });

  it('does not read the response body when captureBodies is off', () => {
    const { Xhr, events } = setup({ captureBodies: false });
    const xhr = new Xhr();
    xhr.open('GET', 'u');
    xhr.send();
    xhr.responseText = 'secret response';
    xhr.fire('load');
    expect('body' in complete(events)).toBe(false);
    expect('no_body_reason' in complete(events)).toBe(false);
  });
});

describe('createXhrInterceptor — self-isolation & edges', () => {
  it('skips the SDK own requests (X-Bugsee-Internal) but still sends', () => {
    const { Xhr, events } = setup();
    const xhr = new Xhr();
    xhr.open('GET', 'u');
    xhr.setRequestHeader('X-Bugsee-Internal', '1');
    xhr.send('b');
    expect(xhr.sent).toEqual(['b']); // original send still called
    xhr.fire('load'); // no capture listeners attached
    expect(events).toEqual([]);
  });

  it('send without a prior open just calls through (no before)', () => {
    const { Xhr, events } = setup();
    const xhr = new Xhr();
    xhr.send('b');
    expect(events).toEqual([]);
    expect(xhr.sent).toEqual(['b']);
  });

  it('setRequestHeader without a prior open just calls through', () => {
    const { Xhr } = setup();
    const xhr = new Xhr();
    xhr.setRequestHeader('a', 'b');
    expect(xhr.reqHeaders).toEqual({ a: 'b' });
  });
});

describe('createXhrInterceptor — activation', () => {
  it('patches the prototype on activate and restores it on the last unsubscribe', () => {
    const Xhr = makeXhr();
    const origOpen = Xhr.prototype.open;
    const origSend = Xhr.prototype.send;
    const ic = createXhrInterceptor({ target: { get: () => Xhr } });
    const off = ic.onAny(() => {});
    expect(Xhr.prototype.open).not.toBe(origOpen);
    expect(Xhr.prototype.send).not.toBe(origSend);
    off();
    expect(Xhr.prototype.open).toBe(origOpen);
    expect(Xhr.prototype.send).toBe(origSend);
  });

  it('is a safe no-op when the target has no XMLHttpRequest', () => {
    const ic = createXhrInterceptor({ target: { get: () => undefined } });
    const off = ic.onAny(() => {});
    expect(() => off()).not.toThrow(); // activate + deactivate both safe with no ctor
  });

  it('defaults to the global XMLHttpRequest target (a no-op in a runtime without XHR)', () => {
    const ic = createXhrInterceptor(); // default globalXhrTarget → undefined in Node
    const off = ic.onAny(() => {});
    expect(() => off()).not.toThrow();
  });
});

describe('createXhrInterceptor — request decorators (the transformer seam)', () => {
  const setupD = () => {
    const Xhr = makeXhr();
    const target: XhrTarget = { get: () => Xhr };
    const ic = createXhrInterceptor({ now: () => 100, newId: () => 'x1', target });
    const events: Array<[NetworkStage, NetworkEvent]> = [];
    ic.onAny((stage, event) => events.push([stage, event])); // activate → patches the prototype
    return { Xhr, ic, events };
  };

  it('does NOT touch the outgoing request when no decorator is registered', () => {
    const { Xhr, events } = setupD();
    const xhr = new Xhr();
    xhr.open('get', 'https://api/x');
    xhr.setRequestHeader('authorization', 's');
    xhr.send();
    expect(xhr.reqHeaders).toEqual({ authorization: 's' }); // only the app header on the real request
    expect(events[0]?.[1].custom?.headers).toEqual({ authorization: 's' });
  });

  it('applies a decorator: sets the header on the real request AND the captured event (truthful capture)', () => {
    const { Xhr, ic, events } = setupD();
    ic.addRequestDecorator((req) => ({ traceparent: `00-${req.method}` }));
    const xhr = new Xhr();
    xhr.open('post', 'https://api/x');
    xhr.setRequestHeader('authorization', 's');
    xhr.send();
    expect(xhr.reqHeaders).toEqual({ authorization: 's', traceparent: '00-POST' }); // on the WIRE
    expect(events[0]?.[1].custom?.headers).toEqual({ authorization: 's', traceparent: '00-POST' }); // captured matches
  });

  it('passes the request url/method/headers to the decorator', () => {
    const { Xhr, ic } = setupD();
    const seen: unknown[] = [];
    ic.addRequestDecorator((req) => {
      seen.push({ url: req.url, method: req.method, headers: { ...req.headers } });
      return undefined;
    });
    const xhr = new Xhr();
    xhr.open('put', 'https://api/y');
    xhr.setRequestHeader('x', '1');
    xhr.send();
    expect(seen[0]).toEqual({ url: 'https://api/y', method: 'PUT', headers: { x: '1' } });
  });

  it('does NOT decorate the SDK’s own internal requests (X-Bugsee-Internal)', () => {
    const { Xhr, ic, events } = setupD();
    ic.addRequestDecorator(() => ({ traceparent: 'X' }));
    const xhr = new Xhr();
    xhr.open('get', 'https://api/x');
    xhr.setRequestHeader('x-bugsee-internal', '1');
    xhr.send();
    expect(xhr.reqHeaders).toEqual({ 'x-bugsee-internal': '1' }); // untouched (no traceparent)
    expect(events).toEqual([]); // internal → not captured
  });

  it('stops applying a decorator after unsubscribe', () => {
    const { Xhr, ic } = setupD();
    const off = ic.addRequestDecorator(() => ({ traceparent: 'X' }));
    off();
    const xhr = new Xhr();
    xhr.open('get', 'https://api/x');
    xhr.send();
    expect(xhr.reqHeaders).toEqual({}); // no traceparent
  });
});
