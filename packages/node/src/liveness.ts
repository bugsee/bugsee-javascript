import { statSync } from 'node:fs';
import process from 'node:process';
import { readFileBytes } from '@bugsee/node-utils';
import { strFromU8 } from '@bugsee/util';
import type { InstanceOwner } from './instance-layout';

// Liveness detection for multi-instance recovery (design: multi-instance-disk-coexistence.md, D2). Java's
// OS FileLock (auto-released on process death) has no portable JS equivalent, so a peer decides whether a
// sibling subtree is dead from TWO portable signals: (1) the owning OS process still exists
// (`process.kill(pid, 0)`), and (2) the subtree's `.live` heartbeat is fresh. A whole-process death is
// caught instantly by the pid probe (and is hang-correct — a hung process is still a live pid); the
// heartbeat catches what the probe cannot (a dead worker_thread inside a live process, and PID reuse).

/** Default patient window: how long an ALIVE-pid subtree may go heartbeat-stale before it is reclaimed. */
export const DEFAULT_PATIENT_MS = 120_000;

/** Whether OS process `pid` currently exists. `ESRCH` → gone; `EPERM` → exists (we just can't signal it). */
export function pidAlive(
  pid: number,
  kill: (pid: number, signal: number) => void = process.kill,
): boolean {
  try {
    kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Read + parse a subtree's `owner.json`, or undefined when it is missing or corrupt. */
export function readOwner(ownerFile: string): InstanceOwner | undefined {
  const bytes = readFileBytes(ownerFile);
  if (bytes === undefined) {
    return undefined;
  }
  try {
    const owner = JSON.parse(strFromU8(bytes)) as InstanceOwner;
    return typeof owner?.pid === 'number' ? owner : undefined;
  } catch {
    return undefined;
  }
}

/** The mtime (ms) of the heartbeat file, or undefined when it does not exist / cannot be read. */
export function readLiveMtimeMs(liveFile: string): number | undefined {
  try {
    return statSync(liveFile).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * Pure liveness verdict (D2, revised by Wave 6.6).
 *
 * DEAD iff the owning PROCESS is gone (reclaim instantly), or a WORKER-thread owner's heartbeat has been
 * stale beyond the patient window. An alive pid with no heartbeat yet is a still-arming instance — KEPT.
 *
 * A MAIN-thread owner with an alive pid is never declared dead by heartbeat staleness, however old. That
 * was the previous rule and it deleted live instances' data: reproduced with a real child process and a
 * real SIGSTOP (the shape of a `docker pause`, a VM suspend, a debugger break, a death-spiral GC, or a
 * genuinely blocked event loop — the exact condition this SDK ships ANR detection for). The child was
 * alive; its whole capture subtree was removed underneath it; on resume every write failed ENOENT forever,
 * with nothing recreating the tree. The heartbeat cannot tell "frozen" from "gone" — but `kill(pid,0)` can,
 * and it already says the process exists.
 *
 * A WORKER-thread owner stays reclaimable, because a live pid says nothing about whether THAT THREAD lives,
 * and its heartbeat now runs on a worker of its own that dies with it (verified against real
 * worker_threads). PID reuse and a frozen-then-abandoned process are handled by the age-based sweep
 * (`sweep-instances.ts`), which is the backstop for everything this rule now keeps.
 */
export function isSiblingDead(
  ownerPidAlive: boolean,
  liveMtimeMs: number | undefined,
  nowMs: number,
  patientMs: number,
  ownerThreadId?: number,
): boolean {
  if (!ownerPidAlive) {
    return true;
  }
  if (liveMtimeMs === undefined) {
    return false;
  }
  // An absent threadId (an owner.json from an older build) is read as the main thread: guessing "worker"
  // would delete a live instance's data, while guessing "main" only defers reclamation to the sweep.
  if ((ownerThreadId ?? 0) === 0) {
    return false;
  }
  return nowMs - liveMtimeMs > patientMs;
}
