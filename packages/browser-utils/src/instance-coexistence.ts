import { randomId } from '@bugsee/util';
import type { AsyncBlobStore, AsyncKeyedStore } from './idb';

// Per-instance IndexedDB namespacing for browser/worker multi-instance coexistence (docs/design/
// browser-multi-instance-coexistence.md, BD1/BD5). Several instances on one origin (N tabs, page + workers)
// share the origin's IndexedDB; each writes its durable data under its OWN `"<instanceId>/"` key prefix inside a
// per-APP-TOKEN database, so they coexist without cross-contamination. The recovery coordinator reads the shared
// store to find dead siblings (the prefixes ARE the instance registry — no separate registry store needed).

/** A per-launch instance id (32 hex chars — no `/`, so it is a safe key prefix). */
export const makeInstanceId = (): string => randomId();

/** A fast SYNCHRONOUS FNV-1a hash of the app token → 8 hex chars. The coexistence DB name is needed
 *  synchronously at `open()`, and the token is not a crypto secret here, so a non-crypto hash is fine; it only
 *  needs to keep DIFFERENT app tokens on one origin in different databases (the wrong-project guard). */
export function hashToken(token: string): string {
  let hash = 0x811c9dc5; // FNV-1a 32-bit offset basis
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193); // FNV prime (Math.imul keeps it 32-bit)
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

/** The coexistence IndexedDB database name for an app token: `bugsee-<tokenHash>` (the durable bundle queue). */
export const coexistenceDatabaseName = (token: string): string => `bugsee-${hashToken(token)}`;

/** The per-token capture-chunk database name: `bugsee-capture-<tokenHash>` (per-token = the wrong-project guard). */
export const captureDatabaseName = (token: string): string => `bugsee-capture-${hashToken(token)}`;

/** The per-token report-marker database name: `bugsee-markers-<tokenHash>`. */
export const markerDatabaseName = (token: string): string => `bugsee-markers-${hashToken(token)}`;

/** The Web Lock name an instance holds for its lifetime, within a token's coexistence db. */
export const instanceLockName = (token: string, instanceId: string): string =>
  `bugsee/${hashToken(token)}/${instanceId}`;

/** Split a shared-store key `"<instanceId>/<id>"` into its instance id + the inner id (`undefined` instanceId
 *  for a key with no `/`, which the coordinator ignores). */
export function splitInstanceKey(key: string): { instanceId: string; id: string } | undefined {
  const slash = key.indexOf('/');
  if (slash <= 0) {
    return undefined;
  }
  return { instanceId: key.slice(0, slash), id: key.slice(slash + 1) };
}

/** A per-instance VIEW over a shared {@link AsyncBlobStore}: `put`/`remove` prefix the key with
 *  `"<instanceId>/"`; `loadAll()` returns only THIS instance's pairs (prefix stripped). So an instance's bundle
 *  store sees only its own bundles, while the shared store physically holds every instance's under its prefix. */
export function createPrefixedBlobStore(
  shared: AsyncBlobStore,
  instanceId: string,
): AsyncBlobStore {
  const prefix = `${instanceId}/`;
  return {
    loadAll: () =>
      shared
        .loadAll()
        .then((entries) =>
          entries
            .filter(([key]) => key.startsWith(prefix))
            .map(([key, bytes]) => [key.slice(prefix.length), bytes] as [string, Uint8Array]),
        ),
    put: (id, bytes) => shared.put(prefix + id, bytes),
    remove: (id) => shared.remove(prefix + id),
  };
}

/** A per-instance VIEW over a shared {@link AsyncKeyedStore} (the capture-chunk store): every key is
 *  transparently prefixed with `"<instanceId>/"`, so an instance's chunk backend reads/writes/deletes
 *  ONLY its own chunks while the shared store physically holds every instance's under its prefix. The
 *  prefix is opaque to the inner padded `d/<gen>/…` + `m/<gen>/…` key scheme (it sits entirely to the
 *  left), so the inner prefix-range scans stay correct. `readPrefix`/`keys` strip the prefix back off. */
export function createPrefixedKeyedStore(
  shared: AsyncKeyedStore,
  instanceId: string,
): AsyncKeyedStore {
  const prefix = `${instanceId}/`;
  return {
    put: (key, bytes) => shared.put(prefix + key, bytes),
    readPrefix: (inner) =>
      shared
        .readPrefix(prefix + inner)
        .then((entries) =>
          entries.map(([key, bytes]) => [key.slice(prefix.length), bytes] as [string, Uint8Array]),
        ),
    keys: (inner) =>
      shared.keys(prefix + inner).then((keys) => keys.map((key) => key.slice(prefix.length))),
    deletePrefix: (inner) => shared.deletePrefix(prefix + inner),
  };
}
