import 'fake-indexeddb/auto';
import {
  type Bundle,
  type IdentifiedBundle,
  serializeBundle,
  type UploadPipeline,
} from '@bugsee/core';
import { Severity } from '@bugsee/protocol';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createCoexistence, type DeadSiblingRecovery } from './coexistence';
import {
  type AsyncBlobStore,
  type AsyncKeyedStore,
  createIdbBlobStore,
  createIdbKeyedStore,
} from './idb';
import {
  captureDatabaseName,
  coexistenceDatabaseName,
  hashToken,
  instanceLockName,
  markerDatabaseName,
} from './instance-coexistence';
import { createWebLockLiveness, type LockManagerLike } from './web-lock-liveness';

const TOK = 'app-token';

const aBundle = (summary: string, reportId?: string): IdentifiedBundle => ({
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
  fileName: 'b.zip',
  ...(reportId !== undefined ? { reportId } : {}),
});

// In-memory Web Locks fake (node has no navigator.locks). `held()` exposes the lifetime-held (live) locks.
function fakeLocks() {
  const heldForever = new Set<string>();
  const inUse = new Set<string>();
  const manager: LockManagerLike = {
    request(name, options, callback) {
      if (options.ifAvailable) {
        if (heldForever.has(name) || inUse.has(name)) {
          return Promise.resolve(callback(null));
        }
        inUse.add(name);
        return Promise.resolve(callback({ name })).finally(() => inUse.delete(name));
      }
      heldForever.add(name);
      void callback({ name });
      return new Promise<never>(() => {});
    },
  };
  return {
    manager,
    held: () => [...heldForever],
    kill: (name: string) => heldForever.delete(name),
  };
}

const okPipeline = (): UploadPipeline & { enqueue: ReturnType<typeof vi.fn> } => ({
  enqueue: vi.fn(() => Promise.resolve({ ok: true })),
  flush: vi.fn(() => Promise.resolve(true)),
  drop: vi.fn(),
});

// Seed a bundle into another instance's prefix within the per-token bundle-queue database.
async function seedSibling(
  idb: IDBFactory,
  instanceId: string,
  bundleId: string,
  b: Bundle,
  firstSeenMs?: number,
) {
  const shared = createIdbBlobStore({ databaseName: coexistenceDatabaseName(TOK), indexedDB: idb });
  await shared.put(`${instanceId}/${bundleId}`, serializeBundle(b, firstSeenMs));
}
// Seed a report marker into a sibling's prefix within the per-token marker database. The bytes are a
// REAL serialized ReportMarker — coexistence now hydrates these to reconcile them against the bundle queue.
const seedMarker = (idb: IDBFactory, instanceId: string, markerId: string, generation = 9) =>
  createIdbBlobStore({
    databaseName: markerDatabaseName(TOK),
    storeName: 'markers',
    indexedDB: idb,
  }).put(
    `${instanceId}/${markerId}`,
    new TextEncoder().encode(
      JSON.stringify({
        generation,
        request: { id: markerId, source: { type: 'crash' }, report: { id: markerId } },
        attributes: {},
        userIdentifier: null,
      }),
    ),
  );
// Seed a capture chunk into a sibling's prefix within the per-token capture database.
const seedCapture = (idb: IDBFactory, instanceId: string, innerKey: string) =>
  createIdbKeyedStore({
    databaseName: captureDatabaseName(TOK),
    storeName: 'capture',
    indexedDB: idb,
  }).put(`${instanceId}/${innerKey}`, new Uint8Array([1]));

const rawKeys = (idb: IDBFactory) =>
  createIdbBlobStore({ databaseName: coexistenceDatabaseName(TOK), indexedDB: idb })
    .loadAll()
    .then((entries) => entries.map(([k]) => k));

