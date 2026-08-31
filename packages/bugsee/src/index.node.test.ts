import { describe, expect, it } from 'vitest';
// Type-only: erased at runtime, so these are `tsc --noEmit` checks — the casts below fail to compile if
// the re-export doesn't exist.
import type {
  HttpRequestOptions,
  HttpResponse,
  HttpTransport,
  RequestContextStore,
} from './index.node';
// F-5/F-6: the umbrella's node entry (selected by the package "node" export condition) is what every
// backend adapter's `export * from '@bugsee/bugsee/node'` single-install re-export pulls from — so a
// gap here is a gap in @bugsee/express, @bugsee/fastify, @bugsee/koa, @bugsee/hapi, @bugsee/hono,
// @bugsee/elysia and @bugsee/nestjs all at once. Namespace import so a missing re-export surfaces as a
// clean `undefined` assertion failure for the runtime value (RequestContextStoreToken) rather than a
// module-resolution error.
import * as nodeEntry from './index.node';

describe('@bugsee/bugsee node entry — re-exports needed by every backend adapter', () => {
  it('re-exports RequestContextStoreToken (F-5): app code can reach the per-request store without @bugsee/node', () => {
    expect(nodeEntry.RequestContextStoreToken).toBeDefined();
  });

  it('re-exports the RequestContextStore type (F-5) so app code can type a resolved store', () => {
    const store = {} as RequestContextStore;
    expect(store).toBeDefined();
  });

  it('re-exports HttpTransport (+ its option/response shapes) so a custom transport types without a cast (F-6)', () => {
    const transport = (async () => ({
      status: 200,
      headers: {},
      body: new Uint8Array(),
    })) as HttpTransport;
    const options = {} as HttpRequestOptions;
    const response = {} as HttpResponse;
    expect([transport, options, response]).toHaveLength(3);
  });

  it('still exposes launch as the node composition root', () => {
    expect(typeof nodeEntry.launch).toBe('function');
  });
});
