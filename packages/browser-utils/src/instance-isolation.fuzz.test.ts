import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { AsyncBlobStore, AsyncKeyedStore } from './idb';
import {
  captureDatabaseName,
  coexistenceDatabaseName,
  createPrefixedBlobStore,
  createPrefixedKeyedStore,
  hashToken,
  instanceLockName,
  markerDatabaseName,
  splitInstanceKey,
} from './instance-coexistence';

/**
 * Property-based tests for browser multi-instance isolation.
 *
 * IndexedDB is ORIGIN-scoped, so every tab, web worker and service worker on a site shares it. Before the
 * per-instance prefixing landed, siblings cross-recovered each other's data, swept each other's live
 * capture, and — because the databases were not per-token — one app's bundles could upload to ANOTHER
 * PROJECT. That last one is the reason `hashToken` exists.
 *
 * Two invariants carry all of it: a view never sees a key that is not its own, and it always sees its own.
 * Both are stated over generated instance ids and keys, because the interesting failures are the shapes
 * nobody writes by hand — an instance id that prefixes another (`tab1` / `tab10`), a key containing the
 * separator, an empty inner id.
 */

/** Instance ids including ones that PREFIX each other, which naive `startsWith` filtering gets wrong. */
const instanceId = fc.oneof(
  fc.stringMatching(/^[a-z0-9]{4,10}$/),
  fc.constantFrom('tab1', 'tab10', 'tab100', 'a', 'ab', 'abc'),
);

/** Inner ids, including ones carrying the separator the prefix scheme uses. */
const innerId = fc.oneof(
  fc.stringMatching(/^[a-z0-9._-]{1,16}$/),
  fc.constantFrom('d/0000/1', 'm/0001/x', 'nested/deep/key', ''),
);

/** A trivial in-memory shared store — the thing every instance's view sits on top of. */
const sharedBlobStore = (): AsyncBlobStore & { raw: Map<string, Uint8Array> } => {
  const raw = new Map<string, Uint8Array>();
  return {
    raw,
    loadAll: async () => [...raw.entries()],
    put: async (key, bytes) => {
      raw.set(key, bytes);
    },
    remove: async (key) => {
      raw.delete(key);
    },
  };
};

const sharedKeyedStore = (): AsyncKeyedStore & { raw: Map<string, Uint8Array> } => {
  const raw = new Map<string, Uint8Array>();
  return {
    raw,
    put: async (key, bytes) => {
      raw.set(key, bytes);
    },
    readPrefix: async (prefix) => [...raw.entries()].filter(([k]) => k.startsWith(prefix)),
    keys: async (prefix) => [...raw.keys()].filter((k) => k.startsWith(prefix)),
    deletePrefix: async (prefix) => {
      for (const k of [...raw.keys()]) {
        if (k.startsWith(prefix)) {
          raw.delete(k);
        }
      }
    },
  };
};

const bytes = (n: number): Uint8Array => new Uint8Array([n & 0xff]);

describe('hashToken / database naming (fuzz)', () => {
  it('is deterministic and always eight hex characters', () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 64 }), (token) => {
        const hash = hashToken(token);
        expect(hash).toMatch(/^[0-9a-f]{8}$/);
        expect(hashToken(token)).toBe(hash);
      }),
      { numRuns: 500 },
    );
  });

  /**
   * THE wrong-project guard: two different app tokens must not share a database.
   *
   * A 32-bit hash can collide in principle, so this asserts what is actually depended on — that realistic,
   * distinct tokens land in distinct databases — rather than a no-collision claim no 32-bit hash can make.
   */
  it('keeps distinct app tokens in distinct databases', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(fc.stringMatching(/^[a-f0-9]{16,32}$/), { minLength: 2, maxLength: 12 }),
        (tokens) => {
          const names = tokens.map(coexistenceDatabaseName);
          expect(new Set(names).size, 'two app tokens shared a database').toBe(tokens.length);
          // The three databases of one token are also distinct from one another — a capture chunk must
          // never land in the bundle queue.
          for (const token of tokens) {
            const perToken = [
              coexistenceDatabaseName(token),
              captureDatabaseName(token),
              markerDatabaseName(token),
            ];
            expect(new Set(perToken).size).toBe(3);
          }
        },
      ),
      { numRuns: 300 },
    );
  });

  it('scopes a lock name by both token and instance', () => {
    fc.assert(
      fc.property(
        fc.stringMatching(/^[a-f0-9]{16,32}$/),
        fc.stringMatching(/^[a-f0-9]{16,32}$/),
        instanceId,
        instanceId,
        (tokenA, tokenB, idA, idB) => {
          fc.pre(tokenA !== tokenB || idA !== idB);
          expect(instanceLockName(tokenA, idA)).not.toBe(instanceLockName(tokenB, idB));
        },
      ),
      { numRuns: 400 },
    );
  });
});

