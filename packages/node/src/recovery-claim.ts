import { join } from 'node:path';
import { readFileBytes, remove, writeFileExclusive } from '@bugsee/node-utils';
import { strFromU8 } from '@bugsee/util';
import { isSiblingDead, pidAlive, readLiveMtimeMs } from './liveness';

// The multi-instance recovery CLAIM (design: multi-instance-disk-coexistence.md, D4 — the item its own
// header called "atomic-rename claim lands in slice 4"). Without it, two launches that start at the same
// moment both see the same dead sibling subtree, both recover it, and both upload every bundle in it. The
// browser tier has been serialized since #166 by `web-lock-liveness.ts` (`ifAvailable: true`); node had
// nothing, because there is no portable cross-process lock in JS.
//
// The claim is an `O_EXCL` file inside the subtree being recovered. `O_EXCL` makes "does it exist?" and
// "create it" ONE kernel operation, which is exactly the mutual exclusion a lock would give — for the
// duration of one recovery pass, between processes that share a `dataDir`.
//
// Why a file and not the rename the design sketched. A rename changes the subtree's NAME, and the name is
// load-bearing twice over: `recoverInstances` and `sweepAgedInstances` both filter on the instance-id
// shape, and the age-based sweep is the last-resort reaper that keeps an abandoned tree from living
// forever. A claimed subtree must stay visible to both, so the claim goes INSIDE it and leaves the name
// alone. It also needs no cleanup on the happy path: a fully-recovered subtree is removed whole.
//
// A claim is only as good as its expiry. A recoverer that dies half way through would otherwise leave a
// file nobody can clear, and the incident would be delivered on no launch ever again — strictly worse than
// the duplicate upload this replaces. So a claim names its holder, and a claim whose holder is DEAD (by
// the same `isSiblingDead` verdict recovery already uses on subtree owners) is taken over.

/** The claim file, at the root of the subtree being recovered, beside `owner.json` and `.live`. */
export const CLAIM_FILE = '.recovering';

/** What a claim records: who holds it, and since when. */
export interface RecoveryClaim {
  /** The holder's instance id (`<pid>-<threadId>-<nonce>`) — its liveness is read back out of this. */
  claimerId: string;
  /** Wall-clock ms at which the claim was taken. Diagnostic; expiry is decided by holder liveness. */
  claimedAt: number;
}

export interface ClaimOptions {
  /** The sibling subtree to claim. */
  sub: string;
  /** The shared root — the holder's own subtree (and therefore its heartbeat) is found under it. */
  dataDir: string;
  /** This launch's instance id, recorded as the holder. */
  ownInstanceId: string;
  /** Now (ms). */
  now: () => number;
  /** How long an alive-pid holder may be heartbeat-stale before its claim is taken over. */
  patientMs: number;
  /** Process-alive probe seam (tests). Default `process.kill` via `pidAlive`. */
  kill?: (pid: number, signal: number) => void;
}

/** Parse `<pid>-<threadId>-<nonce>`; undefined when the id is not instance-shaped. */
function parseInstanceId(id: string): { pid: number; threadId: number } | undefined {
  const match = /^(\d+)-(\d+)-/.exec(id);
  if (match === null) {
    return undefined;
  }
  return { pid: Number(match[1]), threadId: Number(match[2]) };
}

/**
 * Read the claim currently on `sub`, or undefined when there is none.
 *
 * A MISSING file and a CORRUPT one are deliberately one path: both mean "no holder we can believe", and
 * both lead to the same action (take the claim). The missing case is a real race — the holder can release
 * between our failed create and this read — so it is not an error, just another way to learn there is
 * nobody there. Empty bytes fail `JSON.parse` exactly like corrupt ones do.
 */
function readClaim(claimFile: string): RecoveryClaim | undefined {
  try {
    const claim = JSON.parse(
      strFromU8(readFileBytes(claimFile) ?? new Uint8Array()),
    ) as RecoveryClaim;
    return typeof claim?.claimerId === 'string' ? claim : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether an existing claim is still held by a living process.
 *
 * Unparseable, or naming something that is not instance-shaped, counts as STALE: a corrupt claim file must
 * not be able to strand a subtree, which is the failure this whole expiry rule exists to prevent.
 */
function claimIsLive(claim: RecoveryClaim | undefined, options: ClaimOptions): boolean {
  if (claim === undefined) {
    return false;
  }
  const holder = parseInstanceId(claim.claimerId);
  if (holder === undefined) {
    return false;
  }
  return !isSiblingDead(
    pidAlive(holder.pid, options.kill),
    readLiveMtimeMs(join(options.dataDir, claim.claimerId, '.live')),
    options.now(),
    options.patientMs,
    holder.threadId,
  );
}

/**
 * Try to take the recovery claim on `sub`. True ⇒ this launch owns it and must {@link releaseClaim} when
 * it is done; false ⇒ another LIVE launch is recovering it and this one must leave it entirely alone.
 *
 * A stale claim (dead holder) is cleared and re-taken. That second take is another `O_EXCL` create, so if
 * two launches decide the same claim is stale, only one of them wins.
 */
export function claimSubtree(options: ClaimOptions): boolean {
  const claimFile = join(options.sub, CLAIM_FILE);
  const mine = JSON.stringify({
    claimerId: options.ownInstanceId,
    claimedAt: options.now(),
  } satisfies RecoveryClaim);
  if (writeFileExclusive(claimFile, mine)) {
    return true;
  }
  if (claimIsLive(readClaim(claimFile), options)) {
    return false;
  }
  remove(claimFile);
  return writeFileExclusive(claimFile, mine);
}

/**
 * Give up the claim on `sub`.
 *
 * Called however recovery ended, including by throwing: a subtree KEPT for retry must not also keep a
 * claim naming a process that has since exited, or the next launch has to wait for that pid to be reaped
 * before it will touch it. A fully-recovered subtree is already gone, and removing a file inside a
 * directory that no longer exists is a no-op.
 */
export function releaseClaim(sub: string): void {
  remove(join(sub, CLAIM_FILE));
}
