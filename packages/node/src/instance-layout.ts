import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { threadId } from 'node:worker_threads';
import { getCarrier } from '@bugsee/core';
import { ensureDir, writeFileSecure } from '@bugsee/node-utils';

// Per-instance on-disk isolation (design: docs/design/multi-instance-disk-coexistence.md, D1). Multiple SDK
// aggregators — several worker_threads in ONE process, or several processes — may share a single `dataDir`.
// Each gets its OWN subtree `<dataDir>/<instanceId>/{capture,pending,incidents}` (+ `.live` heartbeat +
// `owner.json`), so concurrent writers never touch the same files (no generation collision, no interleaved
// appends). `instanceId = <pid>-<threadId>-<nonce>`: `pid` separates processes, `threadId` (node:worker_threads,
// 0 on the main thread) separates worker_threads within a process, and the random `nonce` separates relaunch /
// guards against the OS reusing a dead instance's pid for a path collision.

const LIVE_FILE = '.live';
const OWNER_FILE = 'owner.json';
const STOPPED_FILE = '.stopped';
const NONCE_LEN = 8;

/** Identity + the per-instance subtree paths under a shared `dataDir`. */
export interface InstanceLayout {
  readonly instanceId: string;
  readonly pid: number;
  readonly threadId: number;
  /** `<dataDir>/<instanceId>` — the instance's root subtree. */
  readonly root: string;
  readonly captureDir: string;
  readonly pendingDir: string;
  readonly incidentsDir: string;
  /** The liveness heartbeat file — its mtime is touched from the watchdog thread. */
  readonly liveFile: string;
  readonly ownerFile: string;
  /** Written by a clean `stop()`: tells a later launch this subtree is recoverable although its pid lives. */
  readonly stoppedFile: string;
}

/** The record persisted to `owner.json`, read by a peer to attribute + liveness-check a subtree. */
export interface InstanceOwner {
  readonly instanceId: string;
  readonly pid: number;
  readonly threadId: number;
  readonly startedAt: number;
  readonly version: string;
}

/** Injectable identity (defaults read the real process/thread); `nonce` is injectable for deterministic tests. */
export interface InstanceIdentity {
  pid?: number;
  threadId?: number;
  nonce?: () => string;
}

// `node:crypto` randomUUID (since Node 14.17) — NOT the global `crypto`, which is unflagged only on Node 19+
// (undefined on the declared-minimum Node 18, where it would crash every disk-backed launch).
const defaultNonce = (): string => randomUUID().replace(/-/g, '').slice(0, NONCE_LEN);

/** Derive the instanceId + subtree paths. Pure — does NOT touch the filesystem. */
export function createInstanceLayout(
  dataDir: string,
  identity: InstanceIdentity = {},
): InstanceLayout {
  const pid = identity.pid ?? process.pid;
  const tid = identity.threadId ?? threadId;
  const nonce = (identity.nonce ?? defaultNonce)();
  const instanceId = `${pid}-${tid}-${nonce}`;
  const root = join(dataDir, instanceId);
  return {
    instanceId,
    pid,
    threadId: tid,
    root,
    captureDir: join(root, 'capture'),
    pendingDir: join(root, 'pending'),
    incidentsDir: join(root, 'incidents'),
    liveFile: join(root, LIVE_FILE),
    ownerFile: join(root, OWNER_FILE),
    stoppedFile: join(root, STOPPED_FILE),
  };
}

// Process-level count of LIVE launches per subtree root (R4L-1), held on the DEFAULT carrier so the ESM and CJS
// copies of this package agree (R5L-2). Two launches share a root only through a pinned `instanceIdentity`; a
// plain relaunch gets a fresh root, so "a newer client exists" is NOT "this subtree is live".
const liveRoots = (): Map<string, number> => (getCarrier().liveInstanceRoots ??= new Map());

/** Release one launch's claim on its subtree root (called once, when that launch begins to stop). */
export function releaseInstanceRoot(layout: InstanceLayout): void {
  const count = (liveRoots().get(layout.root) ?? 0) - 1;
  if (count > 0) {
    liveRoots().set(layout.root, count);
  } else {
    liveRoots().delete(layout.root);
  }
}

/** True while some launch that has NOT begun to stop is writing into this subtree root. */
export function isInstanceRootLive(layout: InstanceLayout): boolean {
  return (liveRoots().get(layout.root) ?? 0) > 0;
}

/**
 * Create the subtree root and persist `owner.json` (the identity + this launch's start time + SDK version).
 * A `.stopped` marker left by an earlier clean stop of the same subtree is removed FIRST (R3L-3): this launch is
 * live in it, and a stale marker would let a sibling judge it recoverable and delete it under the live writer.
 * (A pinned `instanceIdentity` is the only way two launches share a subtree.)
 */
export function writeInstanceOwner(
  layout: InstanceLayout,
  startedAt: number,
  version: string,
): void {
  ensureDir(layout.root);
  rmSync(layout.stoppedFile, { force: true });
  const owner: InstanceOwner = {
    instanceId: layout.instanceId,
    pid: layout.pid,
    threadId: layout.threadId,
    startedAt,
    version,
  };
  writeFileSecure(layout.ownerFile, JSON.stringify(owner));
}

/**
 * Count this launch as LIVE in its subtree root. Called at the very END of a successful launch (R5L-2): a launch
 * that registered earlier and then threw would leak the count, and a later launch into the same pinned root
 * would never be able to write `.stopped`. Pair with {@link releaseInstanceRoot}.
 */
export function claimInstanceRoot(layout: InstanceLayout): void {
  liveRoots().set(layout.root, (liveRoots().get(layout.root) ?? 0) + 1);
}
