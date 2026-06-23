import http from 'node:http';
import https from 'node:https';
import type { AddressInfo } from 'node:net';
import type { BugseeClient } from '@bugsee/core';
import type { Transaction } from '@bugsee/performance';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHttpServerInterceptor, type HttpServerInterceptor } from './http-server-interceptor';
import { createNodeRequestContextStore, type RequestContextStore } from './request-context-store';
import { getActiveServerSpan } from './server-instrument';

// Integration: the REAL node:http Server, instrumented via the REAL http.Server.prototype.emit patch (no
// injected target — exercises the production wiring). Proves context is active in the handler, the txn
// finishes on the response, concurrent + keep-alive requests stay isolated (run-scoping), a client abort
// is CANCELLED, and uninstall restores the pristine prototype.

const fakeTxn = (): Transaction =>
  ({
    getTraceId: () => 'trace-1',
    getSpanId: () => 'span-1',
    isSampled: () => true,
    isFinished: vi.fn(() => false),
    setName: vi.fn(),
    setAttribute: vi.fn(),
    finish: vi.fn(),
  }) as unknown as Transaction;

const finishedWith = (t: Transaction | undefined, outcome: string): boolean =>
  t !== undefined &&
  (t.finish as unknown as { mock: { calls: unknown[][] } }).mock.calls.some(
    (c) => c[0] === outcome,
  );

