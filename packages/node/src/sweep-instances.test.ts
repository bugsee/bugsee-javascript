import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstanceOwner } from './instance-layout';
import { DEFAULT_INSTANCE_TTL_MS, sweepAgedInstances } from './sweep-instances';

// Seed a per-instance subtree under `root`. `owner`/`live`/`data` are independently optional so each test
// shapes the exact orphan it asserts on (owner-less, dead, live, fresh, …).
function seed(
  root: string,
  id: string,
  opts: { owner?: { pid: number; startedAt: number }; live?: boolean; data?: boolean } = {},
): string {
  const sub = join(root, id);
  mkdirSync(join(sub, 'capture'), { recursive: true });
  if (opts.owner) {
    const owner: InstanceOwner = {
      instanceId: id,
      pid: opts.owner.pid,
      threadId: 0,
      startedAt: opts.owner.startedAt,
      version: '0',
    };
    writeFileSync(join(sub, 'owner.json'), JSON.stringify(owner));
  }
  if (opts.live) {
    writeFileSync(join(sub, '.live'), '');
  }
  if (opts.data) {
    writeFileSync(join(sub, 'capture', '0'), '1\tx\n');
  }
  return sub;
}

// A process-alive probe over an explicit set of "alive" pids (mirrors process.kill(pid, 0) semantics:
// success → alive; ESRCH → dead).
const killOver =
  (alivePids: Set<number>) =>
  (pid: number, _signal: number): void => {
    if (!alivePids.has(pid)) {
      const err = new Error('no such process') as NodeJS.ErrnoException;
      err.code = 'ESRCH';
      throw err;
    }
  };

