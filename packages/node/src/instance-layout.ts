import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import process from 'node:process';
import { threadId } from 'node:worker_threads';
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
  };
}

/** Create the subtree root and persist `owner.json` (the identity + this launch's start time + SDK version). */
export function writeInstanceOwner(
  layout: InstanceLayout,
  startedAt: number,
  version: string,
): void {
  ensureDir(layout.root);
  const owner: InstanceOwner = {
    instanceId: layout.instanceId,
    pid: layout.pid,
    threadId: layout.threadId,
    startedAt,
    version,
  };
  writeFileSecure(layout.ownerFile, JSON.stringify(owner));
}
