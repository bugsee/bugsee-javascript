import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Bundle,
  type CrashpadSessionMarker,
  createFileChunkBackend,
  createReportingRequest,
  type HarvestedDump,
  type IdentifiedBundle,
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
  runtime: { type: 'node', version: '' },
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

const aBundle = (summary: string, reportId?: string): IdentifiedBundle => ({
  request: {
    type: 'crash',
    summary,
    severity: 3,
    source: { type: 'crash', mechanism: 'uncaught' },
    created_on: '2026-05-29T00:00:00Z',
    environment: env,
  } as Bundle['request'],
  body: new Uint8Array([1, 2, 3]),
  fileName: 'p.zip',
  ...(reportId !== undefined ? { reportId } : {}),
});

const DEAD_PID = 999_999; // ESRCH → the owner process is gone
const LIVE_PID = process.pid; // a real, alive pid

/** Write a subtree's owner.json with the given pid (defines whether the liveness gate sees it as dead). */
const writeOwner = (dataDir: string, sub: string, pid: number, threadId = 0): void => {
  ensureDir(join(dataDir, sub));
  writeFileSecure(
    join(dataDir, sub, 'owner.json'),
    JSON.stringify({ instanceId: sub, pid, threadId, startedAt: 1, version: '0' }),
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
  const backend = createFileChunkBackend(createFsChunkStorage(join(dataDir, sub, 'capture')), {
    generation: gen,
    cleanOtherGenerations: false,
  });
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

const dump = (name: string, ...bytes: number[]): HarvestedDump => ({
  name,
  data: new Uint8Array(bytes),
});

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
  it('is THROW-SAFE per subtree: an unreadable owner.json cannot abort the whole scan', async () => {
    // `readOwner` → `readFileBytes` re-throws every non-ENOENT errno, and it used to sit outside every
    // try in the loop. A single unreadable `owner.json` (EACCES when a root-started and a dropped-
    // privilege process share one dataDir; EISDIR, as staged here, without needing privileges) then
    // rejected `recoverInstances` — and the launch's release pass hung off a bare `.then()`, so a
    // held-back bundle was never delivered on ANY launch. The trigger is persistent on-disk state.
    const dir = mkDir();
    // The bad subtree sorts FIRST, so a throw here would take the good one with it.
    mkdirSync(join(dir, '9-9-abad'), { recursive: true });
    mkdirSync(join(dir, '9-9-abad', 'owner.json')); // a directory where the file belongs → EISDIR
    writeOwner(dir, '9-9-bgood', DEAD_PID);
    seedPendingBundle(dir, '9-9-bgood', 'b1', aBundle('survivor'));
    const pipeline = fakePipeline();
    const errors: unknown[] = [];

    await expect(
      recoverInstances({
        dataDir: dir,
        ownInstanceId: '1-0-live',
        uploadPipeline: pipeline,
        context,
        onError: (e) => errors.push(e),
      }),
    ).resolves.toBeUndefined();

    expect(pipeline.bundles.map((b) => b.request.summary)).toEqual(['survivor']);
    expect(errors).toHaveLength(1); // the unreadable subtree is REPORTED, not silently skipped
    expect(existsSync(join(dir, '9-9-abad'))).toBe(true); // …and left alone for a later launch
  });

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

  // SEV1 (recovery double-upload): the process can die AFTER the crash bundle reaches the durable
  // `pending/` queue but BEFORE the upload settles — client.ts's submitReport clears the report marker
  // only once that upload settles, so a dead sibling can leave BOTH a pending bundle AND its incident's
  // still-present marker for the SAME crash. Both used to be recovered independently (events_count +2
  // per incident, confirmed on 4 samples). Exactly one upload must reach the pipeline.
  it('uploads an incident exactly ONCE when its bundle reached the durable queue before the crash', async () => {
    const dir = mkDir();
    // Same incident, both traces left behind: the marker + chunks (seedIncident) AND the already-
    // assembled bundle that reached `pending/` before the process died (the crash window).
    seedIncident(dir, '9-9-dead', 500, 'inc-1');
    createNodeBundleStore(join(dir, '9-9-dead', 'pending')).put(
      'already-staged',
      serializeBundle(aBundle('inc-1 (pre-crash assembly)', 'inc-1')),
    );
    const pipe = fakePipeline();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
    });

    // ONE upload, and it is the ALREADY-ASSEMBLED bundle: the staged blob is the incident's primary
    // artifact, so it is delivered and its now-redundant marker retired — nothing is ever dropped
    // un-uploaded.
    expect(pipe.enqueue).toHaveBeenCalledTimes(1); // NOT twice
    expect(pipe.bundles.map((b) => b.request.summary)).toEqual(['inc-1 (pre-crash assembly)']);
    expect(existsSync(join(dir, '9-9-dead'))).toBe(false); // fully drained → subtree removed
  });

  // The case NEITHER suite had, and the one the `hadMarkers` proxy key silently lost: the staged bundle
  // belongs to a DIFFERENT incident than the pending marker. It happens for real two ways — client.ts's
  // `result.then(clear, clear)` clears a marker on a 5xx `{ok:false}` while durable-upload-pipeline.ts's
  // `settled()` KEEPS that blob; and node/launch.ts hands `recoverInstances` the DURABLE pipeline, so every
  // bundle recovered from a dead sibling is re-staged into this instance's `pending/` with no marker ever.
  // Both incidents must be delivered.
  // A REFUSED bundle is settled, exactly as the live durable pipeline treats it: gating on `ok` alone
  // re-uploaded a 4xx-rejected bundle at every launch forever, and never retired its marker either — on
  // node bounded only by the 7-day instance sweep, on browser/worker by nothing at all.
  it('frees a PERMANENTLY refused bundle and its marker instead of retrying it every launch', async () => {
    const dir = mkDir();
    seedIncident(dir, '9-9-dead', 500, 'inc-1');
    createNodeBundleStore(join(dir, '9-9-dead', 'pending')).put(
      'refused',
      serializeBundle(aBundle('inc-1 (pre-crash assembly)', 'inc-1')),
    );
    const pipe = fakePipeline({ ok: false, permanent: true });

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
    });

    expect(pipe.enqueue).toHaveBeenCalledTimes(1);
    expect(existsSync(join(dir, '9-9-dead'))).toBe(false); // blob AND marker gone → subtree removed
  });

  it('KEEPS a retryably-refused bundle (the sibling of the above)', async () => {
    const dir = mkDir();
    seedPendingBundle(dir, '9-9-dead', 'b1', aBundle('retry me'));
    const pipe = fakePipeline({ ok: false });

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
    });

    expect(createNodeBundleStore(join(dir, '9-9-dead', 'pending')).list()).toEqual(['b1']);
  });

  // R2-1: an injected `bundleStore` is the integrator's own, stable across launches and outside the
  // per-instance layout — so it can hold a dead sibling's staged bundle while that sibling's marker is
  // still here. The scan hands each sibling's marker store to `reconcileOwnQueue` and withholds whatever
  // it settled with, so the marker leg does not rebuild the same incident a second time.
  it('withholds the incidents an injected queue reconciled from the marker leg', async () => {
    const dir = mkDir();
    seedIncident(dir, '9-9-dead', 500, 'inc-1');
    const pipe = fakePipeline();
    const seen: Array<string[]> = [];

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
      reconcileOwnQueue: (markers) => {
        seen.push(markers.list().map((m) => m.request.id)); // THIS sibling's markers, hydrated
        return Promise.resolve(new Set(['inc-1'])); // …settled with, but deliberately NOT retired here
      },
    });

    expect(seen).toEqual([['inc-1']]);
    expect(pipe.enqueue).not.toHaveBeenCalled(); // the marker leg stood down — no rebuild
    // The marker is untouched by the withholding itself, so a queue attempt that failed is retried next
    // launch, and the subtree survives for it.
    expect(
      createNodeReportMarkerStore(join(dir, '9-9-dead', 'incidents'))
        .list()
        .map((m) => m.request.id),
    ).toEqual(['inc-1']);
    expect(existsSync(join(dir, '9-9-dead'))).toBe(true);
  });

  // Both queue legs can withhold at once — this subtree's own `pending/` covers one incident and the
  // injected store covers another. The marker leg must stand down for the UNION, not for either alone.
  //
  // Every upload FAILS here on purpose: a delivered blob retires its marker, which would mask the skip set
  // entirely. Only an undelivered one leaves the marker standing, so `skipReportIds` is what stops the
  // second attempt.
  it('withholds the union of both queue legs from the marker leg', async () => {
    const dir = mkDir();
    seedIncident(dir, '9-9-dead', 500, 'inc-1'); // staged in this subtree's own pending/
    seedIncident(dir, '9-9-dead', 501, 'inc-2'); // staged in the injected store
    seedIncident(dir, '9-9-dead', 502, 'inc-3'); // owed to nobody but the marker leg
    createNodeBundleStore(join(dir, '9-9-dead', 'pending')).put(
      'staged-1',
      serializeBundle(aBundle('inc-1 (staged)', 'inc-1')),
    );
    const pipe = fakePipeline({ ok: false });

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
      reconcileOwnQueue: () => Promise.resolve(new Set(['inc-2'])),
    });

    // inc-1 attempted from its blob, inc-2 owned by the injected queue, inc-3 the only rebuild.
    expect(pipe.bundles.map((b) => (b as IdentifiedBundle).reportId)).toEqual(['inc-1', 'inc-3']);
    expect(pipe.bundles[0]?.request.summary).toBe('inc-1 (staged)'); // the blob verbatim, not a rebuild
  });

  it('still rebuilds the incidents an injected queue did NOT claim', async () => {
    const dir = mkDir();
    seedIncident(dir, '9-9-dead', 500, 'inc-1');
    seedIncident(dir, '9-9-dead', 501, 'inc-2');
    const pipe = fakePipeline();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
      reconcileOwnQueue: () => Promise.resolve(new Set(['inc-1'])),
    });

    expect(pipe.bundles.map((b) => (b as IdentifiedBundle).reportId)).toEqual(['inc-2']);
  });

  it('replays a pending bundle whose incident has NO marker, even when the sibling has other markers', async () => {
    const dir = mkDir();
    seedIncident(dir, '9-9-dead', 500, 'inc-1'); // marker + chunks for inc-1
    createNodeBundleStore(join(dir, '9-9-dead', 'pending')).put(
      'blob-inc-2',
      serializeBundle(aBundle('inc-2 (staged, its marker already cleared)', 'inc-2')),
    );
    const pipe = fakePipeline();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
    });

    const summaries = pipe.bundles.map((b) => b.request.summary).sort();
    expect(summaries).toEqual(['Crash', 'inc-2 (staged, its marker already cleared)']); // BOTH, never one
    expect(pipe.enqueue).toHaveBeenCalledTimes(2);
    expect(existsSync(join(dir, '9-9-dead'))).toBe(false);
  });

  it('replays a pending bundle written by an older SDK (no report id in its frame) rather than freeing it', async () => {
    const dir = mkDir();
    seedIncident(dir, '9-9-dead', 500, 'inc-1');
    createNodeBundleStore(join(dir, '9-9-dead', 'pending')).put(
      'legacy-blob',
      serializeBundle(aBundle('legacy frame — no report id')), // pre-upgrade frame: nothing ties it to a marker
    );
    const pipe = fakePipeline();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
    });

    expect(pipe.bundles.map((b) => b.request.summary).sort()).toEqual([
      'Crash',
      'legacy frame — no report id',
    ]);
    expect(existsSync(join(dir, '9-9-dead'))).toBe(false);
  });

  it('leaves the redundant pending bundle for retry when marker-based recovery does not fully drain', async () => {
    const dir = mkDir();
    seedIncident(dir, '9-9-dead', 500, 'inc-1');
    createNodeBundleStore(join(dir, '9-9-dead', 'pending')).put(
      'already-staged',
      serializeBundle(aBundle('inc-1 (pre-crash assembly)', 'inc-1')),
    );
    const pipe = fakePipeline({ ok: false }); // marker-based delivery fails

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
    });

    // The staged bundle's upload failed → BOTH traces of inc-1 are kept (blob + marker) and the marker
    // leg does not attempt the same incident a second time in this pass. Next launch retries from the blob.
    expect(pipe.enqueue).toHaveBeenCalledTimes(1); // the bundle-queue attempt only — NOT the marker leg too
    expect(pipe.bundles.map((b) => b.request.summary)).toEqual(['inc-1 (pre-crash assembly)']);
    expect(createNodeBundleStore(join(dir, '9-9-dead', 'pending')).list()).toEqual([
      'already-staged',
    ]);
    expect(
      createNodeReportMarkerStore(join(dir, '9-9-dead', 'incidents'))
        .list()
        .map((m) => m.request.id),
    ).toEqual(['inc-1']); // the marker survives too — the incident is still owed
    expect(existsSync(join(dir, '9-9-dead'))).toBe(true); // kept for retry
  });

  it('still recovers an ordinary pending bundle when its sibling has NO report marker at all', async () => {
    const dir = mkDir();
    // A sibling that never had capture recovery (or crashed before any incident) — bundle-queue
    // recovery remains the sole, unaffected path (existing behavior, no marker to defer to).
    seedPendingBundle(dir, '9-9-dead', 'b1', aBundle('no marker for this one'));
    const pipe = fakePipeline();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
    });

    expect(pipe.enqueue).toHaveBeenCalledTimes(1);
    expect(pipe.bundles[0]?.request.summary).toBe('no marker for this one');
    expect(existsSync(join(dir, '9-9-dead'))).toBe(false);
  });

  // --- the recovery claim (two launches must not recover the same dead subtree at once) ------------

  it('SKIPS a dead subtree another LIVE launch is already recovering', async () => {
    // Node had no claim at all: two simultaneous launches both recovered the same dead sibling and both
    // uploaded it. Browser has been serialized by Web Locks since #166; this is node's equivalent.
    const dir = mkDir();
    seedPendingBundle(dir, '9-9-dead', 'b1', aBundle('prior crash'));
    writeFileSecure(
      join(dir, '9-9-dead', '.recovering'),
      JSON.stringify({ claimerId: `${LIVE_PID}-0-other`, claimedAt: 1 }),
    );
    const pipe = fakePipeline();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
    });

    expect(pipe.bundles).toHaveLength(0); // the other launch owns it
    expect(existsSync(join(dir, '9-9-dead'))).toBe(true); // …and it is left intact for them
  });

  it('TAKES OVER a claim whose holder died mid-recovery, rather than stranding the subtree', async () => {
    // The failure mode a naive claim introduces: a recoverer that crashes half way leaves a claim file
    // nobody can clear, and the incident is then delivered on no launch ever again.
    const dir = mkDir();
    seedPendingBundle(dir, '9-9-dead', 'b1', aBundle('prior crash'));
    writeFileSecure(
      join(dir, '9-9-dead', '.recovering'),
      JSON.stringify({ claimerId: `${DEAD_PID}-0-gone`, claimedAt: 1 }),
    );
    const pipe = fakePipeline();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
    });

    expect(pipe.bundles.map((b) => b.request.summary)).toEqual(['prior crash']);
    expect(existsSync(join(dir, '9-9-dead'))).toBe(false);
  });

  it('treats an UNPARSEABLE claim as stale — a corrupt file must not strand a subtree either', async () => {
    const dir = mkDir();
    seedPendingBundle(dir, '9-9-dead', 'b1', aBundle('prior crash'));
    writeFileSecure(join(dir, '9-9-dead', '.recovering'), 'not json');
    const pipe = fakePipeline();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
    });

    expect(pipe.bundles.map((b) => b.request.summary)).toEqual(['prior crash']);
  });

  it('treats a well-formed claim naming a NON-instance holder as stale', async () => {
    // Distinct from the unparseable case above: this file parses, so `readClaim` returns a claim and the
    // holder-shape check is the only thing standing between it and stranding the subtree for ever. A
    // mutation that read an unparseable HOLDER as "live" survived until this case existed.
    const dir = mkDir();
    seedPendingBundle(dir, '9-9-dead', 'b1', aBundle('prior crash'));
    writeFileSecure(
      join(dir, '9-9-dead', '.recovering'),
      JSON.stringify({ claimerId: 'not-an-instance-id', claimedAt: 1 }),
    );
    const pipe = fakePipeline();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
    });

    expect(pipe.bundles.map((b) => b.request.summary)).toEqual(['prior crash']);
    expect(existsSync(join(dir, '9-9-dead'))).toBe(false);
  });

  it('RELEASES its claim when the subtree survives for retry, so the next launch can take it', async () => {
    // A kept subtree (undelivered upload) must not keep a claim naming a process that has since exited —
    // that would be indistinguishable from the strand above until the claimer's pid was reaped.
    const dir = mkDir();
    seedPendingBundle(dir, '9-9-dead', 'b1', aBundle('prior crash'));
    const pipe = fakePipeline({ ok: false });

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
    });

    expect(existsSync(join(dir, '9-9-dead'))).toBe(true); // kept for retry
    expect(existsSync(join(dir, '9-9-dead', '.recovering'))).toBe(false); // …and unclaimed
  });

  it('releases the claim even when recovery THROWS, so a failure cannot strand the subtree', async () => {
    const dir = mkDir();
    writeOwner(dir, '9-9-dead', DEAD_PID);
    // `pending` as a FILE makes the bundle store unlistable → recoverSubtree throws.
    writeFileSecure(join(dir, '9-9-dead', 'pending'), 'x');
    const errors: unknown[] = [];

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: fakePipeline(),
      context,
      onError: (e) => errors.push(e),
    });

    expect(errors.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, '9-9-dead', '.recovering'))).toBe(false);
  });

  it('two CONCURRENT recoveries of the same dead subtree upload it exactly once', async () => {
    // The defect itself, rather than its parts: before the claim, both passes drained the same queue and
    // the collector received the bundle twice. Both claimants name THIS process, so the loser sees a
    // genuinely live holder — no invented liveness.
    const dir = mkDir();
    seedPendingBundle(dir, '9-9-dead', 'b1', aBundle('prior crash'));
    const pipe = fakePipeline();
    const run = (id: string) =>
      recoverInstances({
        dataDir: dir,
        ownInstanceId: id,
        uploadPipeline: pipe,
        context,
      });

    await Promise.all([run(`${LIVE_PID}-0-a`), run(`${LIVE_PID}-0-b`)]);

    expect(pipe.bundles.map((b) => b.request.summary)).toEqual(['prior crash']);
  });

  // --- one incident, two subtrees (the cross-subtree double-upload) --------------------------------

  it('uploads an incident ONCE when its BUNDLE and its MARKER are in different dead subtrees', async () => {
    // How this arises: a recovery stages a dead sibling's rebuilt bundle into the RECOVERER's queue and
    // the upload then fails. The marker stays with the original sibling, the blob now lives in the
    // recoverer's subtree, and when that recoverer later dies both are dead siblings — so the next launch
    // replays the blob AND rebuilds the same incident from the marker. Byte-identical, and still two.
    const dir = mkDir();
    seedPendingBundle(dir, '9-9-aqueue', 'b1', aBundle('prior crash', 'R1'));
    seedIncident(dir, '9-9-bmarker', 5, 'R1');
    const pipe = fakePipeline();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
    });

    expect(pipe.bundles).toHaveLength(1);
    expect(pipe.bundles[0]?.request.summary).toBe('prior crash'); // the staged bundle, not a rebuild
    // BOTH subtrees are gone: the marker in the other subtree was retired by the settled blob. Leaving it
    // would merely postpone the duplicate to the next launch, when the blob is no longer there to shadow
    // it — which is the same defect with a delay.
    expect(existsSync(join(dir, '9-9-aqueue'))).toBe(false);
    expect(existsSync(join(dir, '9-9-bmarker'))).toBe(false);
  });

  it('does so in EITHER scan order — the marker subtree sorting first must not decide it', () => {
    // The same case with the names swapped, so the marker subtree is visited first. Nothing may depend
    // on directory order: an incident's two halves have no reason to sort conveniently.
    return (async () => {
      const dir = mkDir();
      seedIncident(dir, '9-9-amarker', 5, 'R1');
      seedPendingBundle(dir, '9-9-bqueue', 'b1', aBundle('prior crash', 'R1'));
      const pipe = fakePipeline();

      await recoverInstances({
        dataDir: dir,
        ownInstanceId: '1-0-live',
        uploadPipeline: pipe,
        context,
      });

      expect(pipe.bundles).toHaveLength(1);
      expect(pipe.bundles[0]?.request.summary).toBe('prior crash');
    })();
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

  it('KEEPS a dead sibling’s subtree when a report incident is undelivered (marker retained)', async () => {
    const dir = mkDir();
    seedIncident(dir, '9-9-dead', 500, 'inc-stuck'); // capture gen + a pending report marker, no bundles
    const pipe = fakePipeline({ ok: false }); // the incident upload is not confirmed

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
    });

    expect(pipe.enqueue).toHaveBeenCalledTimes(1); // the incident was attempted
    // The report marker is retained (undelivered), so the subtree is NOT removed even though there are no
    // bundles and no native crash — the marker clause of the removal gate holds it.
    expect(existsSync(join(dir, '9-9-dead'))).toBe(true);
    expect(createNodeReportMarkerStore(join(dir, '9-9-dead', 'incidents')).list()).toHaveLength(1);
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
    // Native shape + the provenance the assembler stamps (Wave 5.4a). This is the path that needs it
    // most: the incident is SYNTHESIZED at the next launch from a dead sibling's harvested dump, so the
    // routing key cannot come from the crashed process — it comes from the recovered session's own
    // environment, which is what the stamp copies.
    expect(crashJsonOf(bundle)).toEqual({
      exception_type: 'native',
      ndkCrash: true,
      minidumpFile: 'main.dmp',
      source_sdk: 'javascript',
      source_platform: 'node',
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
    const survivor = createFileChunkBackend(
      createFsChunkStorage(join(dir, '9-9-dead', 'capture')),
      {
        generation: -1,
        cleanOtherGenerations: false,
      },
    );
    expect(await survivor.listGenerations()).toContain(800);
  });

  it('clears the crashpad marker on complete even when the subtree is kept alive by an undelivered bundle', async () => {
    const dir = mkDir();
    seedCaptureGen(dir, '9-9-dead', 800, { m: 'native' });
    seedCrashpadMarker(dir, '9-9-dead', 800, 'sess-dead');
    // A separate UNDELIVERED durable bundle keeps the subtree from being swept, so marker-clearing is
    // observable INDEPENDENTLY of subtree removal (which would otherwise mask it).
    createNodeBundleStore(join(dir, '9-9-dead', 'pending')).put(
      'stuck',
      serializeBundle(aBundle('stuck')),
    );
    const source = fakeNativeSource([dump('main.dmp', 1)]);
    // The native crash bundle (summary 'Native crash') uploads OK → complete; the 'stuck' bundle does NOT.
    const pipe = {
      enqueue: vi.fn((b: Bundle) => Promise.resolve({ ok: b.request.summary === 'Native crash' })),
      flush: () => Promise.resolve(true),
      drop: () => {},
    };

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
      nativeCrashSource: source,
    });

    expect(source.claims).toEqual(['main.dmp']); // native delivered → complete
    expect(existsSync(join(dir, '9-9-dead'))).toBe(true); // subtree KEPT by the undelivered bundle
    // The crashpad marker was cleared on complete — proven with the subtree still present.
    expect(
      createNodeCrashpadSessionMarkerStore(join(dir, '9-9-dead', 'incidents')).read(),
    ).toBeUndefined();
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

  // WAVE 6.6 — this used to be ONE test asserting that any alive-pid + stale-heartbeat sibling is
  // recovered, with a subtree NAMED `9-9-…` (pid 9, thread 9) but an owner.json that said `threadId: 0`.
  // So it asserted the worker-thread case while describing the main-thread one, and the main-thread case is
  // exactly the SIGSTOP data-loss bug: a frozen-but-alive process having its capture deleted underneath it.
  it('recovers a stale WORKER-thread sibling — the thread died inside a live process', async () => {
    const dir = mkDir();
    seedPendingBundle(dir, '9-9-stale', 'b1', aBundle('stale'));
    writeOwner(dir, '9-9-stale', LIVE_PID, 9); // alive pid, WORKER thread …
    const liveFile = join(dir, '9-9-stale', '.live');
    writeFileSecure(liveFile, '');
    utimesSync(liveFile, 1000, 1000); // … and an ancient heartbeat (mtime = 1_000_000 ms)
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

  it('does NOT touch a stale MAIN-thread sibling — its process is alive and can still write', async () => {
    const dir = mkDir();
    seedPendingBundle(dir, '9-0-frozen', 'b1', aBundle('frozen'));
    writeOwner(dir, '9-0-frozen', LIVE_PID, 0); // alive pid, MAIN thread
    const liveFile = join(dir, '9-0-frozen', '.live');
    writeFileSecure(liveFile, '');
    utimesSync(liveFile, 1000, 1000);
    const pipe = fakePipeline();

    await recoverInstances({
      dataDir: dir,
      ownInstanceId: '1-0-live',
      uploadPipeline: pipe,
      context,
      now: () => 1_000_000 + 200_000,
      patientMs: 120_000,
    });

    expect(pipe.enqueue).not.toHaveBeenCalled(); // not recovered…
    expect(existsSync(join(dir, '9-0-frozen'))).toBe(true); // …and above all, NOT deleted
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