// An IDBFactory whose open() always fails → every store op (including discovery loadAll/keys) rejects.
function openFailsFactory(): IDBFactory {
  return {
    open() {
      const request = {
        error: new DOMException('open fail'),
        result: undefined,
        onupgradeneeded: null as (() => void) | null,
        onsuccess: null as (() => void) | null,
        onerror: null as (() => void) | null,
      };
      queueMicrotask(() => request.onerror?.());
      return request as unknown as IDBOpenDBRequest;
    },
  } as unknown as IDBFactory;
}

afterEach(() => vi.unstubAllGlobals());

describe('createCoexistence — pass-through', () => {
  it('returns an explicit bundle override and never builds a coexistence layer', async () => {
    const idb = new IDBFactory();
    const bundleOverride = { put: vi.fn(), list: () => [], read: () => undefined, remove: vi.fn() };
    const pipeline = okPipeline();
    await seedSibling(idb, 'deadsib', 'b1', aBundle('orphan'));

    const coex = createCoexistence({
      appToken: TOK,
      persist: true,
      bundleOverride,
      indexedDB: idb,
      locks: fakeLocks().manager,
    });
    expect(coex.bundleStore).toBe(bundleOverride);
    expect(coex.captureView).toBeUndefined();
    expect(coex.markerView).toBeUndefined();
    await coex.recoverDeadSiblings({ uploadPipeline: pipeline });
    expect(pipeline.enqueue).not.toHaveBeenCalled(); // override ⇒ no sibling recovery
    expect(await rawKeys(idb)).toContain('deadsib/b1'); // untouched
  });

  it('builds nothing when neither persist nor captureRecovery is set', async () => {
    const pipeline = okPipeline();
    const coex = createCoexistence({ appToken: TOK, persist: false, locks: fakeLocks().manager });
    expect(coex.bundleStore).toBeUndefined();
    expect(coex.captureView).toBeUndefined();
    expect(coex.markerView).toBeUndefined();
    await coex.recoverDeadSiblings({ uploadPipeline: pipeline });
    expect(pipeline.enqueue).not.toHaveBeenCalled();
  });
});

describe('createCoexistence — the dead-sibling age bound, end to end', () => {
  // The coordinator wires `recoverSiblingBundleQueue` with its DEFAULTS, so this is what actually
  // decides how long a browser or worker keeps re-offering an undeliverable blob. Unit-testing the leg
  // alone proves the arithmetic; only driving the real coordinator over real IndexedDB proves it is
  // reached at all. On this tier an instance is dead the moment its tab closes, so before the bound a
  // blob the collector never settled was replayed on every launch for the lifetime of the installation.
  const DAY = 24 * 60 * 60 * 1000;

  const unreachable = () => {
    // Never settles: the collector is offline, or answering a bare 4xx this SDK keeps retrying.
    const enqueue = vi.fn<UploadPipeline['enqueue']>(() => Promise.resolve({ ok: false }));
    const drop = vi.fn<UploadPipeline['drop']>();
    return { enqueue, drop, flush: () => Promise.resolve(true) } satisfies UploadPipeline;
  };

  const coexist = (idb: IDBFactory) =>
    createCoexistence({
      appToken: TOK,
      persist: true,
      indexedDB: idb,
      locks: fakeLocks().manager,
    });

  it('gives up on a blob a dead sibling staged 90 days ago, and keeps yesterday’s', async () => {
    const idb = new IDBFactory();
    await seedSibling(idb, 'deadsib', 'ancient', aBundle('ancient'), Date.now() - 90 * DAY);
    await seedSibling(idb, 'deadsib', 'recent', aBundle('recent'), Date.now() - DAY);
    const pipeline = unreachable();

    await coexist(idb).recoverDeadSiblings({ uploadPipeline: pipeline });

    expect(pipeline.enqueue).toHaveBeenCalledTimes(1);
    expect((pipeline.enqueue.mock.calls[0]?.[0] as Bundle).request.summary).toBe('recent');
    expect(pipeline.drop).toHaveBeenCalledWith('retention_expired', 'issue');
    const keys = await rawKeys(idb);
    expect(keys).not.toContain('deadsib/ancient');
    expect(keys).toContain('deadsib/recent'); // still pending — the next launch tries again
  });

  it('re-offers the SAME recent blob on launch after launch — the bound is age, not attempts', async () => {
    const idb = new IDBFactory();
    await seedSibling(idb, 'deadsib', 'b1', aBundle('kept'), Date.now() - DAY);
    for (let launch = 0; launch < 3; launch += 1) {
      const pipeline = unreachable();
      await coexist(idb).recoverDeadSiblings({ uploadPipeline: pipeline });
      expect(pipeline.enqueue).toHaveBeenCalledTimes(1);
      expect(pipeline.drop).not.toHaveBeenCalled();
    }
    expect(await rawKeys(idb)).toContain('deadsib/b1');
  });

  it('never expires a blob staged by an older SDK, which carries no timestamp at all', async () => {
    const idb = new IDBFactory();
    await seedSibling(idb, 'deadsib', 'legacy', aBundle('legacy')); // no firstSeenMs
    const pipeline = unreachable();
    await coexist(idb).recoverDeadSiblings({ uploadPipeline: pipeline });
    expect(pipeline.enqueue).toHaveBeenCalledTimes(1);
    expect(pipeline.drop).not.toHaveBeenCalled();
    expect(await rawKeys(idb)).toContain('deadsib/legacy');
  });
});

