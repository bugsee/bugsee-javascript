import fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import {
  type BundleStore,
  createDurableUploadPipeline,
  serializeBundle,
} from './durable-upload-pipeline';
import type { Bundle, UploadPipeline, UploadResult } from './transport';

/**
 * Property-based tests for the durable queue's RETENTION policy.
 *
 * The queue exists so a crash survives the process that produced it, which makes its eviction rule a
 * product decision rather than housekeeping: when the caps bind, it decides which reports the user gets
 * and which they never see. Mutation testing found the decision itself unasserted — reversing the sort
 * that orders eviction, and rewriting the default caps, both survived the suite.
 */

const environment = {
  app: {},
  device: {},
  platform: {},
} as unknown as Bundle['request']['environment'];
const makeBundle = (summary: string, bytes: number): Bundle => ({
  request: {
    summary,
    source: { type: 'error', mechanism: 'programmatic' },
    created_on: '2026-05-29T00:00:00Z',
    environment,
  } as unknown as Bundle['request'],
  body: new Uint8Array(bytes),
  fileName: `${summary}.bundle.zip`,
});

function memStore(): { store: BundleStore; map: Map<string, Uint8Array> } {
  const map = new Map<string, Uint8Array>();
  return {
    map,
    store: {
      put: (id, bytes) => {
        map.set(id, bytes);
      },
      list: () => [...map.keys()],
      read: (id) => map.get(id),
      remove: (id) => {
        map.delete(id);
      },
    },
  };
}

const idlePipeline = (): { pipeline: UploadPipeline; drop: ReturnType<typeof vi.fn> } => {
  const drop = vi.fn();
  // `enqueue` never resolves ok, and never `permanent`, so recovery keeps every bundle it recovers and
  // RETENTION is the only thing that decides what survives — which is what these properties are about.
  const enqueue = vi.fn(async (): Promise<UploadResult> => ({ ok: false }));
  return {
    pipeline: { enqueue, flush: vi.fn(async () => true), drop } as unknown as UploadPipeline,
    drop,
  };
};

/** Seed the store with bundles of known age and size, then let `recover()` apply retention. */
const seed = (
  store: BundleStore,
  items: ReadonlyArray<{ id: string; firstSeenMs: number; bytes: number }>,
): void => {
  for (const item of items) {
    store.put(item.id, serializeBundle(makeBundle(item.id, item.bytes), item.firstSeenMs));
  }
};