describe('sweepAgedInstances', () => {
  let root: string;
  const roots: string[] = [];
  const mkRoot = (): string => {
    const r = mkdtempSync(join(tmpdir(), 'bugsee-sweep-'));
    roots.push(r);
    return r;
  };
  afterEach(() => {
    for (const r of roots.splice(0)) {
      rmSync(r, { recursive: true, force: true });
    }
    vi.restoreAllMocks();
  });

  const NOW = 1_000_000_000_000;
  const TTL = 10_000;

  it('removes an aged subtree whose owning process is dead', () => {
    root = mkRoot();
    const sub = seed(root, '999-0-dead', {
      owner: { pid: 999, startedAt: NOW - TTL - 1 },
      data: true,
    });
    sweepAgedInstances({
      dataDir: root,
      ownInstanceId: 'self',
      ttlMs: TTL,
      now: () => NOW,
      kill: killOver(new Set()),
    });
    expect(existsSync(sub)).toBe(false);
  });

  it('removes an aged subtree that has no owner.json (an orphan that liveness can never check)', () => {
    root = mkRoot();
    const sub = seed(root, '888-0-noowner', { data: true });
    // No owner + no .live → age falls back to the directory mtime; pin it well in the past so `now` (NOW)
    // is unambiguously beyond the TTL regardless of the real filesystem clock.
    const old = new Date(NOW - DEFAULT_INSTANCE_TTL_MS);
    utimesSync(sub, old, old);
    sweepAgedInstances({
      dataDir: root,
      ownInstanceId: 'self',
      ttlMs: TTL,
      now: () => NOW,
      kill: killOver(new Set()),
    });
    expect(existsSync(sub)).toBe(false);
  });

  it('keeps a subtree whose owning process is still alive (even if its owner.startedAt is old)', () => {
    root = mkRoot();
    const sub = seed(root, '777-0-live', { owner: { pid: 777, startedAt: NOW - TTL - 1 } });
    sweepAgedInstances({
      dataDir: root,
      ownInstanceId: 'self',
      ttlMs: TTL,
      now: () => NOW,
      kill: killOver(new Set([777])),
    });
    expect(existsSync(sub)).toBe(true);
  });

  it('keeps a dead subtree that is still within the TTL window', () => {
    root = mkRoot();
    const sub = seed(root, '666-0-fresh', { owner: { pid: 666, startedAt: NOW - 1 } });
    sweepAgedInstances({
      dataDir: root,
      ownInstanceId: 'self',
      ttlMs: TTL,
      now: () => NOW,
      kill: killOver(new Set()),
    });
    expect(existsSync(sub)).toBe(true);
  });

  it('a fresh .live heartbeat keeps a subtree even when owner.startedAt is old (heartbeat wins)', () => {
    root = mkRoot();
    // .live mtime is real-now; with `now` ≈ real-now the heartbeat is fresh → kept despite the old startedAt.
    const sub = seed(root, '555-0-beating', { owner: { pid: 555, startedAt: 1 }, live: true });
    sweepAgedInstances({
      dataDir: root,
      ownInstanceId: 'self',
      ttlMs: DEFAULT_INSTANCE_TTL_MS,
      kill: killOver(new Set()), // pid dead — only the fresh heartbeat protects it
    });
    expect(existsSync(sub)).toBe(true);
  });

  it('reclaims a dead subtree whose .live heartbeat is STALE (a stale heartbeat does not protect it)', () => {
    root = mkRoot();
    // .live is present but its mtime is pinned well past the TTL; owner.startedAt is fresh (NOW). If the sweep
    // used startedAt it would KEEP the subtree — so this pins that .live (the heartbeat) is the activity signal
    // AND that a stale heartbeat fails to protect a dead instance.
    const sub = seed(root, '222-0-stale', { owner: { pid: 222, startedAt: NOW }, live: true });
    const old = new Date(NOW - DEFAULT_INSTANCE_TTL_MS - 1);
    utimesSync(join(sub, '.live'), old, old);
    sweepAgedInstances({
      dataDir: root,
      ownInstanceId: 'self',
      ttlMs: TTL,
      now: () => NOW,
      kill: killOver(new Set()), // pid dead
    });
    expect(existsSync(sub)).toBe(false);
  });

  it('never removes the own subtree even when it is aged + dead (instance-shaped, only the own-id guards it)', () => {
    root = mkRoot();
    // Instance-shaped + aged + dead-pid: without the own-id skip it WOULD be reclaimed — so this isolates
    // that guard from the shape-regex guard.
    const own = seed(root, '111-0-own', { owner: { pid: 111, startedAt: NOW - TTL - 1 } });
    sweepAgedInstances({
      dataDir: root,
      ownInstanceId: '111-0-own',
      ttlMs: TTL,
      now: () => NOW,
      kill: killOver(new Set()),
    });
    expect(existsSync(own)).toBe(true);
  });

  it('never touches a non-instance-shaped (foreign) directory even when it is aged', () => {
    root = mkRoot();
    // Owner-less + pinned-old mtime: without the shape regex it WOULD be reclaimed — so this isolates the
    // shape guard. A foreign dir (not `<pid>-<tid>-…`) must be left alone regardless of age.
    const foreign = join(root, 'not-an-instance');
    mkdirSync(foreign, { recursive: true });
    const old = new Date(NOW - DEFAULT_INSTANCE_TTL_MS);
    utimesSync(foreign, old, old);
    sweepAgedInstances({
      dataDir: root,
      ownInstanceId: 'self',
      ttlMs: TTL,
      now: () => NOW,
      kill: killOver(new Set()),
    });
    expect(existsSync(foreign)).toBe(true);
  });

  it('reports a listing failure to onError and never throws (dataDir is a file, not a dir)', () => {
    root = mkRoot();
    const asFile = join(root, 'a-file');
    writeFileSync(asFile, 'x'); // readdir on a file → ENOTDIR (not ENOENT) → listFiles throws
    const onError = vi.fn();
    expect(() =>
      sweepAgedInstances({ dataDir: asFile, ownInstanceId: 'self', onError }),
    ).not.toThrow();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('swallows a failure through the default no-op onError when none is provided (never throws)', () => {
    root = mkRoot();
    const asFile = join(root, 'a-file');
    writeFileSync(asFile, 'x'); // readdir on a file → ENOTDIR → listFiles throws, hitting the default sink
    expect(() => sweepAgedInstances({ dataDir: asFile, ownInstanceId: 'self' })).not.toThrow();
  });

  it('a missing dataDir is a no-op (listFiles returns [], nothing to sweep, no error)', () => {
    const onError = vi.fn();
    expect(() =>
      sweepAgedInstances({
        dataDir: join(tmpdir(), 'bugsee-absent-xyz'),
        ownInstanceId: 'self',
        onError,
      }),
    ).not.toThrow();
    expect(onError).not.toHaveBeenCalled();
  });

  it('isolates a per-subtree failure to onError and keeps sweeping the rest (no throw, subtree kept)', () => {
    root = mkRoot();
    const sub = seed(root, '444-0-boom', { data: true }); // owner-less → passes the alive gate
    const onError = vi.fn();
    const boom = new Error('clock boom');
    sweepAgedInstances({
      dataDir: root,
      ownInstanceId: 'self',
      ttlMs: TTL,
      now: () => {
        throw boom;
      },
      onError,
    });
    expect(onError).toHaveBeenCalledWith(boom);
    expect(existsSync(sub)).toBe(true); // threw before remove → left in place
  });

  it('defaults ttl to ~7 days and now to Date.now (a just-created dead subtree is kept)', () => {
    root = mkRoot();
    const sub = seed(root, '333-0-default', { owner: { pid: 333, startedAt: Date.now() } });
    expect(DEFAULT_INSTANCE_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    sweepAgedInstances({ dataDir: root, ownInstanceId: 'self', kill: killOver(new Set()) });
    expect(existsSync(sub)).toBe(true); // fresh under the 7-day default → kept
  });
});
