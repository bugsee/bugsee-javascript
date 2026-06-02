import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFetchTransport, type FetchLike, fetchTransport } from './fetch-transport';

// Injection-first: every edge is reached through a fake `fetch` (no network, no DOM env). A fake
// returns a real `Response` (available as a Node global) so header/body decoding runs for real.
const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('createFetchTransport', () => {
  it('performs a GET (default method) and returns status, headers and the body bytes', async () => {
    let seenUrl = '';
    let seenInit: RequestInit | undefined;
    const fake: FetchLike = (url, init) => {
      seenUrl = url;
      seenInit = init;
      return Promise.resolve(new Response('hello', { status: 200, headers: { 'X-Demo': 'yes' } }));
    };
    const out = await createFetchTransport(fake)('https://x.test/path');
    expect(seenUrl).toBe('https://x.test/path');
    expect(seenInit?.method).toBe('GET');
    expect(out.status).toBe(200);
    expect(out.headers['x-demo']).toBe('yes'); // Headers lowercases keys.
    expect(text(out.body)).toBe('hello');
  });

  it('sends the method and a string request body', async () => {
    let seenInit: RequestInit | undefined;
    const fake: FetchLike = (_url, init) => {
      seenInit = init;
      return Promise.resolve(new Response('ok'));
    };
    await createFetchTransport(fake)('https://x.test', { method: 'POST', body: '{"a":1}' });
    expect(seenInit?.method).toBe('POST');
    expect(seenInit?.body).toBe('{"a":1}');
  });

  it('passes a Uint8Array body verbatim', async () => {
    let seenBody: BodyInit | null | undefined;
    const bytes = new Uint8Array([1, 2, 3]);
    const fake: FetchLike = (_url, init) => {
      seenBody = init?.body;
      return Promise.resolve(new Response());
    };
    await createFetchTransport(fake)('https://x.test', { method: 'PUT', body: bytes });
    expect(seenBody).toBe(bytes); // the exact reference, not a copy
  });

  it('forwards caller headers', async () => {
    let seenHeaders: HeadersInit | undefined;
    const fake: FetchLike = (_url, init) => {
      seenHeaders = init?.headers;
      return Promise.resolve(new Response());
    };
    await createFetchTransport(fake)('https://x.test', { headers: { 'X-App-Token': 'tok123' } });
    expect(seenHeaders).toEqual({ 'X-App-Token': 'tok123' });
  });

  it('lowercases response header keys', async () => {
    const fake: FetchLike = () =>
      Promise.resolve(new Response('', { headers: { 'Content-Type': 'application/json' } }));
    const out = await createFetchTransport(fake)('https://x.test');
    expect(out.headers['content-type']).toBe('application/json');
  });

  it('returns a non-2xx status without rejecting', async () => {
    const fake: FetchLike = () => Promise.resolve(new Response('nope', { status: 404 }));
    const out = await createFetchTransport(fake)('https://x.test');
    expect(out.status).toBe(404);
    expect(text(out.body)).toBe('nope');
  });

  it('returns an empty Uint8Array for an empty body', async () => {
    const fake: FetchLike = () => Promise.resolve(new Response(null, { status: 204 }));
    const out = await createFetchTransport(fake)('https://x.test');
    expect(out.body).toBeInstanceOf(Uint8Array);
    expect(out.body.length).toBe(0);
  });

  it('rejects (without rewriting the error) when the network fails', async () => {
    const boom = new Error('network down');
    const fake: FetchLike = () => Promise.reject(boom);
    await expect(createFetchTransport(fake)('https://x.test')).rejects.toThrow('network down');
  });

  it('rejects with a timed-out error when the request exceeds timeoutMs', async () => {
    vi.useFakeTimers();
    // A fetch that never resolves on its own; it only rejects when the abort signal fires.
    const hanging: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    const promise = createFetchTransport(hanging)('https://slow.test', { timeoutMs: 50 });
    const assertion = expect(promise).rejects.toThrow(/timed out after 50ms/);
    await vi.advanceTimersByTimeAsync(50);
    await assertion;
  });

  it('does not fire the timeout for a request that completes in time', async () => {
    vi.useFakeTimers();
    const fake: FetchLike = () => Promise.resolve(new Response('done'));
    const out = await createFetchTransport(fake)('https://x.test', { timeoutMs: 1000 });
    expect(text(out.body)).toBe('done');
    // The deadline timer was cleared on success (no leaked pending timer).
    expect(vi.getTimerCount()).toBe(0);
    // Advancing past the deadline must NOT produce a late rejection.
    await vi.advanceTimersByTimeAsync(2000);
    expect(out.status).toBe(200);
  });
});

describe('fetchTransport (default, over globalThis.fetch)', () => {
  it('delegates to globalThis.fetch when no fetch is injected', async () => {
    const globalFetch = vi.fn(() => Promise.resolve(new Response('global')));
    vi.stubGlobal('fetch', globalFetch);
    const out = await fetchTransport('https://x.test');
    expect(globalFetch).toHaveBeenCalledTimes(1);
    expect(text(out.body)).toBe('global');
  });
});