const until = async (pred: () => boolean, timeoutMs = 2000): Promise<void> => {
  for (let waited = 0; !pred(); waited += 10) {
    if (waited > timeoutMs) {
      throw new Error('until() timed out');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
};

let store: RequestContextStore;
let txns: Transaction[];
let interceptor: HttpServerInterceptor;
let client: BugseeClient;
const servers: http.Server[] = [];

beforeEach(() => {
  store = createNodeRequestContextStore();
  txns = [];
  const startTransaction = vi.fn(() => {
    const t = fakeTxn();
    txns.push(t);
    return t;
  });
  client = {
    getServiceProvider: () => ({ getImmediate: () => store }),
    ext: () => ({ startTransaction }),
    logException: vi.fn(() => Promise.resolve()),
  } as unknown as BugseeClient;
  interceptor = createHttpServerInterceptor({ getClient: () => client });
  interceptor.install();
});

afterEach(async () => {
  interceptor.uninstall();
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

const serve = async (
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<number> => {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
};

const get = (
  port: number,
  path: string,
  agent?: http.Agent,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> =>
  new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, ...(agent ? { agent } : {}) }, (res) => {
      let body = '';
      res.on('data', (c) => {
        body += c;
      });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
  });

describe('http-server-interceptor (real node:http)', () => {
  it('instruments a real request: context active in the handler, txn finishes OK', async () => {
    let ctxId: string | undefined;
    const port = await serve((_req, res) => {
      ctxId = store.getCurrent()?.contextId;
      res.statusCode = 201;
      res.end('ok');
    });
    const r = await get(port, '/widgets/42?q=1');
    expect(r.body).toBe('ok');
    expect(r.status).toBe(201);
    expect(ctxId).toBeDefined(); // context was active inside the handler
    await until(() => finishedWith(txns[0], 'OK'));
    expect(txns).toHaveLength(1); // exactly one txn — txns[0] IS this request's
    expect(txns[0]?.setName).toHaveBeenCalledWith('GET /widgets/42'); // query stripped
    expect(txns[0]?.setAttribute).toHaveBeenCalledWith('http.status_code', 201);
  });

  it('finishes a real 5xx response as ERROR', async () => {
    const port = await serve((_req, res) => {
      res.statusCode = 500;
      res.end('boom');
    });
    await get(port, '/fail');
    await until(() => finishedWith(txns[0], 'ERROR'));
    expect(txns).toHaveLength(1);
    expect(txns[0]?.setAttribute).toHaveBeenCalledWith('http.status_code', 500);
  });

  it("a refiner's route set on 'finish' lands in the txn name (owner finishes on 'close', after)", async () => {
    const port = await serve((_req, res) => {
      // a dedicated adapter would refine the route on res 'finish' — which fires BEFORE the owner's 'close'.
      res.on('finish', () =>
        getActiveServerSpan({ getClient: () => client })?.setRoute('/widgets/:id'),
      );
      res.end('ok');
    });
    await get(port, '/widgets/42');
    await until(() => finishedWith(txns[0], 'OK'));
    expect(txns).toHaveLength(1);
    expect(txns[0]?.setName).toHaveBeenCalledWith('GET /widgets/:id'); // refined route in the finished name
  });

  it('isolates concurrent in-flight requests — distinct contexts, each stable across an await', async () => {
    const seen: Array<{ before?: string; after?: string }> = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const port = await serve(async (_req, res) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const before = store.getCurrent()?.contextId;
      await new Promise((r) => setTimeout(r, 40));
      const after = store.getCurrent()?.contextId;
      inFlight -= 1;
      seen.push({ before, after });
      res.end('ok');
    });
    await Promise.all([get(port, '/a'), get(port, '/b')]);
    expect(maxInFlight).toBe(2); // the two requests were genuinely in-flight at the same time
    expect(seen).toHaveLength(2);
    for (const s of seen) {
      expect(s.before).toBeDefined();
      expect(s.before).toBe(s.after); // context survives the await within a request
    }
    expect(seen[0]?.before).not.toBe(seen[1]?.before); // the two requests had distinct contexts
  });

  it('does not leak context across keep-alive requests on one socket', async () => {
    const ids: Array<string | undefined> = [];
    let connections = 0;
    const server = http.createServer((_req, res) => {
      ids.push(store.getCurrent()?.contextId);
      res.end('ok');
    });
    server.on('connection', () => {
      connections += 1;
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = (server.address() as AddressInfo).port;
    const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
    await get(port, '/1', agent);
    await get(port, '/2', agent);
    agent.destroy();
    expect(connections).toBe(1); // both requests reused ONE socket — the leak-test is meaningful
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBeDefined();
    expect(ids[1]).toBeDefined();
    expect(ids[0]).not.toBe(ids[1]); // distinct per request on the reused socket (run-scoping reverts)
  });

  it('marks a client-aborted request CANCELLED', async () => {
    const port = await serve(() => {
      // never respond — hold the request open so the client can abort it
    });
    const req = http.get({ host: '127.0.0.1', port, path: '/slow' });
    req.on('error', () => {}); // swallow the abort error
    await until(() => txns.length > 0); // server received the request + opened a txn
    req.destroy(); // client abort
    await until(() => finishedWith(txns[0], 'CANCELLED'));
    expect(txns).toHaveLength(1); // one txn — txns[0] IS the aborted request's
    expect(finishedWith(txns[0], 'CANCELLED')).toBe(true);
    expect(finishedWith(txns[0], 'OK')).toBe(false);
  });

  it('writes the BE→FE return headers onto a REAL response when traceResponse is opted in (X4)', async () => {
    // Swap the default interceptor for one with traceResponse on (afterEach uninstalls whatever `interceptor` is).
    interceptor.uninstall();
    interceptor = createHttpServerInterceptor({
      getClient: () => client,
      traceResponse: {
        traceresponse: true,
        serverTiming: true,
        // F0: also emit the CORS-exposure headers so a cross-origin FE can READ the two above.
        timingAllowOrigin: '*',
        exposeTraceresponse: true,
      },
    });
    interceptor.install();
    const port = await serve((_req, res) => {
      res.statusCode = 200;
      res.end('ok');
    });
    const { headers } = await get(port, '/x');
    // The real http.Server.prototype.emit patch wrote them before the handler flushed the response.
    expect(headers.traceresponse).toBe('00-trace-1-span-1-01');
    expect(headers['server-timing']).toBe('traceparent;desc="00-trace-1-span-1-01"');
    // F0 cross-origin exposure on a REAL response.
    expect(headers['timing-allow-origin']).toBe('*');
    expect(headers['access-control-expose-headers']).toBe('traceresponse');
  });

  it('uninstall restores the pristine http.Server.prototype (no own emit)', () => {
    expect(Object.hasOwn(http.Server.prototype, 'emit')).toBe(true); // patched in beforeEach
    interceptor.uninstall();
    expect(Object.hasOwn(http.Server.prototype, 'emit')).toBe(false); // deleted → inherited
    expect(Object.hasOwn(https.Server.prototype, 'emit')).toBe(false); // https too
    interceptor.install(); // re-install so afterEach's uninstall is balanced
  });
});
