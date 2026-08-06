import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DEFAULT_PATIENT_MS,
  isSiblingDead,
  pidAlive,
  readLiveMtimeMs,
  readOwner,
} from './liveness';

const dirs: string[] = [];
const mkDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'bugsee-live-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const errno = (code: string): (() => never) => {
  return () => {
    throw Object.assign(new Error(code), { code });
  };
};

describe('pidAlive', () => {
  it('reports the current process as alive (real kill(self,0))', () => {
    expect(pidAlive(process.pid)).toBe(true);
  });

  it('reports a non-existent pid as dead (real ESRCH)', () => {
    expect(pidAlive(999_999)).toBe(false);
  });

  it('treats EPERM as alive (the process exists, we just may not signal it)', () => {
    expect(pidAlive(1, errno('EPERM'))).toBe(true);
  });

  it('treats ESRCH as dead via an injected kill', () => {
    expect(pidAlive(123, errno('ESRCH'))).toBe(false);
  });
});

describe('readOwner', () => {
  it('returns undefined when owner.json is absent', () => {
    expect(readOwner(join(mkDir(), 'owner.json'))).toBeUndefined();
  });

  it('parses a valid owner record', () => {
    const f = join(mkDir(), 'owner.json');
    writeFileSync(
      f,
      JSON.stringify({ instanceId: '7-1-z', pid: 7, threadId: 1, startedAt: 9, version: '2' }),
    );
    expect(readOwner(f)?.pid).toBe(7);
  });

  it('returns undefined for corrupt JSON', () => {
    const f = join(mkDir(), 'owner.json');
    writeFileSync(f, 'not-json');
    expect(readOwner(f)).toBeUndefined();
  });

  it('returns undefined when pid is not a number (shape guard)', () => {
    const f = join(mkDir(), 'owner.json');
    writeFileSync(f, JSON.stringify({ instanceId: 'x', threadId: 0 }));
    expect(readOwner(f)).toBeUndefined();
  });
});

describe('readLiveMtimeMs', () => {
  it('returns the mtime of an existing file', () => {
    const f = join(mkDir(), '.live');
    writeFileSync(f, 'x');
    utimesSync(f, 1_000, 1_000); // mtime = 1000s → 1_000_000 ms
    expect(readLiveMtimeMs(f)).toBe(1_000_000);
  });

  it('returns undefined for a missing file', () => {
    expect(readLiveMtimeMs(join(mkDir(), 'nope'))).toBeUndefined();
  });
});

describe('isSiblingDead', () => {
  const now = 1_000_000;
  it('is DEAD instantly when the owning process is gone (regardless of heartbeat)', () => {
    expect(isSiblingDead(false, now, now, DEFAULT_PATIENT_MS)).toBe(true); // fresh heartbeat ignored
    expect(isSiblingDead(false, undefined, now, DEFAULT_PATIENT_MS)).toBe(true);
  });

  it('is ALIVE when the pid is alive and the heartbeat is fresh', () => {
    expect(isSiblingDead(true, now - 1000, now, DEFAULT_PATIENT_MS)).toBe(false);
  });

  it('is ALIVE (kept) when the pid is alive but there is no heartbeat yet (still arming)', () => {
    expect(isSiblingDead(true, undefined, now, DEFAULT_PATIENT_MS)).toBe(false);
  });

  // WAVE 6.6 — an alive PROCESS is never declared dead by a stale heartbeat.
  //
  // Reproduced in the review with a real child process and a real SIGSTOP (docker pause / VM suspend /
  // debugger break / death-spiral GC): the child was ALIVE, and a sibling coordinator deleted its whole
  // capture subtree; on resume every write failed ENOENT forever, with nothing recreating the tree.
  //
  // The heartbeat cannot distinguish "this process is frozen" from "this process is dead" — but
  // `kill(pid,0)` can, and it already says the process exists. So for a MAIN-thread owner a stale heartbeat
  // means frozen or hung, not gone: it can still wake up and write, and this SDK ships ANR detection
  // precisely because a stalled event loop is an expected state whose capture is the thing worth having.
  //
  // A WORKER-thread owner is different and still reclaimable: a live pid says nothing about whether THAT
  // THREAD is alive, and its heartbeat now runs on a worker of its own that dies with it (verified against
  // real worker_threads), so a stale heartbeat there really does mean the owner is gone.
  describe('a stale heartbeat with an ALIVE pid (Wave 6.6)', () => {
    const stale = now - DEFAULT_PATIENT_MS - 1;

    it('KEEPS a main-thread instance — a frozen process is not a dead one', () => {
      expect(isSiblingDead(true, stale, now, DEFAULT_PATIENT_MS, 0)).toBe(false);
    });

    it('reclaims a WORKER-thread instance — the thread died inside a live process', () => {
      expect(isSiblingDead(true, stale, now, DEFAULT_PATIENT_MS, 3)).toBe(true);
    });

    it('keeps a worker-thread instance whose heartbeat is still fresh', () => {
      expect(isSiblingDead(true, now - 1000, now, DEFAULT_PATIENT_MS, 3)).toBe(false);
      // exactly at the window is NOT yet dead (strictly greater)
      expect(isSiblingDead(true, now - DEFAULT_PATIENT_MS, now, DEFAULT_PATIENT_MS, 3)).toBe(false);
    });

    it('still reclaims INSTANTLY when the process itself is gone, whichever thread owned it', () => {
      // The canary: making the policy patient must not make it blind to the common case it exists for.
      expect(isSiblingDead(false, stale, now, DEFAULT_PATIENT_MS, 0)).toBe(true);
      expect(isSiblingDead(false, stale, now, DEFAULT_PATIENT_MS, 3)).toBe(true);
    });

    it('treats an UNKNOWN owning thread as the main thread — the safe direction', () => {
      // An owner.json from an older build has no threadId. Guessing "worker" would delete a live
      // instance's data; guessing "main" only defers reclamation to the age-based sweep.
      expect(isSiblingDead(true, stale, now, DEFAULT_PATIENT_MS, undefined)).toBe(false);
    });
  });
});
