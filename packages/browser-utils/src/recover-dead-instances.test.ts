import {
  type Bundle,
  DEFAULT_DURABLE_RETENTION,
  serializeBundle,
  type UploadPipeline,
} from '@bugsee/core';
import { Severity } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { AsyncBlobStore } from './idb';
import { recoverSiblingBundleQueue } from './recover-dead-instances';

const aBundle = (summary: string): Bundle => ({
  request: {
    type: 'crash',
    summary,
    severity: Severity.Blocker,
    source: { type: 'crash', mechanism: 'uncaught' },
    created_on: '2026-06-29T00:00:00Z',
    environment: {
      platform: { type: 'web', version: '1' },
      runtime: { type: 'web', version: '' },
      sdk: { version: '0', type: 'javascript' },
    },
  },
  body: new Uint8Array([0x50, 0x4b, 1]),
  fileName: 'recovered.zip',
});

function memBlobWith(entries: Array<[string, Uint8Array]>) {
  const map = new Map(entries);
  const store: AsyncBlobStore = {
    loadAll: () => Promise.resolve([...map.entries()]),
    put: (id, b) => {
      map.set(id, b);
      return Promise.resolve();
    },
    remove: (id) => {
      map.delete(id);
      return Promise.resolve();
    },
  };
  return { store, map };
}

const okPipeline = (): UploadPipeline & { enqueue: ReturnType<typeof vi.fn> } => ({
  enqueue: vi.fn(() => Promise.resolve({ ok: true })),
  flush: vi.fn(() => Promise.resolve(true)),
  drop: vi.fn(),
});

