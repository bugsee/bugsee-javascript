import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { threadId } from 'node:worker_threads';
import { afterEach, describe, expect, it } from 'vitest';
import { createInstanceLayout, type InstanceOwner, writeInstanceOwner } from './instance-layout';

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
});
