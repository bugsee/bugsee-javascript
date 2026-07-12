import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Bundle,
  type CrashpadSessionMarker,
  createFileChunkBackend,
  createReportingRequest,
  type HarvestedDump,
  type NativeCrashSource,
  type StoredEntry,
  serializeBundle,
  type UploadResult,
} from '@bugsee/core';
import {
  createFsChunkStorage,
  createNodeBundleStore,
  createNodeCrashpadSessionMarkerStore,
  createNodeReportMarkerStore,
  ensureDir,
  writeFileSecure,
} from '@bugsee/node-utils';
import type { EnvironmentEnvelope } from '@bugsee/protocol';
import { strFromU8, unzipSync } from '@bugsee/util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recoverInstances } from './recover-instances';

const dirs: string[] = [];
const mkDir = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'bugsee-ri-'));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const env: EnvironmentEnvelope = {
  platform: { type: 'node', version: '1' },
  sdk: { version: '0', type: 'javascript' },
};
const clock = { wallNow: () => 1_700_000_000_000, monotonicNow: () => 0 };
const context = () => ({ appToken: 'tok', environment: env, clock, fileName: () => 'b.zip' });

function fakePipeline(result: UploadResult = { ok: true }) {
  const bundles: Bundle[] = [];
  const enqueue = vi.fn((bundle: Bundle): Promise<UploadResult> => {
    bundles.push(bundle);
    return Promise.resolve(result);
  });
  return { bundles, enqueue, flush: () => Promise.resolve(true), drop: () => {} };
}

const aBundle = (summary: string): Bundle => ({
  request: {
    type: 'crash',
    summary,
    severity: 3,
    source: { mechanism: 'uncaught' },
    created_on: '2026-05-29T00:00:00Z',
    environment: env,
  } as Bundle['request'],
  body: new Uint8Array([1, 2, 3]),
  fileName: 'p.zip',
});

const DEAD_PID = 999_999; // ESRCH → the owner process is gone
const LIVE_PID = process.pid; // a real, alive pid

/** Write a subtree's owner.json with the given pid (defines whether the liveness gate sees it as dead). */
const writeOwner = (dataDir: string, sub: string, pid: number): void => {
  ensureDir(join(dataDir, sub));
  writeFileSecure(
    join(dataDir, sub, 'owner.json'),
    JSON.stringify({ instanceId: sub, pid, threadId: 0, startedAt: 1, version: '0' }),
  );
};

/** Seed a DEAD sibling subtree (dead-pid owner) with a pending bundle blob. */
const seedPendingBundle = (dataDir: string, sub: string, id: string, b: Bundle): void => {
  writeOwner(dataDir, sub, DEAD_PID);
  createNodeBundleStore(join(dataDir, sub, 'pending')).put(id, serializeBundle(b));
};

/** Seed a DEAD sibling subtree (dead-pid owner) with a closed chunk generation + a pending-incident marker. */
const seedIncident = (dataDir: string, sub: string, gen: number, incidentId: string): void => {
  writeOwner(dataDir, sub, DEAD_PID);
  const root = join(dataDir, sub);
  const backend = createFileChunkBackend(createFsChunkStorage(join(root, 'capture')), {
    generation: gen,
    cleanOtherGenerations: false,
  });
  backend.openPart({ generation: gen, number: 0 }, gen);
  backend.appendEntry({ generation: gen, number: 0 }, {
    type: 'log',
    timestamp: 1,
    serialized: JSON.stringify({ timestamp: 1, data: incidentId }),
  } as StoredEntry);
  backend.closePart({ generation: gen, number: 0 }, gen + 100, 0);
  createNodeReportMarkerStore(join(root, 'incidents')).put({
    generation: gen,
    request: createReportingRequest({ source: { type: 'crash' }, id: incidentId }),
    attributes: {},
    userIdentifier: null,
  });
};

/** Seed a DEAD sibling subtree with a closed capture generation (no report marker). */
const seedCaptureGen = (dataDir: string, sub: string, gen: number, data: unknown): void => {
  writeOwner(dataDir, sub, DEAD_PID);
  const backend = createFileChunkBackend(
    createFsChunkStorage(join(dataDir, sub, 'capture')),
    { generation: gen, cleanOtherGenerations: false },
  );
  backend.openPart({ generation: gen, number: 0 }, gen);
  backend.appendEntry({ generation: gen, number: 0 }, {
    type: 'log',
    timestamp: 1,
    serialized: JSON.stringify({ timestamp: 1, data }),
  } as StoredEntry);
  backend.closePart({ generation: gen, number: 0 }, gen + 100, 0);
};

