import http, { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NetworkEvent } from '@bugsee/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createNodeHttpInterceptor } from './http-interceptor';

// Real node:http integration for the interceptor. The unit tests use a fake target whose `get` is an
// independent fn, so they cannot exercise the real-world subtlety the impl relies on: node's
// http.get calls its lexically-scoped request (NOT the patched exports.request), so wrapping BOTH
// request and get must not double-capture. This drives a genuine http.get against a loopback server
// and asserts exactly one before + one complete.

describe('createNodeHttpInterceptor — real node:http', () => {
  let server: Server;
  let origin: string;

  beforeEach(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('captures a real http.get exactly once (wrapping request + get never double-captures)', async () => {
    const interceptor = createNodeHttpInterceptor(); // default target = the real node:http/https
    const events: NetworkEvent[] = [];
    interceptor.onAny((_stage, event) => events.push(event as NetworkEvent));
    interceptor.start(); // patches the real node:http request + get

    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`${origin}/x`, (res) => {
          res.on('data', () => {});
          res.on('end', () => resolve());
        });
        req.on('error', reject);
      });
      await new Promise((resolve) => setImmediate(resolve)); // let the 'response' listener settle
    } finally {
      interceptor.stop(); // restore the real node:http
    }

    // Exactly one metadata before + one metadata complete (the `ok` response body adds a `complete`
    // OVERRIDE amendment — that is the F.4b body capture, not a double-capture of the request).
    expect(events.filter((e) => e.type === 'before' && !e.override)).toHaveLength(1);
    expect(events.filter((e) => e.type === 'complete' && !e.override)).toHaveLength(1);
    const before = events.find((e) => e.type === 'before');
    expect(before?.mechanism).toBe('http');
    expect(before?.method).toBe('GET');
    expect(before?.url).toBe(`${origin}/x`);
    expect(events.find((e) => e.type === 'complete' && !e.override)?.status).toBe(200);
    expect(events.find((e) => e.override && e.type === 'complete')?.custom?.body).toBe('ok');
  });

  it('captures a real POST request body via write/end patching (override amendment, passthrough)', async () => {
    const received: string[] = [];
    server.removeAllListeners('request');
    server.on('request', (req, res) => {
      req.on('data', (c) => received.push(String(c))); // the server still receives the full body
      req.on('end', () => {
        res.writeHead(200);
        res.end('ok');
      });
    });
    const interceptor = createNodeHttpInterceptor({ newId: () => 'h1' });
    const events: NetworkEvent[] = [];
    interceptor.onAny((_stage, event) => events.push(event as NetworkEvent));
    interceptor.start();
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          `${origin}/x`,
          { method: 'POST', headers: { 'content-type': 'text/plain' } },
          (res) => {
            res.on('data', () => {});
            res.on('end', () => resolve());
          },
        );
        req.on('error', reject);
        req.write('hello ');
        req.end('world');
      });
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      interceptor.stop();
    }
    // the SDK captured the request body as an override amendment...
    const amendment = events.find((e) => e.override === true);
    expect(amendment?.type).toBe('before');
    expect(amendment?.custom?.body).toBe('hello world');
    // ...and the server still received the unaltered body (pass-through, no app-behavior change)
    expect(received.join('')).toBe('hello world');
  });

  it('captures a real response body via push observation (client still receives it via on(data))', async () => {
    server.removeAllListeners('request');
    server.on('request', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('response-payload');
    });
    const interceptor = createNodeHttpInterceptor();
    const events: NetworkEvent[] = [];
    interceptor.onAny((_stage, event) => events.push(event as NetworkEvent));
    interceptor.start();
    let clientBody = '';
    try {
      await new Promise<void>((resolve, reject) => {
        const req = http.get(`${origin}/x`, (res) => {
          res.setEncoding('utf8');
          res.on('data', (c) => {
            clientBody += c;
          });
          res.on('end', () => resolve());
        });
        req.on('error', reject);
      });
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      interceptor.stop();
    }
    const amendment = events.find((e) => e.override === true && e.type === 'complete');
    expect(amendment?.custom?.body).toBe('response-payload'); // SDK observed it via push
    expect(clientBody).toBe('response-payload'); // the app still received the full body
  });

  it('does not break a paused-mode async-iterating response consumer (the flowing-mode hazard)', async () => {
    server.removeAllListeners('request');
    // A LARGE body + a delay before iterating: a naive res.on('data') observer forces flowing mode at
    // 'response' time, so the body drains into the void before the delayed `for await` starts and the
    // app loses bytes. The push observer never changes the mode, so the app receives all of it.
    const big = 'x'.repeat(100_000);
    server.on('request', (_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(big);
    });
    const interceptor = createNodeHttpInterceptor({ maxBodyBytes: 200_000 });
    const events: NetworkEvent[] = [];
    interceptor.onAny((_stage, event) => events.push(event as NetworkEvent));
    interceptor.start();
    let clientBody = '';
    try {
      const res = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        const req = http.get(`${origin}/x`, resolve);
        req.on('error', reject);
      });
      // Delay so a (hypothetical) flowing-mode observer would have already drained+lost the body.
      await new Promise((resolve) => setTimeout(resolve, 30));
      // Consume in PAUSED mode via async iteration — the push observer must not have stolen these chunks.
      for await (const chunk of res) {
        clientBody += String(chunk);
      }
      await new Promise((resolve) => setImmediate(resolve));
    } finally {
      interceptor.stop();
    }
    expect(clientBody).toBe(big); // app's async iteration received the FULL body (no flow-mode theft)
    const amendment = events.find((e) => e.override === true && e.type === 'complete');
    expect(amendment?.custom?.body).toBe(big); // and the SDK still captured it
  });
});
