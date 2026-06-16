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
 * Pure liveness verdict (D2). A subtree is DEAD iff its owning process is gone (reclaim INSTANTLY), OR the
 * process is alive but its heartbeat has been stale beyond the PATIENT window (a dead worker_thread in a
 * live process, or a reused pid). An alive pid with no heartbeat yet is a still-arming instance — KEPT.
 */
export function isSiblingDead(
  ownerPidAlive: boolean,
  liveMtimeMs: number | undefined,
  nowMs: number,
  patientMs: number,
): boolean {
  if (!ownerPidAlive) {
    return true;
  }
  if (liveMtimeMs === undefined) {
    return false;
  }
  return nowMs - liveMtimeMs > patientMs;
}