/** Write a crashpad-session marker linking the subtree's generation + session to a Crashpad dir. */
const seedCrashpadMarker = (dataDir: string, sub: string, gen: number, sessionId: string): void => {
  createNodeCrashpadSessionMarkerStore(join(dataDir, sub, 'incidents')).put({
    generation: gen,
    sessionId,
    dumpDir: '/crashpad/db',
    attributes: {},
    userIdentifier: null,
  });
};

const dump = (name: string, ...bytes: number[]): HarvestedDump => ({ name, data: new Uint8Array(bytes) });

/** A fake native-crash source over a fixed dump list, recording claims. */
const fakeNativeSource = (dumps: HarvestedDump[]): NativeCrashSource & { claims: string[] } => {
  const claims: string[] = [];
  return {
    claims,
    harvest: (_m: CrashpadSessionMarker) => dumps,
    claim: (_m: CrashpadSessionMarker, name: string) => {
      claims.push(name);
    },
  };
};

const crashJsonOf = (bundle: Bundle): unknown =>
  JSON.parse(strFromU8(unzipSync(bundle.body)['crash.json'] as Uint8Array));

describe('recoverInstances', () => {
  it('re-uploads a dead sibling’s pending bundle and removes its subtree', async () => {
    const dir = mkDir();
    seedPendingBundle(dir, '9-9-dead', 'b1', aBundle('prior crash'));
    const pipe = fakePipeline();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
    });

    expect(pipe.enqueue).toHaveBeenCalledTimes(1);
    expect(pipe.bundles[0]?.request.summary).toBe('prior crash');
    expect(existsSync(join(dir, '9-9-dead'))).toBe(false); // fully delivered → subtree removed
  });

  it('rebuilds + delivers a dead sibling’s detected incident from its chunks, then removes the subtree', async () => {
    const dir = mkDir();
    seedIncident(dir, '9-9-dead', 500, 'inc-1');
    const pipe = fakePipeline();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
    });

    expect(pipe.enqueue).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, '9-9-dead'))).toBe(false);
  });

  it('never touches this instance’s OWN subtree or a foreign (non-instance) entry', async () => {
    const dir = mkDir();
    seedPendingBundle(dir, '1-0-live', 'own', aBundle('own — must not recover'));
    ensureDir(join(dir, 'capture')); // a stray non-instance dir (e.g. a flat-layout leftover)
    writeFileSync(join(dir, 'notes.txt'), 'foreign');
    const pipe = fakePipeline();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
    });

    expect(pipe.enqueue).not.toHaveBeenCalled(); // own subtree + foreign entries are skipped
    expect(existsSync(join(dir, '1-0-live'))).toBe(true);
    expect(existsSync(join(dir, 'capture'))).toBe(true);
    expect(existsSync(join(dir, 'notes.txt'))).toBe(true);
  });

  it('KEEPS a dead sibling’s subtree for retry when an upload is not confirmed', async () => {
    const dir = mkDir();
    seedPendingBundle(dir, '9-9-dead', 'b1', aBundle('flaky'));
    const pipe = fakePipeline({ ok: false }); // delivery not confirmed

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
    });

    expect(pipe.enqueue).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, '9-9-dead'))).toBe(true); // NOT removed — left for a later launch
    expect(existsSync(join(dir, '9-9-dead', 'pending'))).toBe(true); // the blob survives
  });

  it('KEEPS the blob and reports when an upload REJECTS (not just declines)', async () => {
    const dir = mkDir();
    seedPendingBundle(dir, '9-9-dead', 'b1', aBundle('rejecting'));
    const onError = vi.fn();
    const pipe = {
      enqueue: vi.fn(() => Promise.reject(new Error('transport exploded'))),
      flush: () => Promise.resolve(true),
      drop: () => {},
    };

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
      onError,
    });

    expect(onError).toHaveBeenCalledWith(expect.any(Error));
    expect(existsSync(join(dir, '9-9-dead'))).toBe(true); // kept for retry
  });

  it('routes a sibling whose store cannot be listed (pending is a FILE) to onError, leaving it', async () => {
    const dir = mkDir();
    writeOwner(dir, '9-9-dead', DEAD_PID);
    writeFileSync(join(dir, '9-9-dead', 'pending'), 'x'); // `pending` is a FILE → listFiles throws ENOTDIR
    const onError = vi.fn();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: fakePipeline(),
      context,
      onError,
    });

    expect(onError).toHaveBeenCalledWith(expect.any(Error)); // the per-subtree failure is caught
    expect(existsSync(join(dir, '9-9-dead'))).toBe(true); // left in place to retry on a later launch
  });

  it('purges an unparseable bundle blob (reports it) and removes the otherwise-empty subtree', async () => {
    const dir = mkDir();
    writeOwner(dir, '9-9-dead', DEAD_PID);
    const pendingDir = join(dir, '9-9-dead', 'pending');
    ensureDir(pendingDir);
    writeFileSync(join(pendingDir, 'torn.bundle'), 'not-a-frame'); // a torn durable blob
    const pipe = fakePipeline();
    const onError = vi.fn();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
      onError,
    });

    expect(pipe.enqueue).not.toHaveBeenCalled(); // nothing deliverable
    expect(onError).toHaveBeenCalledWith(expect.any(Error)); // the torn blob was reported
    expect(existsSync(join(dir, '9-9-dead'))).toBe(false); // purged → empty → subtree removed
  });

  it('synthesizes a session-stitched native crash from a dead sibling’s dump, then removes the subtree', async () => {
    const dir = mkDir();
    seedCaptureGen(dir, '9-9-dead', 800, { m: 'before-native-crash' });
    seedCrashpadMarker(dir, '9-9-dead', 800, 'sess-dead');
    const source = fakeNativeSource([dump('main.dmp', 7, 8, 9)]);
    const pipe = fakePipeline();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
      nativeCrashSource: source,
    });

    expect(pipe.enqueue).toHaveBeenCalledTimes(1);
    const bundle = pipe.bundles[0] as Bundle;
    expect(bundle.request.type).toBe('crash');
    expect(crashJsonOf(bundle)).toEqual({
      exception_type: 'native',
      ndkCrash: true,
      minidumpFile: 'main.dmp',
    });
    // The .dmp rides as an attachment and the crashed session's capture is stitched in.
    expect(Array.from(unzipSync(bundle.body)['main.dmp'] as Uint8Array)).toEqual([7, 8, 9]);
    expect(JSON.parse(strFromU8(unzipSync(bundle.body)['logs.json'] as Uint8Array))).toEqual([
      { m: 'before-native-crash' },
    ]);
    expect(source.claims).toEqual(['main.dmp']); // delivered → claimed
    expect(existsSync(join(dir, '9-9-dead'))).toBe(false); // fully drained → subtree removed
  });

  it('clears a clean-exit sibling’s crashpad marker (no dumps) and removes the subtree — no upload', async () => {
    const dir = mkDir();
    seedCaptureGen(dir, '9-9-dead', 800, { m: 'clean-session' });
    seedCrashpadMarker(dir, '9-9-dead', 800, 'sess-clean');
    const source = fakeNativeSource([]); // no native crash happened
    const pipe = fakePipeline();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
      nativeCrashSource: source,
    });

    expect(pipe.enqueue).not.toHaveBeenCalled(); // nothing to recover
    expect(existsSync(join(dir, '9-9-dead'))).toBe(false); // stale marker cleared → subtree removed
  });

  it('KEEPS the subtree, crashpad marker AND capture when a native dump is not delivered', async () => {
    const dir = mkDir();
    seedCaptureGen(dir, '9-9-dead', 800, { m: 'native-capture' });
    seedCrashpadMarker(dir, '9-9-dead', 800, 'sess-dead');
    const source = fakeNativeSource([dump('main.dmp', 1)]);
    const pipe = fakePipeline({ ok: false }); // delivery not confirmed

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
      nativeCrashSource: source,
    });

    expect(source.claims).toEqual([]); // not claimed → re-harvestable
    expect(existsSync(join(dir, '9-9-dead'))).toBe(true); // kept for retry
    // The crashpad marker survives for the retry…
    expect(
      createNodeCrashpadSessionMarkerStore(join(dir, '9-9-dead', 'incidents')).read()?.sessionId,
    ).toBe('sess-dead');
    // …and so does the crashed generation's CAPTURE DATA — keepGenerations protected gen 800 from the
    // recoverReports sweep (without it the sweep frees the generation and the native retry loses the
    // session recording).
    const survivor = createFileChunkBackend(createFsChunkStorage(join(dir, '9-9-dead', 'capture')), {
      generation: -1,
      cleanOtherGenerations: false,
    });
    expect(await survivor.listGenerations()).toContain(800);
  });

  it('skips native recovery entirely when no nativeCrashSource is configured', async () => {
    const dir = mkDir();
    seedCaptureGen(dir, '9-9-dead', 800, { m: 'orphan' });
    seedCrashpadMarker(dir, '9-9-dead', 800, 'sess-orphan');
    const pipe = fakePipeline();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context, // no nativeCrashSource
    });

    expect(pipe.enqueue).not.toHaveBeenCalled(); // native path not run
    expect(existsSync(join(dir, '9-9-dead'))).toBe(false); // no report incident → subtree swept
  });

  it('swallows an unreadable dataDir with no onError provided (default no-op sink)', async () => {
    const file = join(mkDir(), 'a-file');
    writeFileSync(file, 'x');
    await expect(
      recoverInstances({
        dataDir: file,
        ownInstanceId: '1-0-live',
        uploadPipeline: fakePipeline(),
        context,
      }),
    ).resolves.toBeUndefined(); // the default no-op sink absorbs the listFiles failure
  });

  it('NEVER touches a LIVE sibling (alive pid + fresh heartbeat)', async () => {
    const dir = mkDir();
    seedPendingBundle(dir, '9-9-alive', 'b1', aBundle('do not touch'));
    writeOwner(dir, '9-9-alive', LIVE_PID); // override to an alive pid
    writeFileSecure(join(dir, '9-9-alive', '.live'), ''); // a fresh heartbeat
    const pipe = fakePipeline();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
    });

    expect(pipe.enqueue).not.toHaveBeenCalled(); // a live sibling is left entirely alone
    expect(existsSync(join(dir, '9-9-alive'))).toBe(true);
  });

  it('recovers ONLY the dead sibling when several LIVE siblings are also present (no clobber)', async () => {
    const dir = mkDir();
    // Two live siblings (alive pid + fresh heartbeat) + one dead sibling, all with pending bundles.
    seedPendingBundle(dir, '7-0-liveA', 'a', aBundle('liveA — keep'));
    writeOwner(dir, '7-0-liveA', LIVE_PID);
    writeFileSecure(join(dir, '7-0-liveA', '.live'), '');
    seedPendingBundle(dir, '7-1-liveB', 'b', aBundle('liveB — keep'));
    writeOwner(dir, '7-1-liveB', LIVE_PID);
    writeFileSecure(join(dir, '7-1-liveB', '.live'), '');
    seedPendingBundle(dir, '9-9-dead', 'd', aBundle('dead — recover'));
    const pipe = fakePipeline();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
    });

    expect(pipe.enqueue).toHaveBeenCalledTimes(1); // exactly the dead one
    expect(pipe.bundles[0]?.request.summary).toBe('dead — recover');
    expect(existsSync(join(dir, '9-9-dead'))).toBe(false); // recovered + removed
    expect(existsSync(join(dir, '7-0-liveA'))).toBe(true); // both live siblings left untouched
    expect(existsSync(join(dir, '7-1-liveB'))).toBe(true);
  });

  it('skips an ARMING sibling (alive pid, no heartbeat written yet)', async () => {
    const dir = mkDir();
    seedPendingBundle(dir, '9-9-arming', 'b1', aBundle('arming'));
    writeOwner(dir, '9-9-arming', LIVE_PID); // alive pid, but NO .live heartbeat yet
    const pipe = fakePipeline();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
    });

    // alive pid + no heartbeat → a still-arming instance → kept (this proves the heartbeat read is wired,
    // independent of the alive+fresh case; with the alive+stale case it pins the whole alive-pid branch).
    expect(pipe.enqueue).not.toHaveBeenCalled();
    expect(existsSync(join(dir, '9-9-arming'))).toBe(true);
  });

  it('skips a sibling with no owner.json (cannot liveness-check → leave it)', async () => {
    const dir = mkDir();
    seedPendingBundle(dir, '9-9-dead', 'b1', aBundle('x'));
    rmSync(join(dir, '9-9-dead', 'owner.json')); // an early-crash subtree with no owner record
    const pipe = fakePipeline();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
    });

    expect(pipe.enqueue).not.toHaveBeenCalled();
    expect(existsSync(join(dir, '9-9-dead'))).toBe(true);
  });

  it('recovers a sibling whose pid is alive but heartbeat is stale beyond the patient window', async () => {
    const dir = mkDir();
    seedPendingBundle(dir, '9-9-stale', 'b1', aBundle('stale'));
    writeOwner(dir, '9-9-stale', LIVE_PID); // alive pid …
    const liveFile = join(dir, '9-9-stale', '.live');
    writeFileSecure(liveFile, '');
    utimesSync(liveFile, 1000, 1000); // … but an ancient heartbeat (mtime = 1_000_000 ms)
    const pipe = fakePipeline();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
      now: () => 1_000_000 + 200_000, // 200s later, > the 120s patient window
      patientMs: 120_000,
    });

    expect(pipe.enqueue).toHaveBeenCalledTimes(1); // stale beyond patient → dead → recovered
    expect(existsSync(join(dir, '9-9-stale'))).toBe(false);
  });

  it('routes a missing/unreadable dataDir to onError and never throws', async () => {
    const file = join(mkDir(), 'a-file');
    writeFileSync(file, 'x'); // listFiles on a FILE throws ENOTDIR
    const onError = vi.fn();

    await expect(
      recoverInstances({
        dataDir: file,
        ownInstanceId: '1-0-live',
        uploadPipeline: fakePipeline(),
        context,
        onError,
      }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });
});
