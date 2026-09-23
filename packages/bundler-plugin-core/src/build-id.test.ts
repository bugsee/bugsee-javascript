import { describe, expect, it } from 'vitest';
import { BUILD_ID_NAMESPACE, DEBUG_ID_NAMESPACE, deriveBuildUuid, uuidV5 } from './build-id';

describe('uuidV5', () => {
  // RFC 4122 appendix vector, independent of anything in this repo: UUIDv5(DNS, "www.example.com").
  it('matches the RFC 4122 reference vector', () => {
    expect(uuidV5('6ba7b810-9dad-11d1-80b4-00c04fd430c8', 'www.example.com')).toBe(
      '2ed6657d-e927-568b-95e1-2665a8aea6a2',
    );
  });

  it('sets the version-5 and RFC-variant bits', () => {
    const id = uuidV5(DEBUG_ID_NAMESPACE, 'anything');
    expect(id[14]).toBe('5');
    expect(['8', '9', 'a', 'b']).toContain(id[19]);
  });
});

describe('DEBUG_ID_NAMESPACE', () => {
  // Byte-for-byte the constant `bugsee-cli` stamps debug-ids with (src/inject/mod.rs
  // `DEBUG_ID_NAMESPACE`). Pinned because the build id is derived FROM those ids, and a namespace
  // that silently diverged would still produce perfectly plausible UUIDs.
  it('is the namespace bugsee-cli stamps debug-ids with', () => {
    expect(DEBUG_ID_NAMESPACE).toBe('b095ee5e-5300-4da9-8a05-04deb06a9001');
  });

  it('is not the namespace build ids are derived in', () => {
    // A build id and a debug id are different kinds of identifier; sharing a namespace would let the
    // two collide for equal inputs.
    expect(BUILD_ID_NAMESPACE).not.toBe(DEBUG_ID_NAMESPACE);
    expect(BUILD_ID_NAMESPACE).toBe(uuidV5(DEBUG_ID_NAMESPACE, 'bugsee.js-build'));
  });
});

describe('deriveBuildUuid', () => {
  const a = 'aaaaaaaa-0000-5000-8000-000000000001';
  const b = 'bbbbbbbb-0000-5000-8000-000000000002';
  const fallback = {
    packageId: '@acme/web',
    version: '1.2.0',
    build: '7',
    configuration: 'production',
  };

  it('is deterministic: identical build output gives the identical id', () => {
    expect(deriveBuildUuid([a, b], fallback)).toBe(deriveBuildUuid([a, b], fallback));
  });

  it('does not depend on the order the maps were found in', () => {
    // A directory walk has no guaranteed order, and a rebuild of the same bytes must REPLACE its
    // record (the server dedups on uuid) rather than create a second one.
    expect(deriveBuildUuid([b, a], fallback)).toBe(deriveBuildUuid([a, b], fallback));
  });

  it('ignores duplicate ids', () => {
    expect(deriveBuildUuid([a, a, b], fallback)).toBe(deriveBuildUuid([a, b], fallback));
  });

  it('is derived from the code alone when there is code to derive it from', () => {
    // Android's property (BugseeBuildIdDeriver: hash of mapping.txt): same output bytes, same id,
    // even across a version bump — it IS the same build. A version string is metadata ON the record.
    expect(deriveBuildUuid([a, b], fallback)).toBe(
      deriveBuildUuid([a, b], { ...fallback, version: '9.9.9', build: '99' }),
    );
  });

  it('changes when any chunk changes', () => {
    const c = 'cccccccc-0000-5000-8000-000000000003';
    expect(deriveBuildUuid([a, c], fallback)).not.toBe(deriveBuildUuid([a, b], fallback));
  });

  it('is case-insensitive over the ids', () => {
    expect(deriveBuildUuid([a.toUpperCase(), b], fallback)).toBe(deriveBuildUuid([a, b], fallback));
  });

  describe('with no debug-ids at all', () => {
    // A build with no maps (or a dry run, where inject writes nothing) has no content to hash. Falls
    // back — like Android's manifest+variant path — to the build's identity, which is still
    // deterministic: re-registering the same version replaces rather than duplicates.
    it('falls back to the build identity, deterministically', () => {
      expect(deriveBuildUuid([], fallback)).toBe(deriveBuildUuid([], { ...fallback }));
    });

    it('distinguishes versions, builds, packages and configurations', () => {
      const base = deriveBuildUuid([], fallback);
      expect(deriveBuildUuid([], { ...fallback, version: '1.2.1' })).not.toBe(base);
      expect(deriveBuildUuid([], { ...fallback, build: '8' })).not.toBe(base);
      expect(deriveBuildUuid([], { ...fallback, packageId: '@acme/admin' })).not.toBe(base);
      expect(deriveBuildUuid([], { ...fallback, configuration: 'staging' })).not.toBe(base);
    });

    it('cannot be confused by a separator inside a field', () => {
      // "a|b" + "c" and "a" + "b|c" must not hash alike.
      expect(deriveBuildUuid([], { ...fallback, packageId: 'a|b', version: 'c' })).not.toBe(
        deriveBuildUuid([], { ...fallback, packageId: 'a', version: 'b|c' }),
      );
    });

    it('still derives an id for a build with no package name', () => {
      // No package.json anywhere above the output is a real layout (a bare `dist` built by a script).
      const nameless = { ...fallback, packageId: undefined };
      expect(deriveBuildUuid([], nameless)).toBe(deriveBuildUuid([], { ...nameless }));
      // ...and "no name" is not the same build as a name that happens to be empty.
      expect(deriveBuildUuid([], nameless)).not.toBe(
        deriveBuildUuid([], { ...fallback, packageId: '' }),
      );
    });

    it('never collides with an id derived from content', () => {
      expect(deriveBuildUuid([], fallback)).not.toBe(deriveBuildUuid([a], fallback));
    });

    it('cannot be forged by a debug-id that spells out an identity', () => {
      // Debug-ids are read out of map files on disk, so they are arbitrary strings. One that is
      // literally an identity's encoding must still not produce that identity's build id — which is
      // what the two inputs' distinct prefixes are for.
      const identity = { packageId: 'x', version: '1', build: '2', configuration: 'p' };
      expect(deriveBuildUuid(['["x","1","2","p"]'], fallback)).not.toBe(
        deriveBuildUuid([], identity),
      );
    });
  });
});