describe('createCoexistence — bundle queue', () => {
  it('writes under a per-token database + per-instance prefix and holds the instance lock', async () => {
    const idb = new IDBFactory();
    const locks = fakeLocks();
    const coex = createCoexistence({
      appToken: TOK,
      persist: true,
      indexedDB: idb,
      locks: locks.manager,
    });
    const store = coex.bundleStore as NonNullable<typeof coex.bundleStore> & {
      whenReady: Promise<void>;
    };
    await store.whenReady;
    store.put('mine', serializeBundle(aBundle('local')));
    await Promise.resolve(); // let the async write-through settle

    const keys = await rawKeys(idb);
    expect(keys).toHaveLength(1);
    expect(keys[0]).toMatch(/^[0-9a-f]{32}\/mine$/); // <instanceId>/mine, in bugsee-<hash>

    const held = locks.held();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatch(new RegExp(`^bugsee/${hashToken(TOK)}/[0-9a-f]{32}$`));
  });

  it('recovers a DEAD sibling bundle (re-uploads + drops it) and SKIPS a LIVE sibling', async () => {
    const idb = new IDBFactory();
    const locks = fakeLocks();
    createWebLockLiveness(locks.manager).holdSelf(instanceLockName(TOK, 'livesib')); // a live sibling
    await seedSibling(idb, 'deadsib', 'b1', aBundle('dead crash'));
    await seedSibling(idb, 'livesib', 'b2', aBundle('live, in flight'));

    const pipeline = okPipeline();
    const coex = createCoexistence({
      appToken: TOK,
      persist: true,
      indexedDB: idb,
      locks: locks.manager,
    });
    await coex.recoverDeadSiblings({ uploadPipeline: pipeline });

    expect(pipeline.enqueue).toHaveBeenCalledTimes(1); // only the dead sibling
    expect((pipeline.enqueue.mock.calls[0]?.[0] as Bundle).request.summary).toBe('dead crash');
    const keys = await rawKeys(idb);
    expect(keys).not.toContain('deadsib/b1'); // delivered → removed
    expect(keys).toContain('livesib/b2'); // alive → left for its own instance
  });

  it("NEVER recovers a different app token's bundles (separate per-token database)", async () => {
    const idb = new IDBFactory();
    const appA = createIdbBlobStore({
      databaseName: coexistenceDatabaseName('app-A'),
      indexedDB: idb,
    });
    await appA.put('sib/secret', serializeBundle(aBundle("app A's incident")));

    const pipeline = okPipeline();
    const coex = createCoexistence({
      appToken: 'app-B',
      persist: true,
      indexedDB: idb,
      locks: fakeLocks().manager,
    });
    await coex.recoverDeadSiblings({ uploadPipeline: pipeline });

    expect(pipeline.enqueue).not.toHaveBeenCalled(); // wrong-project guard: B never delivers A's bundle
    expect((await appA.loadAll()).map(([k]) => k)).toContain('sib/secret'); // A's bundle left untouched
  });

  it('falls back to globalThis.indexedDB when none is injected', async () => {
    const coex = createCoexistence({
      appToken: 'global-idb-tok',
      persist: true,
      locks: fakeLocks().manager,
    });
    const store = coex.bundleStore as NonNullable<typeof coex.bundleStore> & {
      whenReady: Promise<void>;
    };
    await store.whenReady;
    store.put('g', serializeBundle(aBundle('via global idb')));
    await Promise.resolve();
    expect(store.list()).toContain('g'); // round-trips through the ambient IndexedDB
  });

  it('isolates a discovery read failure to onError and recovers nothing (never throws)', async () => {
    const onError = vi.fn();
    const pipeline = okPipeline();
    const coex = createCoexistence({
      appToken: TOK,
      persist: true,
      indexedDB: openFailsFactory(), // bundle-store loadAll (discovery) rejects
      locks: fakeLocks().manager,
      onError,
    });
    await expect(coex.recoverDeadSiblings({ uploadPipeline: pipeline })).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalled(); // the discovery loadAll failure routed to onError
    expect(pipeline.enqueue).not.toHaveBeenCalled(); // no ids discovered → nothing recovered
  });

  it('degrades when Web Locks is unavailable: still persists locally, recovers no sibling', async () => {
    vi.stubGlobal('navigator', undefined); // no navigator.locks
    const idb = new IDBFactory();
    const onError = vi.fn();
    await seedSibling(idb, 'deadsib', 'b1', aBundle('orphan'));

    const pipeline = okPipeline();
    const coex = createCoexistence({ appToken: TOK, persist: true, indexedDB: idb, onError });
    const store = coex.bundleStore as NonNullable<typeof coex.bundleStore> & {
      whenReady: Promise<void>;
    };
    await store.whenReady;
    store.put('mine', serializeBundle(aBundle('local')));
    await Promise.resolve();
    expect((await rawKeys(idb)).some((k) => k.endsWith('/mine'))).toBe(true); // local persistence works

    await coex.recoverDeadSiblings({ uploadPipeline: pipeline });
    expect(pipeline.enqueue).not.toHaveBeenCalled(); // no liveness ⇒ no cross-instance recovery
    expect(await rawKeys(idb)).toContain('deadsib/b1'); // the orphan is left untouched
    expect(onError).toHaveBeenCalledTimes(1); // the one-time unavailable warning
    expect((onError.mock.calls[0]?.[0] as Error).message).toContain('navigator.locks unavailable');
  });
});

