import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import { deflateSync, gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { httpRequest, transportFor } from './http-request';

// Real loopback server per test — deterministic, no mocking. The handler is swapped per test.
let server: http.Server | undefined;
let handler: http.RequestListener = (_req, res) => res.end();

async function listen(): Promise<string> {
  server = http.createServer((req, res) => handler(req, res));
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

function setHandler(h: http.RequestListener): void {
  handler = h;
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

afterEach(async () => {
  handler = (_req, res) => res.end();
  if (server) {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
  }
});

describe('transportFor', () => {
  it('selects the https module for https: URLs', () => {
    expect(transportFor('https:')).toBe(https);
  });
  it('selects the http module for http: (and anything else)', () => {
    expect(transportFor('http:')).toBe(http);
  });
});

describe('httpRequest', () => {
  it('performs a GET (default method) and returns status, headers and the body bytes', async () => {
    let seenMethod = '';
    setHandler((req, res) => {
      seenMethod = req.method ?? '';
      res.setHeader('x-demo', 'yes');
      res.statusCode = 200;
      res.end('hello');
    });
    const base = await listen();
    const out = await httpRequest(base);
    expect(seenMethod).toBe('GET');
    expect(out.status).toBe(200);
    expect(out.headers['x-demo']).toBe('yes');
    expect(Buffer.from(out.body).toString()).toBe('hello');
  });

  it('sends the method and request body', async () => {
    let seenMethod = '';
    let seenBody = '';
    setHandler(async (req, res) => {
      seenMethod = req.method ?? '';
      seenBody = (await readBody(req)).toString();
      res.end('ok');
    });
    const base = await listen();
    await httpRequest(base, { method: 'POST', body: '{"a":1}' });
    expect(seenMethod).toBe('POST');
    expect(seenBody).toBe('{"a":1}');
  });

  it('sends a Uint8Array body verbatim', async () => {
    let seen: Buffer = Buffer.alloc(0);
    setHandler(async (req, res) => {
      seen = await readBody(req);
      res.end();
    });
    const base = await listen();
    await httpRequest(base, { method: 'PUT', body: new Uint8Array([1, 2, 3]) });
    expect([...seen]).toEqual([1, 2, 3]);
  });

  it('forwards caller headers', async () => {
    let seen: string | undefined;
    setHandler((req, res) => {
      seen = req.headers['x-app-token'] as string;
      res.end();
    });
    const base = await listen();
    await httpRequest(base, { headers: { 'X-App-Token': 'tok123' } });
    expect(seen).toBe('tok123');
  });

  it('sets a default accept-encoding of "gzip, deflate"', async () => {
    let seen: string | undefined;
    setHandler((req, res) => {
      seen = req.headers['accept-encoding'] as string;
      res.end();
    });
    const base = await listen();
    await httpRequest(base);
    expect(seen).toBe('gzip, deflate');
  });

  it('does not override a caller-supplied accept-encoding (case-insensitive)', async () => {
    let seen: string | undefined;
    setHandler((req, res) => {
      seen = req.headers['accept-encoding'] as string;
      res.end();
    });
    const base = await listen();
    await httpRequest(base, { headers: { 'Accept-Encoding': 'identity' } });
    expect(seen).toBe('identity');
  });

  it('decompresses a gzip-encoded response', async () => {
    setHandler((_req, res) => {
      res.setHeader('content-encoding', 'gzip');
      res.end(gzipSync(Buffer.from('compressed-payload')));
    });
    const base = await listen();
    const out = await httpRequest(base);
    expect(Buffer.from(out.body).toString()).toBe('compressed-payload');
  });

  it('decompresses a deflate-encoded response', async () => {
    setHandler((_req, res) => {
      res.setHeader('content-encoding', 'deflate');
      res.end(deflateSync(Buffer.from('deflated-payload')));
    });
    const base = await listen();
    const out = await httpRequest(base);
    expect(Buffer.from(out.body).toString()).toBe('deflated-payload');
  });

  it('returns a non-2xx status without rejecting', async () => {
    setHandler((_req, res) => {
      res.statusCode = 404;
      res.end('nope');
    });
    const base = await listen();
    const out = await httpRequest(base);
    expect(out.status).toBe(404);
    expect(Buffer.from(out.body).toString()).toBe('nope');
  });

  it('rejects when the connection is refused', async () => {
    const base = await listen();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    server = undefined;
    await expect(httpRequest(base, { timeoutMs: 1000 })).rejects.toThrow();
  });

  it('rejects when the request times out', async () => {
    setHandler(() => {
      /* never responds */
    });
    const base = await listen();
    await expect(httpRequest(base, { timeoutMs: 50 })).rejects.toThrow(/timed out/);
  });

  it('rejects when the server destroys the socket mid-response', async () => {
    setHandler((_req, res) => {
      res.writeHead(200, { 'content-length': '100' });
      res.write('partial');
      res.socket?.destroy();
    });
    const base = await listen();
    await expect(httpRequest(base, { timeoutMs: 1000 })).rejects.toThrow();
  });

  it('settles once when a timeout aborts an in-flight response (request + response both error)', async () => {
    setHandler((_req, res) => {
      res.writeHead(200);
      res.write('partial'); // headers + partial body, then never end -> client timeout destroys it
    });
    const base = await listen();
    await expect(httpRequest(base, { timeoutMs: 50 })).rejects.toThrow();
  });

  it('rejects when the response body cannot be decoded', async () => {
    setHandler((_req, res) => {
      res.setHeader('content-encoding', 'gzip');
      res.end(Buffer.from('not actually gzip'));
    });
    const base = await listen();
    await expect(httpRequest(base)).rejects.toThrow();
  });
});
