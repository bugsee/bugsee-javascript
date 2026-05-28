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

    expect(events.filter((e) => e.type === 'before')).toHaveLength(1);
    expect(events.filter((e) => e.type === 'complete')).toHaveLength(1);
    const before = events.find((e) => e.type === 'before');
    expect(before?.mechanism).toBe('http');
    expect(before?.method).toBe('GET');
    expect(before?.url).toBe(`${origin}/x`);
    expect(events.find((e) => e.type === 'complete')?.status).toBe(200);
  });
});
