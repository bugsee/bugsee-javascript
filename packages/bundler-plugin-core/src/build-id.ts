// The build UUID a web build registers under (docs/design/web-build-registration.md, D1).
//
// The server dedups builds on `uuid` — a unique index on (organization, application, uuid), with
// replace-then-create on a repeat (bugsee-appserver `builds.service.js`). So the only contract is:
// stable across a rebuild of the same output, distinct across different output. The appserver
// generates a random `uuid.v4()` when none is sent, which would make every rebuild a new record.
//
// Derived from the build's debug-ids, which is Android's property copied deliberately:
// `BugseeBuildIdDeriver.deriveFromMappingFile` hashes R8's mapping.txt, so the id changes whenever the
// code does and NOT when only the version string does. The debug-ids are the web analog — each is
// already a UUIDv5 over one bundle's bytes and its map (`bugsee-cli sourcemaps inject`), so the set of
// them names the build's content exactly, and it is already computed.
import { createHash } from 'node:crypto';

/** The namespace `bugsee-cli` stamps debug-ids in (`src/inject/mod.rs` `DEBUG_ID_NAMESPACE`). */
export const DEBUG_ID_NAMESPACE = 'b095ee5e-5300-4da9-8a05-04deb06a9001';

/**
 * The namespace build ids are derived in — its own, derived from the debug-id one. A build id and a
 * debug id are different kinds of identifier, and sharing a namespace would let equal inputs collide.
 */
export const BUILD_ID_NAMESPACE = uuidV5(DEBUG_ID_NAMESPACE, 'bugsee.web-build');

/** RFC 4122 §4.3 name-based UUID, SHA-1 (version 5). */
export function uuidV5(namespace: string, name: string): string {
  const ns = Buffer.from(namespace.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(ns).update(name, 'utf8').digest();
  // The mask is applied to a copy of the first 16 bytes; `hash` is 20.
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = ((bytes[6] as number) & 0x0f) | 0x50; // version 5
  bytes[8] = ((bytes[8] as number) & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The build's identity — used only when there is no content to derive the id from. */
export interface BuildIdentity {
  packageId: string | undefined;
  version: string;
  build: string;
  configuration: string;
}

/**
 * The UUID to register this build under.
 *
 * With debug-ids: from those alone — sorted, deduplicated and case-folded, so the order a directory
 * walk happened to find the maps in cannot change it.
 *
 * Without any (a build that emitted no maps, or a dry run, where inject writes nothing): from the
 * build's identity, as Android falls back to manifest+variant when R8 wrote no mapping. Still
 * deterministic, so re-registering a version replaces rather than duplicates.
 *
 * The two inputs are prefixed differently so a content-derived id and an identity-derived one can
 * never coincide, and the identity is JSON-encoded so no field value can impersonate a separator.
 */
export function deriveBuildUuid(debugIds: readonly string[], identity: BuildIdentity): string {
  const ids = [...new Set(debugIds.map((id) => id.toLowerCase()))].sort();
  if (ids.length > 0) {
    return uuidV5(BUILD_ID_NAMESPACE, `debug-ids:${ids.join(',')}`);
  }
  return uuidV5(
    BUILD_ID_NAMESPACE,
    `identity:${JSON.stringify([identity.packageId ?? null, identity.version, identity.build, identity.configuration])}`,
  );
}