describe('recoverSiblingBundleQueue', () => {
  it('re-uploads a dead instance bundle and removes it on confirmed delivery', async () => {
    const shared = memBlobWith([['dead/b1', serializeBundle(aBundle('a prior crash'))]]);
    const pipeline = okPipeline();
    await recoverSiblingBundleQueue(shared.store, 'dead', pipeline);
    expect(pipeline.enqueue).toHaveBeenCalledTimes(1);
    expect((pipeline.enqueue.mock.calls[0]?.[0] as Bundle).request.summary).toBe('a prior crash');
    expect(shared.map.has('dead/b1')).toBe(false); // delivered → durable copy dropped
  });

  // A collector REFUSAL is settled, exactly as the live durable pipeline treats it. Gating on `ok` alone
  // re-uploads a 4xx-rejected bundle at every launch forever, and this tier has no retention sweep at all
  // to bound it (node's `sweep-instances` at least caps it at 7 days).
  it('drops a PERMANENTLY refused bundle instead of re-uploading it every launch', async () => {
    const shared = memBlobWith([['dead/b1', serializeBundle(aBundle('refused'))]]);
    const pipeline: UploadPipeline = {
      enqueue: () => Promise.resolve({ ok: false, permanent: true }),
      flush: () => Promise.resolve(true),
      drop: () => {},
    };
    await recoverSiblingBundleQueue(shared.store, 'dead', pipeline);
    expect(shared.map.has('dead/b1')).toBe(false);
  });

  it('keeps the bundle when delivery is NOT confirmed (retry next launch)', async () => {
    const shared = memBlobWith([['dead/b1', serializeBundle(aBundle('x'))]]);
    const pipeline: UploadPipeline = {
      enqueue: () => Promise.resolve({ ok: false }),
      flush: () => Promise.resolve(true),
      drop: () => {},
    };
    await recoverSiblingBundleQueue(shared.store, 'dead', pipeline);
    expect(shared.map.has('dead/b1')).toBe(true); // not delivered → kept
  });

  it('purges an unparseable leftover (onError) and survives an enqueue throw', async () => {
    const onError = vi.fn();
    const shared = memBlobWith([
      ['dead/bad', new Uint8Array([1, 2, 3])], // not a serialized bundle
      ['dead/throws', serializeBundle(aBundle('y'))],
    ]);
    const pipeline: UploadPipeline = {
      enqueue: () => Promise.reject(new Error('net down')),
      flush: () => Promise.resolve(true),
      drop: () => {},
    };
    await recoverSiblingBundleQueue(shared.store, 'dead', pipeline, onError);
    expect(shared.map.has('dead/bad')).toBe(false); // unparseable → purged
    expect(shared.map.has('dead/throws')).toBe(true); // enqueue threw → kept for retry
    expect(onError).toHaveBeenCalledTimes(2); // the parse error + the enqueue throw
  });

  it('only touches the named instance prefix (never another instance bundle)', async () => {
    const shared = memBlobWith([
      ['dead/b1', serializeBundle(aBundle('dead'))],
      ['other/b2', serializeBundle(aBundle('other'))],
    ]);
    await recoverSiblingBundleQueue(shared.store, 'dead', okPipeline());
    expect(shared.map.has('dead/b1')).toBe(false); // recovered
    expect(shared.map.has('other/b2')).toBe(true); // untouched
  });

  it('swallows an unparseable leftover with the default no-op onError (no onError arg, never throws)', async () => {
    const shared = memBlobWith([['dead/bad', new Uint8Array([9, 9, 9])]]);
    await expect(
      recoverSiblingBundleQueue(shared.store, 'dead', okPipeline()),
    ).resolves.toBeUndefined();
    expect(shared.map.has('dead/bad')).toBe(false); // still purged under the default onError
  });

  it('routes a loadAll failure to onError and recovers nothing (never throws)', async () => {
    const onError = vi.fn();
    const shared: AsyncBlobStore = {
      loadAll: () => Promise.reject(new Error('idb gone')),
      put: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };
    const pipeline = okPipeline();
    await expect(
      recoverSiblingBundleQueue(shared, 'dead', pipeline, onError),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(pipeline.enqueue).not.toHaveBeenCalled();
  });
});

// ══════════════════════════════════════════════════════════════════════════════════════════════════
// THE AGE BOUND — what stops "retried at every launch" from meaning "forever" on this tier
// ══════════════════════════════════════════════════════════════════════════════════════════════════
//
// Everything above is about a SETTLED answer. The dangerous case is the one that never settles: a
// collector that is simply unreachable, or a control-plane failure this SDK deliberately keeps retrying
// (a bare 4xx on `/v2/issues` — see `upload-pipeline.test.ts`, "a status is never a verdict here").
//
// On node such a blob is bounded twice over: `sweep-instances` reaps a dead instance's whole subtree at
// 7 days, and `recover()` applies the durable queue's own retention. This leg has neither — it reads a
// dead instance's prefix DIRECTLY — and on the web an instance is dead the moment its tab closes. So a
// blob that never settles was re-offered on every launch for the lifetime of the installation.
//
// The bound applied here is not a new policy: it is `DEFAULT_DURABLE_RETENTION.maxAgeMs`, the SAME
// 7 days already applied to the SAME bytes on the SAME tier by the instance's own `recover()`, and the
// same TTL node's sweep uses. Only the count and byte caps are deliberately left off — see below.
describe('recoverSiblingBundleQueue — the retention age bound', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const NOW = 1_800_000_000_000;
  const failing = () => {
    // The collector is unreachable — never a refusal, so nothing here is ever "settled".
    const enqueue = vi.fn<UploadPipeline['enqueue']>(() => Promise.resolve({ ok: false }));
    const drop = vi.fn<UploadPipeline['drop']>();
    return { enqueue, drop, flush: () => Promise.resolve(true) } satisfies UploadPipeline;
  };

  it('stops re-offering a blob past the age bound, and says so rather than deleting it silently', async () => {
    const shared = memBlobWith([
      [
        'dead/old',
        serializeBundle(aBundle('a crash from a tab closed months ago'), NOW - 90 * DAY),
      ],
    ]);
    const pipeline = failing();
    await recoverSiblingBundleQueue(shared.store, 'dead', pipeline, undefined, { now: () => NOW });
    expect(pipeline.enqueue).not.toHaveBeenCalled();
    expect(shared.map.has('dead/old')).toBe(false);
    // Announced, exactly as `durable-upload-pipeline` announces its own evictions: a bundle that
    // vanishes without an outcome is indistinguishable from one that was delivered.
    expect(pipeline.drop).toHaveBeenCalledWith('retention_expired', 'issue');
  });

  it('keeps replaying a blob INSIDE the bound, launch after launch', async () => {
    const shared = memBlobWith([['dead/recent', serializeBundle(aBundle('yesterday'), NOW - DAY)]]);
    const pipeline = failing();
    for (let launch = 0; launch < 3; launch += 1) {
      await recoverSiblingBundleQueue(shared.store, 'dead', pipeline, undefined, {
        now: () => NOW,
      });
    }
    expect(pipeline.enqueue).toHaveBeenCalledTimes(3);
    expect(shared.map.has('dead/recent')).toBe(true);
    expect(pipeline.drop).not.toHaveBeenCalled();
  });

  it('is EXCLUSIVE at the bound — exactly maxAgeMs old is still replayed', async () => {
    const shared = memBlobWith([
      ['dead/at', serializeBundle(aBundle('at'), NOW - DEFAULT_DURABLE_RETENTION.maxAgeMs)],
      ['dead/past', serializeBundle(aBundle('past'), NOW - DEFAULT_DURABLE_RETENTION.maxAgeMs - 1)],
    ]);
    const pipeline = failing();
    await recoverSiblingBundleQueue(shared.store, 'dead', pipeline, undefined, { now: () => NOW });
    expect(pipeline.enqueue).toHaveBeenCalledTimes(1);
    expect((pipeline.enqueue.mock.calls[0]?.[0] as Bundle).request.summary).toBe('at');
    expect(shared.map.has('dead/at')).toBe(true);
    expect(shared.map.has('dead/past')).toBe(false);
  });

  it('NEVER expires a frame that predates `firstSeenMs` — the upgrade launch', async () => {
    // `serializeBundle(bundle)` with no timestamp is what every blob staged by an older SDK looks like.
    // Reading "unknown" as the epoch would delete every pending crash report on the first launch after
    // an upgrade — losing exactly the reports the upgrade was installed to deliver. Same rule as
    // `durable-upload-pipeline.recoverPass`.
    const shared = memBlobWith([['dead/legacy', serializeBundle(aBundle('legacy'))]]);
    const pipeline = failing();
    await recoverSiblingBundleQueue(shared.store, 'dead', pipeline, undefined, { now: () => NOW });
    expect(pipeline.enqueue).toHaveBeenCalledTimes(1);
    expect(shared.map.has('dead/legacy')).toBe(true);
    expect(pipeline.drop).not.toHaveBeenCalled();
  });

  it('defaults to the durable queue’s own 7 days, not a second copy of the number', async () => {
    const shared = memBlobWith([
      [
        'dead/old',
        serializeBundle(aBundle('old'), Date.now() - DEFAULT_DURABLE_RETENTION.maxAgeMs - 60_000),
      ],
      ['dead/new', serializeBundle(aBundle('new'), Date.now() - 60_000)],
    ]);
    const pipeline = failing();
    await recoverSiblingBundleQueue(shared.store, 'dead', pipeline); // no clock, no bound: the defaults
    expect(pipeline.enqueue).toHaveBeenCalledTimes(1);
    expect(shared.map.has('dead/old')).toBe(false);
    expect(shared.map.has('dead/new')).toBe(true);
  });

  it('honours an explicit maxAgeMs override', async () => {
    const shared = memBlobWith([['dead/b', serializeBundle(aBundle('b'), NOW - 2 * DAY)]]);
    const pipeline = failing();
    await recoverSiblingBundleQueue(shared.store, 'dead', pipeline, undefined, {
      now: () => NOW,
      maxAgeMs: DAY,
    });
    expect(pipeline.enqueue).not.toHaveBeenCalled();
    expect(shared.map.has('dead/b')).toBe(false);
  });

  it('reports a failed eviction to onError instead of throwing out of launch', async () => {
    const onError = vi.fn();
    const shared = memBlobWith([['dead/old', serializeBundle(aBundle('old'), NOW - 90 * DAY)]]);
    const store: AsyncBlobStore = {
      ...shared.store,
      remove: () => Promise.reject(new Error('idb gone')),
    };
    const pipeline = failing();
    await expect(
      recoverSiblingBundleQueue(store, 'dead', pipeline, onError, { now: () => NOW }),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(pipeline.enqueue).not.toHaveBeenCalled(); // still withheld — the bound holds either way
  });

  it('bounds by AGE ONLY — a hundred fresh blobs are all still offered', async () => {
    // The count and byte caps `recover()` also applies are deliberately NOT mirrored here. They evict
    // the OLDEST survivors to make room, which on this leg would mean deleting a crash report the
    // collector has never been asked about, purely because a burst arrived after it. Age is the one
    // bound where "give up" and "this is worthless now" are the same statement.
    const shared = memBlobWith(
      Array.from({ length: 100 }, (_, i): [string, Uint8Array] => [
        `dead/b${i}`,
        serializeBundle(aBundle(`b${i}`), NOW - DAY),
      ]),
    );
    const pipeline = failing();
    await recoverSiblingBundleQueue(shared.store, 'dead', pipeline, undefined, { now: () => NOW });
    expect(pipeline.enqueue).toHaveBeenCalledTimes(100);
    expect(shared.map.size).toBe(100);
    expect(pipeline.drop).not.toHaveBeenCalled();
  });
});
