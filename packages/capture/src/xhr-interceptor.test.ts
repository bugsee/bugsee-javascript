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
    expect(events[0]?.[1].custom?.headers).toEqual({ authorization: 'secret' });
    expect(events[1]?.[1]).toMatchObject({ type: 'complete', status: 200, statusText: 'OK' });
    expect(events[1]?.[1].custom?.headers).toEqual({
      'content-type': 'application/json',
      'x-a': 'b',
    });
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
