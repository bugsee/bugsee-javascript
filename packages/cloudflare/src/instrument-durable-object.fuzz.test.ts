import {
  type Bugsee,
  createEdgeRequestContextStore,
  EdgeContextStoreToken,
} from '@bugsee/vercel-edge';
import fc from 'fast-check';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { instrumentDurableObject } from './instrument-durable-object';
import * as cfLaunch from './launch';

/**
 * Property-based tests for the Durable Object TENANT KEY.
 *
 * The owner is derived from `ctx.id.toString()` — a value supplied entirely by workerd (or, in a test/stub/
 * future-runtime, by anything at all). It is also the value the partitioned capture store keys a tenant's
 * rolling window on, which is what stops one Durable Object's incident bundle from carrying another
 * customer's capture (docs/review/cloudflare.md SEV1 #2). So it has two hard invariants:
 *
 *   1. Deriving it must NEVER throw — it runs in the DO constructor, and a throw there takes down every
 *      construction of that Durable Object, not merely one capture partition.
 *   2. The result is either `undefined` (no partitioning) or a NON-EMPTY STRING. A `''` or a non-string
 *      would be a partition key that is not a tenant, silently merging tenants back together.
 *
 * Example tests can only sample the `id` shapes a host might produce; these generate them.
 */

// A fake launched edge client whose context store we can read the active owner from.
function fakeClient() {
  const store = createEdgeRequestContextStore();
  const client = {
    logException: vi.fn(() => Promise.resolve({ ok: true })),
    flush: vi.fn(() => Promise.resolve(true)),
    getService: (token: unknown) => (token === EdgeContextStoreToken ? store : undefined),
  } as unknown as Bugsee;
  return { client, store };
}

afterEach(() => vi.restoreAllMocks());

// Every `id` shape a DurableObjectState could plausibly carry, including the hostile ones.
const anyId = (): fc.Arbitrary<unknown> =>
  fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.string().map((value) => ({ toString: () => value })),
    // `toString` returning a NON-string: legal JS, and `String()` would have coerced it — the code does not.
    fc.anything().map((value) => ({ toString: () => value })),
    fc.constant({}), // inherits Object.prototype.toString → '[object Object]'
    fc.constant(Object.create(null) as object), // NO toString at all
    fc.constant({ toString: 'not-a-function' }),
    fc.constant({
      toString: () => {
        throw new Error('hostile id');
      },
    }),
    fc.string(), // a bare string id (its own toString)
    fc.integer(),
  );

const anyState = (): fc.Arbitrary<unknown> =>
  fc.oneof(
    fc.constant(undefined),
    fc.constant(null),
    fc.constant({}),
    anyId().map((id) => ({ id, waitUntil: () => {} })),
  );

describe('the Durable Object tenant key is always safe to use as a partition key', () => {
  it('never throws out of construction, and yields undefined or a non-empty string', async () => {
    await fc.assert(
      fc.asyncProperty(anyState(), async (state) => {
        const { client, store } = fakeClient();
        vi.spyOn(cfLaunch, 'launch').mockReturnValue(client);
        let owner: unknown = 'unset';
        class DO {
          // biome-ignore lint/complexity/noUselessConstructor: declares the DO constructor arity
          constructor(..._args: unknown[]) {}
          async fetch(_request: Request): Promise<Response> {
            owner = store.getCurrent()?.owner;
            return new Response('ok');
          }
        }
        const Wrapped = instrumentDurableObject('tok', DO);
        let instance: DO | undefined;
        expect(() => {
          instance = new Wrapped(state as never, {}) as unknown as DO;
        }).not.toThrow(); // invariant 1: construction survives any state
        await instance?.fetch(new Request('https://x.test/'));
        // invariant 2: a usable tenant key, or nothing at all — never '' and never a non-string.
        if (owner !== undefined) {
          expect(typeof owner).toBe('string');
          expect(owner).not.toBe('');
        }
      }),
      { numRuns: 60 },
    );
  });

  it('a string id round-trips EXACTLY when non-empty, and is dropped when empty', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (id) => {
        const { client, store } = fakeClient();
        vi.spyOn(cfLaunch, 'launch').mockReturnValue(client);
        let owner: unknown = 'unset';
        class DO {
          // biome-ignore lint/complexity/noUselessConstructor: declares the DO constructor arity.
          constructor(..._args: unknown[]) {}
          async fetch(_request: Request): Promise<Response> {
            owner = store.getCurrent()?.owner;
            return new Response('ok');
          }
        }
        const Wrapped = instrumentDurableObject('tok', DO);
        const state = { id: { toString: () => id }, waitUntil: () => {} };
        await (new Wrapped(state, {}) as unknown as DO).fetch(new Request('https://x.test/'));
        // No normalization, no truncation: two distinct DO ids must stay distinct partitions.
        expect(owner).toBe(id === '' ? undefined : id);
      }),
      { numRuns: 60 },
    );
  });

  it('distinct ids never collapse onto one partition key', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.string({ minLength: 1 }), { minLength: 2, maxLength: 5 }),
        async (ids) => {
          const { client, store } = fakeClient();
          vi.spyOn(cfLaunch, 'launch').mockReturnValue(client);
          const owners: Array<string | undefined> = [];
          class DO {
            // biome-ignore lint/complexity/noUselessConstructor: declares the DO constructor arity.
            constructor(..._args: unknown[]) {}
            async fetch(_request: Request): Promise<Response> {
              owners.push(store.getCurrent()?.owner);
              return new Response('ok');
            }
          }
          const Wrapped = instrumentDurableObject('tok', DO);
          for (const id of ids) {
            const state = { id: { toString: () => id }, waitUntil: () => {} };
            await (new Wrapped(state, {}) as unknown as DO).fetch(new Request('https://x.test/'));
          }
          expect(owners).toEqual(ids);
          expect(new Set(owners).size).toBe(ids.length);
        },
      ),
      { numRuns: 30 },
    );
  });
});