describe('createCoexistence — capture + marker recovery', () => {
  it('exposes per-instance capture + marker VIEWS in per-token databases and holds a lock', async () => {
    const idb = new IDBFactory();
    const locks = fakeLocks();
    const coex = createCoexistence({
      appToken: TOK,
      persist: false, // capture recovery alone is enough to coexist + hold a lock
      captureRecovery: true,
      indexedDB: idb,
      locks: locks.manager,
    });
    expect(coex.bundleStore).toBeUndefined();
    const captureView = coex.captureView as AsyncKeyedStore;
    const markerView = coex.markerView as AsyncBlobStore;

    await captureView.put('m/5/0', new Uint8Array([7]));
    await markerView.put('mk1', new Uint8Array([9]));
    // Physically prefixed in the per-token capture/marker databases.
    const rawCap = await createIdbKeyedStore({
      databaseName: captureDatabaseName(TOK),
      storeName: 'capture',
      indexedDB: idb,
    }).keys('');
    expect(rawCap).toEqual([`${coex.instanceId}/m/5/0`]);
    const rawMk = await createIdbBlobStore({
      databaseName: markerDatabaseName(TOK),
      storeName: 'markers',
      indexedDB: idb,
    }).loadAll();
    expect(rawMk.map(([k]) => k)).toEqual([`${coex.instanceId}/mk1`]);

    expect(locks.held()).toHaveLength(1); // coexisting via capture recovery ⇒ lock held
  });

  it('runs capture/marker recovery for DEAD siblings (from markers ∪ capture) and SKIPS a LIVE one', async () => {
    const idb = new IDBFactory();
    const locks = fakeLocks();
    createWebLockLiveness(locks.manager).holdSelf(instanceLockName(TOK, 'livesib')); // a live sibling
    await seedMarker(idb, 'deadsib', 'mk1'); // a dead sibling with a pending incident marker
    await seedCapture(idb, 'caponly', 'm/9/0'); // a dead sibling with capture but NO marker/bundle
    await seedMarker(idb, 'livesib', 'mk2'); // a LIVE sibling's marker — must NOT be touched
    await seedCapture(idb, 'livesib', 'm/9/0');

    const recovered: string[] = [];
    const recoverReportsForSibling = vi.fn(({ markers }: DeadSiblingRecovery) => {
      const ids = markers.list().map((m) => m.request.id);
      recovered.push(ids.length > 0 ? `markers:${ids.join(',')}` : 'capture-only');
      return Promise.resolve();
    });

    const coex = createCoexistence({
      appToken: TOK,
      persist: false,
      captureRecovery: true,
      indexedDB: idb,
      locks: locks.manager,
    });
    await coex.recoverDeadSiblings({ uploadPipeline: okPipeline(), recoverReportsForSibling });

    expect(recoverReportsForSibling).toHaveBeenCalledTimes(2); // deadsib + caponly, NOT livesib
    expect(recovered.sort()).toEqual(['capture-only', 'markers:mk1']); // each got ITS OWN prefixed view
  });

  it('recovers bundles AND reports for one dead sibling under a single lock acquisition', async () => {
    const idb = new IDBFactory();
    await seedSibling(idb, 'deadsib', 'b1', aBundle('dead crash')); // bundle
    await seedMarker(idb, 'deadsib', 'mk1'); // + a marker, same instance

    const pipeline = okPipeline();
    const reports = vi.fn(() => Promise.resolve());
    const coex = createCoexistence({
      appToken: TOK,
      persist: true,
      captureRecovery: true,
      indexedDB: idb,
      locks: fakeLocks().manager,
    });
    await coex.recoverDeadSiblings({ uploadPipeline: pipeline, recoverReportsForSibling: reports });

    expect(pipeline.enqueue).toHaveBeenCalledTimes(1); // its bundle re-uploaded
    expect(reports).toHaveBeenCalledTimes(1); // AND its reports recovered (one dead sibling, deduped)
  });

  it("NEVER recovers a different app token's capture/markers (separate per-token databases)", async () => {
    const idb = new IDBFactory();
    await createIdbBlobStore({
      databaseName: markerDatabaseName('app-A'),
      storeName: 'markers',
      indexedDB: idb,
    }).put('sib/mk', new Uint8Array([1]));

    const reports = vi.fn(() => Promise.resolve());
    const coex = createCoexistence({
      appToken: 'app-B',
      persist: false,
      captureRecovery: true,
      indexedDB: idb,
      locks: fakeLocks().manager,
    });
    await coex.recoverDeadSiblings({
      uploadPipeline: okPipeline(),
      recoverReportsForSibling: reports,
    });
    expect(reports).not.toHaveBeenCalled(); // B's per-token marker db never sees A's marker
  });

  it('isolates ONE dead sibling recovery failure to onError — the others still recover', async () => {
    const idb = new IDBFactory();
    const onError = vi.fn();
    await seedMarker(idb, 'bad', 'mk1'); // this sibling's recovery will throw
    await seedMarker(idb, 'good', 'mk2'); // this one must still recover

    const recovered: string[] = [];
    const recoverReportsForSibling = vi.fn(({ markers }: DeadSiblingRecovery) => {
      const ids = markers.list().map((m) => m.request.id);
      if (ids.includes('mk1')) {
        return Promise.reject(new Error('boom on bad sibling')); // one sibling's recovery rejects
      }
      recovered.push(ids.join(','));
      return Promise.resolve();
    });

    const coex = createCoexistence({
      appToken: TOK,
      persist: false,
      captureRecovery: true,
      indexedDB: idb,
      locks: fakeLocks().manager,
      onError,
    });
    await expect(
      coex.recoverDeadSiblings({ uploadPipeline: okPipeline(), recoverReportsForSibling }),
    ).resolves.toBeUndefined(); // never throws into launch
    expect(recoverReportsForSibling).toHaveBeenCalledTimes(2); // both attempted
    expect(recovered).toEqual(['mk2']); // the good sibling recovered despite the bad one failing
    expect(onError).toHaveBeenCalledTimes(1); // the bad one's rejection isolated to onError
    expect((onError.mock.calls[0]?.[0] as Error).message).toBe('boom on bad sibling');
  });

  it('isolates a single discovery-source failure: ids from the working sources still recover', async () => {
    const idb = new IDBFactory();
    const onError = vi.fn();
    await seedMarker(idb, 'msib', 'mk1'); // a dead sibling visible ONLY in the (working) marker db
    // A factory that fails to open ONLY the capture database; the marker/bundle dbs open normally.
    const failCaptureOpen: IDBFactory = {
      open: (name: string, version?: number) =>
        name === captureDatabaseName(TOK) ? openFailsFactory().open(name) : idb.open(name, version),
    } as unknown as IDBFactory;

    const reports = vi.fn(() => Promise.resolve());
    const coex = createCoexistence({
      appToken: TOK,
      persist: false,
      captureRecovery: true,
      indexedDB: failCaptureOpen,
      locks: fakeLocks().manager,
      onError,
    });
    await coex.recoverDeadSiblings({
      uploadPipeline: okPipeline(),
      recoverReportsForSibling: reports,
    });

    expect(onError).toHaveBeenCalled(); // the capture-store keys() discovery failure routed to onError
    expect(reports).toHaveBeenCalledTimes(1); // 'msib' (from the working marker db) still recovered
  });

  // SEV1 (recovery double-upload). A tab/worker killed between the durable stage and the upload settling
  // leaves BOTH a staged bundle and its incident's report marker; recovering the two legs independently
  // reported it twice. Reconciliation is PER INCIDENT, on the report id the durable frame carries — the
  // browser and the (service) worker share this one implementation.
  describe('bundle-queue ↔ report-marker reconciliation', () => {
    it('uploads an incident ONCE when a dead sibling left both its staged bundle and its marker', async () => {
      const idb = new IDBFactory();
      await seedMarker(idb, 'deadsib', 'inc1');
      await seedSibling(idb, 'deadsib', 'b1', aBundle('inc1 (pre-crash assembly)', 'inc1'));

      const pipeline = okPipeline();
      let seen: DeadSiblingRecovery | undefined;
      const coex = createCoexistence({
        appToken: TOK,
        persist: true,
        captureRecovery: true,
        indexedDB: idb,
        locks: fakeLocks().manager,
      });
      await coex.recoverDeadSiblings({
        uploadPipeline: pipeline,
        recoverReportsForSibling: (recovery) => {
          seen = recovery;
          return Promise.resolve();
        },
      });

      expect(pipeline.enqueue).toHaveBeenCalledTimes(1); // NOT twice
      expect(pipeline.enqueue.mock.calls[0]?.[0].request.summary).toBe('inc1 (pre-crash assembly)');
      expect([...(seen?.skipReportIds ?? [])]).toEqual(['inc1']); // withheld from the marker leg
      expect(seen?.markers.list()).toEqual([]); // …and retired, since its bundle really uploaded
      expect(await rawKeys(idb)).toEqual([]); // the delivered blob is gone
    });

    // The case the `hadMarkers` set-emptiness key silently deleted: the staged bundle belongs to a
    // DIFFERENT incident than the marker (its own marker was cleared on a non-ok upload settle).
    it('replays a staged bundle whose incident has NO marker, even when the sibling has other markers', async () => {
      const idb = new IDBFactory();
      await seedMarker(idb, 'deadsib', 'inc1');
      await seedSibling(
        idb,
        'deadsib',
        'b2',
        aBundle('inc2 (staged, marker already cleared)', 'inc2'),
      );

      const pipeline = okPipeline();
      let seen: DeadSiblingRecovery | undefined;
      const coex = createCoexistence({
        appToken: TOK,
        persist: true,
        captureRecovery: true,
        indexedDB: idb,
        locks: fakeLocks().manager,
      });
      await coex.recoverDeadSiblings({
        uploadPipeline: pipeline,
        recoverReportsForSibling: (recovery) => {
          seen = recovery;
          return Promise.resolve();
        },
      });

      expect(pipeline.enqueue).toHaveBeenCalledTimes(1);
      expect(pipeline.enqueue.mock.calls[0]?.[0].request.summary).toBe(
        'inc2 (staged, marker already cleared)',
      ); // uploaded, NOT dropped
      expect([...(seen?.skipReportIds ?? [])]).toEqual([]); // inc1 is still the marker leg's to deliver
      expect(seen?.markers.list().map((m) => m.request.id)).toEqual(['inc1']);
    });

    it('keeps both traces (and skips the marker leg) when the staged bundle fails to upload', async () => {
      const idb = new IDBFactory();
      await seedMarker(idb, 'deadsib', 'inc1');
      await seedSibling(idb, 'deadsib', 'b1', aBundle('inc1 (pre-crash assembly)', 'inc1'));

      const failing: UploadPipeline = {
        enqueue: vi.fn(() => Promise.resolve({ ok: false })),
        flush: vi.fn(() => Promise.resolve(true)),
        drop: vi.fn(),
      };
      let seen: DeadSiblingRecovery | undefined;
      const coex = createCoexistence({
        appToken: TOK,
        persist: true,
        captureRecovery: true,
        indexedDB: idb,
        locks: fakeLocks().manager,
      });
      await coex.recoverDeadSiblings({
        uploadPipeline: failing,
        recoverReportsForSibling: (recovery) => {
          seen = recovery;
          return Promise.resolve();
        },
      });

      expect([...(seen?.skipReportIds ?? [])]).toEqual(['inc1']); // not attempted twice in one pass
      expect(seen?.markers.list().map((m) => m.request.id)).toEqual(['inc1']); // still owed
      expect(await rawKeys(idb)).toEqual(['deadsib/b1']); // the blob is kept for the next launch
    });

    it('replays a frame with no report id (older SDK) without reconciling it against any marker', async () => {
      const idb = new IDBFactory();
      await seedMarker(idb, 'deadsib', 'inc1');
      await seedSibling(idb, 'deadsib', 'legacy', aBundle('legacy frame'));

      const pipeline = okPipeline();
      let seen: DeadSiblingRecovery | undefined;
      const coex = createCoexistence({
        appToken: TOK,
        persist: true,
        captureRecovery: true,
        indexedDB: idb,
        locks: fakeLocks().manager,
      });
      await coex.recoverDeadSiblings({
        uploadPipeline: pipeline,
        recoverReportsForSibling: (recovery) => {
          seen = recovery;
          return Promise.resolve();
        },
      });

      expect(pipeline.enqueue).toHaveBeenCalledTimes(1); // uploaded, never freed
      expect([...(seen?.skipReportIds ?? [])]).toEqual([]);
      expect(seen?.markers.list().map((m) => m.request.id)).toEqual(['inc1']);
    });

    // R2-1: an explicit `bundleStore` override BYPASSES coexistence, so its blobs live in a store that is
    // stable across launches while the incident's marker sits in this dead sibling's namespace. The launch
    // reconciles that store through `reconcileOwnQueue`; whatever it settles with is withheld from the
    // marker leg alongside the coexisting queue's own ids.
    it('withholds the incidents an OUTSIDE queue reconciled, unioned with the coexisting one’s', async () => {
      const idb = new IDBFactory();
      await seedMarker(idb, 'deadsib', 'inc1');
      await seedMarker(idb, 'deadsib', 'inc2');
      await seedSibling(idb, 'deadsib', 'b1', aBundle('inc1 (staged)', 'inc1'));

      const pipeline: UploadPipeline & { enqueue: ReturnType<typeof vi.fn> } = {
        enqueue: vi.fn(() => Promise.resolve({ ok: false })), // NOT ok, so the marker survives the queue leg
        flush: vi.fn(() => Promise.resolve(true)),
        drop: vi.fn(),
      };
      const handed: Array<string[]> = [];
      let seen: DeadSiblingRecovery | undefined;
      const coex = createCoexistence({
        appToken: TOK,
        persist: true,
        captureRecovery: true,
        indexedDB: idb,
        locks: fakeLocks().manager,
      });
      await coex.recoverDeadSiblings({
        uploadPipeline: pipeline,
        reconcileOwnQueue: (markers) => {
          handed.push(
            markers
              .list()
              .map((m) => m.request.id)
              .sort(),
          ); // the SAME hydrated store
          return Promise.resolve(new Set(['inc2']));
        },
        recoverReportsForSibling: (recovery) => {
          seen = recovery;
          return Promise.resolve();
        },
      });

      expect(handed).toEqual([['inc1', 'inc2']]);
      expect([...(seen?.skipReportIds ?? [])].sort()).toEqual(['inc1', 'inc2']); // the UNION
    });

    it('withholds an OUTSIDE queue’s incidents even when this sibling has no coexisting queue', async () => {
      const idb = new IDBFactory();
      await seedMarker(idb, 'deadsib', 'inc1');

      let seen: DeadSiblingRecovery | undefined;
      const coex = createCoexistence({
        appToken: TOK,
        persist: false, // no coexisting bundle queue at all — an injected store took its place
        captureRecovery: true,
        indexedDB: idb,
        locks: fakeLocks().manager,
      });
      await coex.recoverDeadSiblings({
        uploadPipeline: okPipeline(),
        reconcileOwnQueue: () => Promise.resolve(new Set(['inc1'])),
        recoverReportsForSibling: (recovery) => {
          seen = recovery;
          return Promise.resolve();
        },
      });

      expect([...(seen?.skipReportIds ?? [])]).toEqual(['inc1']);
    });

    it('replays the queue untouched when the launch has no marker leg at all', async () => {
      const idb = new IDBFactory();
      await seedMarker(idb, 'deadsib', 'inc1'); // a marker from an earlier, recovery-enabled run
      await seedSibling(idb, 'deadsib', 'b1', aBundle('staged', 'inc1'));

      const pipeline = okPipeline();
      const coex = createCoexistence({
        appToken: TOK,
        persist: true,
        captureRecovery: true,
        indexedDB: idb,
        locks: fakeLocks().manager,
      });
      await coex.recoverDeadSiblings({ uploadPipeline: pipeline }); // no recoverReportsForSibling

      expect(pipeline.enqueue).toHaveBeenCalledTimes(1); // the only leg that runs — no double report
      expect(await rawKeys(idb)).toEqual([]);
      // the marker is left alone: with no marker leg, nothing here vouches for having delivered it
      const markerKeys = await createIdbBlobStore({
        databaseName: markerDatabaseName(TOK),
        storeName: 'markers',
        indexedDB: idb,
      }).loadAll();
      expect(markerKeys.map(([k]) => k)).toEqual(['deadsib/inc1']);
    });
  });
});
