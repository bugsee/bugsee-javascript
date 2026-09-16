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

// Every buffer node:crypto SHA-256-hashes, recorded by passing through to the real implementation. The
// upload checksum is not sent on the wire, so this is the only way to see node's injected digest run.
const nodeSha256Inputs = vi.hoisted((): Buffer[] => []);
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    createHash: (algorithm: string) => {
      const hash = actual.createHash(algorithm);
      if (algorithm !== 'sha256') return hash;
      const update = hash.update.bind(hash);
      return Object.assign(hash, {
        update: (data: Uint8Array) => {
          nodeSha256Inputs.push(Buffer.from(data));
          return update(data);
        },
      });
    },
  };
});

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
    expect(JSON.parse(session?.body.toString() ?? '{}').environment.runtime.type).toBe('node');
    expect(JSON.parse(issue?.body.toString() ?? '{}').summary).toBe('integration boom');

    // The signed PUT delivered the *.bundle.zip — a real zip starts with the "PK" local-file magic.
    const put = received.find((r) => r.url.endsWith('/upload'));
    expect(put?.method).toBe('PUT');
    expect(put?.headers['x-bugsee-internal']).toBe('1'); // self-isolation tag on the PUT
    expect(put?.body.subarray(0, 2).toString('latin1')).toBe('PK');
    expect(put?.body.length).toBeGreaterThan(0);
  });

  // The upload checksum across the node → core boundary. @bugsee/util's digest is WebCrypto-only, so on a
  // runtime without `crypto.subtle` (unflagged Node 18) the node launch must inject its node:crypto digest
  // into core's upload pipeline. The pipeline no longer fails an upload whose checksum cannot be computed,
  // so delivery alone proves nothing here: the tests watch node:crypto hash (or not hash) the PUT body.
  describe('upload checksum digest', () => {
    // A private dataDir per test: a bundle a failing run leaves staged must not be recovered into another test.
    let dataDir: string;
    beforeEach(() => {
      nodeSha256Inputs.length = 0;
      dataDir = mkdtempSync(join(tmpdir(), 'bugsee-digest-'));
    });
    const launchLoopback = () =>
      launch('app-token', {
        endpoint: origin,
        dataDir,
        process: fakeProcess(),
        captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
        captureNetwork: false,
        captureSystemEvents: false,
        systemMetricsSampler: () => [],
      });

    afterEach(() => {
      vi.unstubAllGlobals();
      rmSync(dataDir, { recursive: true, force: true });
    });

    it('hashes the bundle with node:crypto on a runtime with no WebCrypto (Node 18)', async () => {
      vi.stubGlobal('crypto', undefined);
      const client = launchLoopback();
      const result = await client.logException(new Error('no webcrypto'));
      await client.stop();

      expect(result.ok).toBe(true);
      const upload = received.filter((r) => r.url === '/upload');
      expect(upload).toHaveLength(1);
      expect(upload[0]?.method).toBe('PUT');
      expect(upload[0]?.body.subarray(0, 2).toString('latin1')).toBe('PK');
      // node:crypto hashed exactly the bytes that were PUT — the injected digest ran.
      expect(nodeSha256Inputs.some((input) => input.equals(upload[0]?.body as Buffer))).toBe(true);
    });

    it('keeps WebCrypto as the single hashing path when crypto.subtle exists (no injection)', async () => {
      const real = globalThis.crypto.subtle;
      const digests: Array<{ algorithm: string; bytes: Buffer }> = [];
      vi.stubGlobal('crypto', {
        subtle: {
          digest: (algorithm: string, data: Uint8Array) => {
            digests.push({ algorithm, bytes: Buffer.from(data) });
            return real.digest(algorithm, data as Uint8Array<ArrayBuffer>);
          },
        },
      });
      const client = launchLoopback();
      const result = await client.logException(new Error('webcrypto present'));
      await client.stop();

      expect(result.ok).toBe(true);
      const upload = received.filter((r) => r.url === '/upload');
      expect(upload).toHaveLength(1);
      // The PUT body is exactly what WebCrypto hashed: node:crypto was not substituted for it.
      expect(digests).toHaveLength(1);
      expect(digests[0]?.algorithm).toBe('SHA-256');
      expect(digests[0]?.bytes.equals(upload[0]?.body as Buffer)).toBe(true);
      expect(nodeSha256Inputs.some((input) => input.equals(upload[0]?.body as Buffer))).toBe(false);
    });
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
        source: { type: 'crash', mechanism: 'uncaught' },
        created_on: '2026-05-29T00:00:00Z',
        environment: {
          platform: { type: 'node', version: '1' },
          runtime: { type: 'node', version: '' },
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

  // A control-plane server whose answer the test chooses. `hits` records every path it saw.
  const controlPlane = async (answer: (url: string) => { status: number; body?: unknown }) => {
    const hits: string[] = [];
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      req.on('data', () => {});
      req.on('end', () => {
        const url = req.url ?? '';
        hits.push(url);
        const { status, body } = answer(url);
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body === undefined ? '' : JSON.stringify(body));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    return {
      hits,
      origin: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      close: () => new Promise<void>((resolve) => server.close(() => resolve())),
    };
  };

  // An HTTP status on the control plane is a verdict about the REQUEST; only the collector's own error
  // code is a verdict about the app token. This SDK used to read a 401 or a 403 out of `/v2/sessions` as
  // "the app token is invalid" and enter the permanent kill state — capture and detection stopped,
  // `launch()` a no-op for the life of the process — so one bad minute at an edge proxy silently ended
  // recording. `transport.ts` asserts, as the Android parity target, that 401 is RETRYABLE, and Android
  // agrees: session expiry, retried (`BugseeCommunicationManager.java:614-635`).
  it.each([
    401, 403,
  ])('keeps recording when the real transport gets HTTP %i on /v2/sessions', async (status) => {
    const server = await controlPlane((url) =>
      url.endsWith('/v2/sessions') ? { status } : { status: 200 },
    );
    const onError = vi.fn();
    try {
      const client = launch('tok', {
        endpoint: server.origin,
        process: fakeProcess(),
        captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
        captureNetwork: false,
        captureSystemEvents: false,
        systemMetricsSampler: () => [],
        onError,
      });
      // NOT awaited: the report is now mid-retry-ladder behind exponential backoff, which is exactly
      // the point — it is being retried rather than abandoned.
      void client.logException(new Error('boom'));
      await vi.waitFor(() =>
        expect(server.hits.filter((u) => u.endsWith('/v2/sessions')).length).toBeGreaterThan(0),
      );
      expect(client.isLaunched()).toBe(true); // still capturing
      expect(onError).not.toHaveBeenCalled(); // no kill-state notification
      await client.stop(0);
    } finally {
      await server.close();
    }
  });

  // …and the one thing that DOES disable the SDK: the collector's KILL_SDK code. It arrives inside an
  // HTTP 200 envelope, which is why a status can never stand in for it (Android blacklists an app token
  // here and nowhere else, `BugseeCommunicationManager.java:776-781`).
  it('enters the kill-state on the collector KILL_SDK code (99099), which arrives with HTTP 200', async () => {
    const server = await controlPlane((url) =>
      url.endsWith('/v2/sessions')
        ? {
            status: 200,
            body: { ok: false, error: { type: 'KillSdkError', message: 'off', code: 99099 } },
          }
        : { status: 200 },
    );
    const onError = vi.fn();
    try {
      const client = launch('killed-token', {
        endpoint: server.origin,
        process: fakeProcess(),
        captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
        captureNetwork: false,
        captureSystemEvents: false,
        systemMetricsSampler: () => [],
        onError,
      });
      expect(await client.logException(new Error('boom'))).toMatchObject({
        ok: false,
        permanent: true, // …and the bundle is dropped, not re-sent at every launch forever
      });
      expect(onError).toHaveBeenCalledTimes(1);
      expect(client.isLaunched()).toBe(false); // killed

      const sessionsBefore = server.hits.filter((u) => u.endsWith('/v2/sessions')).length;
      expect(await client.logException(new Error('again'))).toEqual({ ok: false }); // no-op
      expect(server.hits.filter((u) => u.endsWith('/v2/sessions')).length).toBe(sessionsBefore);
      expect(server.hits.some((u) => u.endsWith('/v2/issues'))).toBe(false); // never got past auth
    } finally {
      await server.close();
    }
  });
});
