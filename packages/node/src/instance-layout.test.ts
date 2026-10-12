import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import { getCarrier } from '@bugsee/core';
import { writeFileSecure } from '@bugsee/node-utils';
import { afterEach, describe, expect, it } from 'vitest';
import {
  claimInstanceRoot,
  createInstanceLayout,
  type InstanceOwner,
  isInstanceRootLive,
  releaseInstanceRoot,
  writeInstanceOwner,
} from './instance-layout';

const dirs: string[] = [];
const mkDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'bugsee-inst-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('createInstanceLayout', () => {
  it('derives instanceId `<pid>-<threadId>-<nonce>` and the per-instance subtree paths', () => {
    const dataDir = '/data';
    const layout = createInstanceLayout(dataDir, { pid: 42, threadId: 3, nonce: () => 'abc' });
    expect(layout.instanceId).toBe('42-3-abc');
    expect(layout.pid).toBe(42);
    expect(layout.threadId).toBe(3);
    expect(layout.root).toBe(join('/data', '42-3-abc'));
    expect(layout.captureDir).toBe(join('/data', '42-3-abc', 'capture'));
    expect(layout.pendingDir).toBe(join('/data', '42-3-abc', 'pending'));
    expect(layout.incidentsDir).toBe(join('/data', '42-3-abc', 'incidents'));
    expect(layout.liveFile).toBe(join('/data', '42-3-abc', '.live'));
    expect(layout.ownerFile).toBe(join('/data', '42-3-abc', 'owner.json'));
  });

  it('defaults pid/threadId to the real process + worker_threads values', () => {
    const layout = createInstanceLayout('/d', { nonce: () => 'n' });
    expect(layout.pid).toBe(process.pid);
    expect(layout.threadId).toBe(threadId); // 0 on the main thread
    expect(layout.instanceId).toBe(`${process.pid}-${threadId}-n`);
  });

  it('mints a fresh nonce each call by default (distinct subtrees per launch)', () => {
    const a = createInstanceLayout('/d');
    const b = createInstanceLayout('/d');
    expect(a.instanceId).not.toBe(b.instanceId); // the nonce disambiguates relaunch / PID reuse
    expect(a.instanceId.startsWith(`${process.pid}-${threadId}-`)).toBe(true);
    // The default nonce is an 8-char lowercase-hex slice of a randomUUID — pin the format so a regression
    // (or a runtime where the UUID source is missing/different) is caught.
    const nonce = a.instanceId.slice(`${process.pid}-${threadId}-`.length);
    expect(nonce).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('writeInstanceOwner', () => {
  it('creates the subtree root and writes owner.json with the identity + startedAt + version', () => {
    const dataDir = mkDir();
    const layout = createInstanceLayout(dataDir, { pid: 7, threadId: 1, nonce: () => 'z9' });
    writeInstanceOwner(layout, 1_700_000_000_000, '2.0.0');

    expect(existsSync(layout.root)).toBe(true);
    const owner = JSON.parse(readFileSync(layout.ownerFile, 'utf8')) as InstanceOwner;
    expect(owner).toEqual({
      instanceId: '7-1-z9',
      pid: 7,
      threadId: 1,
      startedAt: 1_700_000_000_000,
      version: '2.0.0',
    });
  });

  it('removes a stale.stopped marker: a (re)launch into the same subtree is live, not recoverable', () => {
    const dataDir = mkDir();
    const layout = createInstanceLayout(dataDir, { pid: 7, threadId: 1, nonce: () => 'z9' });
    writeInstanceOwner(layout, 1, '1');
    writeFileSecure(layout.stoppedFile, '');
    expect(existsSync(layout.stoppedFile)).toBe(true);
    writeInstanceOwner(layout, 2, '1');
    expect(existsSync(layout.stoppedFile)).toBe(false);
    expect(existsSync(layout.ownerFile)).toBe(true);
  });

  it('is fine without a marker (nothing to remove)', () => {
    const layout = createInstanceLayout(mkDir(), { pid: 7, threadId: 1, nonce: () => 'q' });
    expect(() => writeInstanceOwner(layout, 1, '1')).not.toThrow();
    expect(existsSync(layout.stoppedFile)).toBe(false);
  });
});

describe('live subtree root count', () => {
  it('writing the owner does not register; claim/release count on the DEFAULT carrier (shared by module copies)', () => {
    const layout = createInstanceLayout(mkDir(), { pid: 1, threadId: 1, nonce: () => 'n' });
    writeInstanceOwner(layout, 1, '1');
    expect(isInstanceRootLive(layout)).toBe(false);
    claimInstanceRoot(layout);
    claimInstanceRoot(layout);
    expect(getCarrier().liveInstanceRoots?.get(layout.root)).toBe(2);
    releaseInstanceRoot(layout);
    expect(isInstanceRootLive(layout)).toBe(true);
    releaseInstanceRoot(layout);
    expect(isInstanceRootLive(layout)).toBe(false);
    expect(getCarrier().liveInstanceRoots?.has(layout.root)).toBe(false);
  });
});