describe('splitInstanceKey (fuzz)', () => {
  it('round-trips a prefixed key back to its parts', () => {
    fc.assert(
      fc.property(instanceId, innerId, (id, inner) => {
        const split = splitInstanceKey(`${id}/${inner}`);
        expect(split?.instanceId).toBe(id);
        // The FIRST separator divides; an inner id may contain more of them.
        expect(split?.id).toBe(inner);
      }),
      { numRuns: 500 },
    );
  });

  it('refuses a key with no owner rather than inventing one', () => {
    fc.assert(
      fc.property(fc.stringMatching(/^[a-z0-9]{0,12}$/), (key) => {
        expect(splitInstanceKey(key)).toBeUndefined(); // no separator
        expect(splitInstanceKey(`/${key}`)).toBeUndefined(); // empty owner
      }),
      { numRuns: 300 },
    );
  });
});

describe('per-instance views (fuzz)', () => {
  /**
   * The isolation invariant, in both directions at once: a view returns everything its own instance wrote
   * and nothing any sibling wrote.
   *
   * Instance ids that prefix one another (`tab1` vs `tab10`) are generated deliberately — that is the
   * shape where a `startsWith` filter without the trailing separator silently hands one tab another tab's
   * data, which is the multi-tab leak this scheme exists to prevent.
   */
  it('a blob view sees its own entries and no sibling’s', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(instanceId, { minLength: 2, maxLength: 5 }),
        // UNIQUE inner keys: duplicates overwrite one another, so a count assertion would fail for a
        // reason that has nothing to do with isolation (the first counterexample was two empty strings).
        fc.uniqueArray(innerId, { minLength: 1, maxLength: 6 }),
        async (ids, keys) => {
          const shared = sharedBlobStore();
          const views = ids.map((id) => ({ id, view: createPrefixedBlobStore(shared, id) }));
          // Every instance writes the same inner keys, so only the prefix distinguishes them.
          for (const [i, { view }] of views.entries()) {
            for (const [j, key] of keys.entries()) {
              await view.put(key, bytes(i * 100 + j));
            }
          }
          for (const [i, { view }] of views.entries()) {
            const mine = await view.loadAll();
            expect(mine).toHaveLength(keys.length);
            for (const [key, value] of mine) {
              expect(keys, 'a key from another instance appeared').toContain(key);
              const j = keys.indexOf(key);
              expect(value[0], 'an entry came back with a sibling’s bytes').toBe(
                (i * 100 + j) & 0xff,
              );
            }
          }
          // Removing through one view never touches a sibling's data.
          const [first, ...rest] = views;
          for (const key of keys) {
            await first?.view.remove(key);
          }
          for (const { view } of rest) {
            expect(await view.loadAll()).toHaveLength(keys.length);
          }
          expect(await first?.view.loadAll()).toHaveLength(0);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('a keyed view scans, lists and deletes only its own prefix range', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uniqueArray(instanceId, { minLength: 2, maxLength: 4 }), async (ids) => {
        const shared = sharedKeyedStore();
        const views = ids.map((id) => createPrefixedKeyedStore(shared, id));
        for (const [i, view] of views.entries()) {
          await view.put('d/0001/a', bytes(i));
          await view.put('d/0001/b', bytes(i));
          await view.put('m/0001/a', bytes(i));
        }
        for (const view of views) {
          // The inner `d/…` scheme is opaque to the prefix, so range scans still resolve correctly.
          expect(await view.keys('d/')).toEqual(['d/0001/a', 'd/0001/b']);
          expect(await view.readPrefix('m/')).toHaveLength(1);
        }
        // Deleting an entire inner range in one instance leaves every sibling untouched — the sweep
        // that used to take other tabs' live capture with it.
        await views[0]?.deletePrefix('d/');
        expect(await views[0]?.keys('d/')).toEqual([]);
        for (const view of views.slice(1)) {
          expect(await view.keys('d/'), 'a sibling’s chunks were swept').toHaveLength(2);
        }
      }),
      { numRuns: 150 },
    );
  });
});
