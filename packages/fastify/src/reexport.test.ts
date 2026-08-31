import * as umbrella from '@bugsee/bugsee/node';
import { describe, expect, it } from 'vitest';
// F-5/F-6, type-only: erased at runtime, so these are `tsc --noEmit` checks — the casts fail to compile
// if the re-export chain (@bugsee/node → @bugsee/bugsee's node entry → @bugsee/fastify) drops the type.
import type { HttpRequestOptions, HttpResponse, HttpTransport, RequestContextStore } from './index';
// Namespace imports so a missing re-export surfaces as `undefined` (a clean assertion failure) rather
// than a module-resolution error — the mutation catch for the re-export.
import * as adapter from './index';

describe('@bugsee/fastify single-install re-export', () => {
  it('re-exports launch so the umbrella need not be installed separately', () => {
    expect(adapter.launch).toBe(umbrella.launch);
    expect(typeof adapter.launch).toBe('function');
  });

  it('re-exports RequestContextStoreToken (F-5): app code can reach the per-request store without @bugsee/node', () => {
    // Before this fix, this sample needed a DIRECT @bugsee/node dependency purely to reach this token
    // and reach into the client's internal DI container (samples/fastify-api/src/bugsee.ts:106-110).
    expect(adapter.RequestContextStoreToken).toBe(umbrella.RequestContextStoreToken);
    expect(adapter.RequestContextStoreToken).toBeDefined();
  });

  it('re-exports the RequestContextStore type (F-5) so app code can type a resolved store', () => {
    const store = {} as RequestContextStore;
    expect(store).toBeDefined();
  });

  it('re-exports HttpTransport (+ its option/response shapes) so a custom transport types without a cast (F-6)', () => {
    // Before this fix, wiring a custom transport required `transport: createTeeTransport() as never`
    // (samples/fastify-api/src/bugsee.ts:94) to satisfy the type checker.
    const transport = (async () => ({
      status: 200,
      headers: {},
      body: new Uint8Array(),
    })) as HttpTransport;
    const options = {} as HttpRequestOptions;
    const response = {} as HttpResponse;
    expect([transport, options, response]).toHaveLength(3);
  });
});