describe('durable queue retention (fuzz)', () => {
  /**
   * When the COUNT cap binds, the newest bundles are the ones kept.
   *
   * The module says so in a comment — "a fresh crash report beats a week-old one that has already failed
   * to upload many times" — and nothing checked it. Reversing the comparator survived, which would evict
   * the newest report: the one most likely to describe the problem the user is looking at.
   */
  it('keeps the NEWEST bundles when the count cap binds', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 6 }),
        fc.uniqueArray(fc.integer({ min: 0, max: 1_000_000 }), { minLength: 8, maxLength: 20 }),
        async (maxBundles, ages) => {
          const { store, map } = memStore();
          const { pipeline } = idlePipeline();
          seed(
            store,
            ages.map((firstSeenMs, i) => ({ id: `b${i}`, firstSeenMs, bytes: 8 })),
          );
          const durable = createDurableUploadPipeline({
            store,
            pipeline,
            retention: { maxBundles, maxBytes: 1 << 30, maxAgeMs: Number.MAX_SAFE_INTEGER },
          });
          await durable.recover();

          const survivors = [...map.keys()];
          expect(survivors.length).toBeLessThanOrEqual(maxBundles);
          // The survivors must be exactly the `maxBundles` youngest — by age, not by insertion order.
          const expected = ages
            .map((firstSeenMs, i) => ({ id: `b${i}`, firstSeenMs }))
            .sort((a, b) => b.firstSeenMs - a.firstSeenMs)
            .slice(0, maxBundles)
            .map((x) => x.id)
            .sort();
          expect(survivors.sort()).toEqual(expected);
        },
      ),
      { numRuns: 150 },
    );
  });

  it('drops everything older than the age cap, and nothing younger', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1000, max: 100_000 }),
        fc.uniqueArray(fc.integer({ min: 0, max: 200_000 }), { minLength: 4, maxLength: 16 }),
        async (maxAgeMs, ages) => {
          const now = 200_000;
          const { store, map } = memStore();
          const { pipeline, drop } = idlePipeline();
          seed(
            store,
            ages.map((firstSeenMs, i) => ({ id: `b${i}`, firstSeenMs, bytes: 8 })),
          );
          const durable = createDurableUploadPipeline({
            store,
            pipeline,
            now: () => now,
            retention: { maxBundles: 1000, maxBytes: 1 << 30, maxAgeMs },
          });
          await durable.recover();

          for (const [i, firstSeenMs] of ages.entries()) {
            const expired = now - firstSeenMs > maxAgeMs;
            expect(map.has(`b${i}`), `b${i} (age ${now - firstSeenMs}, cap ${maxAgeMs})`).toBe(
              !expired,
            );
          }
          // An expired bundle is ANNOUNCED, never silently vanished — one that disappears without an
          // outcome is indistinguishable from one that was delivered.
          const expiredCount = ages.filter((f) => now - f > maxAgeMs).length;
          expect(drop.mock.calls.filter(([reason]) => reason === 'retention_expired')).toHaveLength(
            expiredCount,
          );
        },
      ),
      { numRuns: 150 },
    );
  });

  it('keeps the queue under the byte cap, dropping oldest-first to get there', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(fc.record({ bytes: fc.integer({ min: 64, max: 512 }) }), {
          minLength: 6,
          maxLength: 14,
        }),
        fc.integer({ min: 200, max: 2000 }),
        async (items, maxBytes) => {
          const { store, map } = memStore();
          const { pipeline } = idlePipeline();
          seed(
            store,
            items.map((it, i) => ({ id: `b${i}`, firstSeenMs: i * 1000, bytes: it.bytes })),
          );
          const durable = createDurableUploadPipeline({
            store,
            pipeline,
            retention: { maxBundles: 1000, maxBytes, maxAgeMs: Number.MAX_SAFE_INTEGER },
          });
          await durable.recover();

          // Whatever survives, the oldest survivor must be newer than every bundle that was dropped:
          // eviction always takes from the old end.
          const survivors = [...map.keys()].map((id) => Number(id.slice(1)));
          const dropped = items.map((_v, i) => i).filter((i) => !survivors.includes(i));
          if (survivors.length > 0 && dropped.length > 0) {
            expect(Math.min(...survivors)).toBeGreaterThan(Math.max(...dropped));
          }
        },
      ),
      { numRuns: 150 },
    );
  });

  /**
   * The defaults, pinned by BEHAVIOUR at their boundaries rather than by reading the constant.
   *
   * They are the policy the SDK ships with — how much disk it may hold and for how long — and rewriting
   * any of the three survived the suite. Asserted through the queue rather than by exporting the object,
   * because what matters is the bundle that does or does not survive, not the number.
   */
  it('defaults to keeping 32 bundles', async () => {
    const { store, map } = memStore();
    const { pipeline } = idlePipeline();
    // Ages anchored to the REAL clock: these tests exercise the SHIPPED defaults, so they use the default
    // `now` (Date.now) and must seed timestamps it will read as recent. Seeding from zero made every
    // bundle ~55 years old and the age cap swallowed the count cap under test.
    const base = Date.now();
    seed(
      store,
      Array.from({ length: 33 }, (_v, i) => ({
        id: `b${i}`,
        firstSeenMs: base - (33 - i) * 1000,
        bytes: 8,
      })),
    );
    await createDurableUploadPipeline({ store, pipeline }).recover();
    expect(map.size).toBe(32);
    expect(map.has('b0'), 'the oldest of 33 should have been evicted').toBe(false);
    expect(map.has('b32'), 'the newest must be kept').toBe(true);
  });

  it('defaults to a 7-day age cap, to the millisecond', async () => {
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    const now = sevenDays * 2;
    const { store, map } = memStore();
    const { pipeline } = idlePipeline();
    seed(store, [
      { id: 'justInside', firstSeenMs: now - sevenDays, bytes: 8 },
      { id: 'justOutside', firstSeenMs: now - sevenDays - 1, bytes: 8 },
    ]);
    await createDurableUploadPipeline({ store, pipeline, now: () => now }).recover();
    expect(map.has('justInside'), 'a bundle exactly 7 days old was dropped').toBe(true);
    expect(map.has('justOutside'), 'a bundle older than 7 days was kept').toBe(false);
  });

  it('defaults to a 64 MiB byte cap', async () => {
    const mib = 1024 * 1024;
    const { store, map } = memStore();
    const { pipeline } = idlePipeline();
    // Two bundles of 40 MiB: together over the 64 MiB cap, so the older one goes. Anchored to the real
    // clock for the same reason as above.
    const base = Date.now();
    seed(store, [
      { id: 'older', firstSeenMs: base - 2000, bytes: 40 * mib },
      { id: 'newer', firstSeenMs: base - 1000, bytes: 40 * mib },
    ]);
    await createDurableUploadPipeline({ store, pipeline }).recover();
    expect(map.has('newer')).toBe(true);
    expect(map.has('older'), 'the byte cap did not bind at 64 MiB').toBe(false);
  });
});
