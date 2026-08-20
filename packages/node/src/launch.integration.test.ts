import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createMemoryCaptureStore, serializeBundle } from '@bugsee/core';
import { createNodeBundleStore } from '@bugsee/node-utils';
import { type RequestJson, Severity } from '@bugsee/protocol';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { launch, type NodeRuntime } from './launch';

// End-to-end integration: launch the real Node SDK against a loopback HTTP server and verify the
// full pipeline — manual capture → assemble → REAL node:http transport → session/issue/signed PUT —
// delivers a zip bundle. Unlike launch.test.ts (fake transport), this exercises the actual
// node-utils httpRequest spine and the bundle zip. No mocking of the network.

interface Received {
  method: string;
  url: string;
  headers: NodeJS.Dict<string | string[]>;
  body: Buffer;
}

// A minimal Bugsee control plane + signed-upload sink on loopback. The issue endpoint points the
// signed PUT back at this same server (/upload), so the whole 3-call flow stays local.
function startServer(): Promise<{ server: Server; origin: string; received: Received[] }> {
  const received: Received[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const url = req.url ?? '';
      received.push({
        method: req.method ?? '',
        url,
        headers: req.headers,
        body: Buffer.concat(chunks),
      });
      const json = (obj: unknown): void => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      // The REAL collector envelopes every /v2 response as `{ ok, result }` and names the ids in
      // snake_case (verified against apidev.bugsee.com). This loopback stands in for it, so it has to
      // speak the server's contract rather than the SDK's assumption about it.
      if (url.endsWith('/v2/sessions')) {
        json({ ok: true, result: { access_token: 'access-token' } });
      } else if (url.endsWith('/v2/issues')) {
        const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        json({
          ok: true,
          result: {
            _id: 'issue-1',
            issue_id: 'issue-1',
            recording_id: 'rec-1',
            endpoint: `${origin}/upload`,
          },
        });
      } else {
        res.writeHead(200);
        res.end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      resolve({ server, origin, received });
    });
  });
}

const fakeProcess = (): NodeRuntime => ({
  on() {
    return undefined;
  },
  off() {
    return undefined;
  },
  exit() {},
});

describe('launch — loopback end-to-end', () => {
  let server: Server;
  let origin: string;
  let received: Received[];

  beforeEach(async () => {
    ({ server, origin, received } = await startServer());
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    vi.restoreAllMocks();
    // These launches use the default (real globalThis) carrier; reset it so interceptor singletons
    // don't leak across tests/files.
    delete (globalThis as { __BUGSEE__?: unknown }).__BUGSEE__;
  });

  it('delivers a zip bundle through the real transport: session → issue → signed PUT', async () => {
    const client = launch('app-token', {
      endpoint: origin,
      process: fakeProcess(),
      captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
      captureNetwork: false, // don't patch the global fetch/node:http during the test
      captureSystemEvents: false,
      systemMetricsSampler: () => [],
    });

    client.event('checkout', { step: 3 }); // capture an entry so a non-empty store is assembled
    const result = await client.logException(new Error('integration boom'));
    await client.stop();

    expect(result.ok).toBe(true);
    expect(result.issueId).toBe('issue-1');

    // The control plane saw a session then an issue create, and the issue body carried the error.
    const session = received.find((r) => r.url.endsWith('/v2/sessions'));
    const issue = received.find((r) => r.url.endsWith('/v2/issues'));
    expect(session?.method).toBe('POST');
    expect(JSON.parse(session?.body.toString() ?? '{}').environment.platform.type).toBe('node');
    expect(JSON.parse(issue?.body.toString() ?? '{}').summary).toBe('integration boom');

    // The signed PUT delivered the *.bundle.zip — a real zip starts with the "PK" local-file magic.
    const put = received.find((r) => r.url.endsWith('/upload'));
    expect(put?.method).toBe('PUT');
    expect(put?.headers['x-bugsee-internal']).toBe('1'); // self-isolation tag on the PUT
    expect(put?.body.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(put?.body.length).toBeGreaterThan(0);
  });

  it('recovers a bundle a prior run persisted to disk and re-uploads it through the real transport', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'bugsee-recover-'));
    try {
      // Simulate the leftover from a prior crashed run: a serialized bundle in a DEAD sibling instance's
      // subtree (<dataDir>/<priorInstanceId>/pending). The live launch's coordinator recovers it.
      const priorSub = join(dir, '9-9-prior');
      const request: RequestJson = {
        type: 'crash',
        summary: 'prior-run crash',
        severity: Severity.Blocker,
        source: { mechanism: 'uncaught' },
        created_on: '2026-05-29T00:00:00Z',
        environment: {
          platform: { type: 'node', version: '1' },
          sdk: { version: '0', type: 'javascript' },
        },
      };
      mkdirSync(priorSub, { recursive: true });
      writeFileSync(
        join(priorSub, 'owner.json'),
        JSON.stringify({
          instanceId: '9-9-prior',
          pid: 999_999,
          threadId: 0,
          startedAt: Date.now(), // a RECENT crash: within the TTL, so the hygiene sweep keeps it for recovery
          version: '0',
        }),
      );
      const queue = createNodeBundleStore(join(priorSub, 'pending'));
      queue.put(
        'crash-1',
        serializeBundle({ request, body: new Uint8Array([1, 2, 3]), fileName: 'p.zip' }),
      );

      const client = launch('app-token', {
        endpoint: origin,
        process: fakeProcess(),
        dataDir: dir, // the coordinator recovers the dead sibling's queue on launch
        captureNetwork: false,
        captureSystemEvents: false,
        systemMetricsSampler: () => [],
      });
      await client.stop(); // flush awaits the recovery re-upload (it's in the upload pipeline)

      const issue = received.find((r) => r.url.endsWith('/v2/issues'));
      expect(JSON.parse(issue?.body.toString() ?? '{}').summary).toBe('prior-run crash');
      expect(received.find((r) => r.url.endsWith('/upload'))?.method).toBe('PUT');
      expect(queue.list()).toEqual([]); // confirmed re-uploaded → durable copy removed from disk
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('enters the kill-state when the real transport gets 401 on /v2/sessions (invalid app token)', async () => {
    // A loopback server that rejects the app token on session create.
    const hits: string[] = [];
    const authServer = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.on('data', () => {});
      req.on('end', () => {
        hits.push(req.url ?? '');
        res.writeHead((req.url ?? '').endsWith('/v2/sessions') ? 401 : 200);
        res.end();
      });
    });
    await new Promise<void>((resolve) => authServer.listen(0, '127.0.0.1', resolve));
    const authOrigin = `http://127.0.0.1:${(authServer.address() as AddressInfo).port}`;
    const onError = vi.fn();
    try {
      const client = launch('bad-token', {
        endpoint: authOrigin,
        process: fakeProcess(),
        captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
        captureNetwork: false,
        captureSystemEvents: false,
        systemMetricsSampler: () => [],
        onError,
      });
      await client.logException(new Error('boom')); // real transport → 401 sessions → fatal → kill
      expect(onError).toHaveBeenCalledTimes(1);
      expect(client.isLaunched()).toBe(false); // killed

      const sessionsBefore = hits.filter((u) => u.endsWith('/v2/sessions')).length;
      expect(await client.logException(new Error('again'))).toEqual({ ok: false }); // no-op
      expect(hits.filter((u) => u.endsWith('/v2/sessions')).length).toBe(sessionsBefore); // no new call
      expect(hits.some((u) => u.endsWith('/v2/issues'))).toBe(false); // never got past auth
    } finally {
      await new Promise<void>((resolve) => authServer.close(() => resolve()));
    }
  });
});
