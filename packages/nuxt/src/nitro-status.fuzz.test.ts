// Property-based (fast-check) audit of the H3-status triage that decides whether a Nitro error becomes a
// Bugsee incident — and a DIFFERENTIAL check that the node and edge bridges still agree.
//
// `isExpectedClientError` exists twice on purpose: `nitro.ts` cannot be imported by `nitro-edge.ts` (it
// would drag `bugsee/node` into a workerd bundle), so the edge copy is a hand-duplicated function. Duplicated
// logic drifts, and a drift here is invisible: the edge server just stops reporting a class of crash. The
// properties below are asserted against BOTH installs, from the outside, through the real `error` hook.
//
// The input is untrusted: `statusCode` is whatever the thrown value happens to carry. H3 sets a number, but
// plenty of libraries set a string (`'404'`), and any value can be thrown. The triage must never silently
// drop a crash it cannot classify.
import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { installBugseeNitro } from './nitro';
import { installBugseeNitroEdge } from './nitro-edge';

function fakeClient() {
  return {
    event: vi.fn(),
    logException: vi.fn(async () => ({ ok: true }) as const),
    flush: vi.fn(async () => {}),
  };
}

/** Fire `error` on the NODE bridge; resolve whether the error was reported. */
function reportedByNode(error: unknown): boolean {
  const client = fakeClient();
  const handlers: Array<(e: unknown, c?: unknown) => void> = [];
  installBugseeNitro(
    {
      hooks: { hook: (_e: unknown, h: (e: unknown, c?: unknown) => void) => handlers.push(h) },
    } as never,
    { appToken: 'tok', launch: () => client as never, injectTraceMeta: false },
  );
  const handler = handlers[0];
  handler?.(error, { event: { method: 'GET', path: '/p' } });
  return client.logException.mock.calls.length > 0;
}

/** Fire `error` on the EDGE bridge; resolve whether the error was reported. */
function reportedByEdge(error: unknown): boolean {
  const client = fakeClient();
  const handlers: Array<(e: unknown, c?: unknown) => void> = [];
  installBugseeNitroEdge(
    {
      hooks: { hook: (_e: unknown, h: (e: unknown, c?: unknown) => void) => handlers.push(h) },
    } as never,
    { appToken: 'tok', launch: () => client as never },
  );
  const handler = handlers[0];
  const held: Array<Promise<unknown>> = [];
  // A real Cloudflare ExecutionContext, so the REAL resolveWaitUntil hands back this waitUntil.
  handler?.(error, {
    event: {
      context: { cloudflare: { context: { waitUntil: (p: Promise<unknown>) => held.push(p) } } },
    },
  });
  // The edge bridge does its reporting inside the promise it hands to waitUntil; "was it reported" is
  // "was the isolate kept alive for an incident".
  return held.length > 0;
}

/** A thrown value carrying an arbitrary `statusCode` — the only field the triage reads. */
const withStatus = (statusCode: unknown): unknown =>
  Object.assign(new Error('boom'), { statusCode });

describe('H3 status triage — properties', () => {
  it('never reports a numeric status below 500 (expected client errors: 404, 422, …)', () => {
    fc.assert(
      fc.property(fc.integer({ min: -10_000, max: 499 }), (status) => {
        expect(reportedByNode(withStatus(status))).toBe(false);
        expect(reportedByEdge(withStatus(status))).toBe(false);
      }),
    );
  });

  it('always reports a numeric status of 500 and above (real crashes)', () => {
    fc.assert(
      fc.property(fc.integer({ min: 500, max: 100_000 }), (status) => {
        expect(reportedByNode(withStatus(status))).toBe(true);
        expect(reportedByEdge(withStatus(status))).toBe(true);
      }),
    );
  });

  // The dangerous direction. A NON-numeric statusCode must fall through to "report it": `'404' < 500` is
  // true under JS coercion, so a triage that skipped the `typeof` check would silently swallow every crash
  // from a library that stringifies its status.
  it('always reports when `statusCode` is not a number — a crash it cannot classify is never dropped', () => {
    const nonNumeric = fc.oneof(
      fc.string(),
      fc.integer({ min: -1000, max: 1000 }).map(String), // '404', '500' — the coercion trap
      fc.boolean(),
      fc.constant(null),
      fc.constant(undefined),
      fc.object(),
      fc.array(fc.integer()),
      fc.bigInt(),
    );
    fc.assert(
      fc.property(nonNumeric, (statusCode) => {
        expect(reportedByNode(withStatus(statusCode))).toBe(true);
        expect(reportedByEdge(withStatus(statusCode))).toBe(true);
      }),
    );
  });

  it('reports NaN (a number, but not below 500)', () => {
    expect(reportedByNode(withStatus(Number.NaN))).toBe(true);
    expect(reportedByEdge(withStatus(Number.NaN))).toBe(true);
  });

  // Differential: the two copies must classify identically, for every shape a Nitro error can take.
  it('the node and edge bridges classify every thrown value identically (no drift between the copies)', () => {
    const thrown = fc.oneof(
      fc.constant(null),
      fc.constant(undefined),
      fc.string(),
      fc.integer(),
      fc.anything().map((statusCode) => withStatus(statusCode)),
      fc.record({ statusCode: fc.integer({ min: 100, max: 599 }) }),
      fc.object(),
    );
    fc.assert(
      fc.property(thrown, (error) => {
        expect(reportedByEdge(error)).toBe(reportedByNode(error));
      }),
    );
  });
});
