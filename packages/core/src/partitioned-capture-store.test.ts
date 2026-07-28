// Tests for the per-tenant partitioned capture store (Wave 0.1 S2,
// docs/design/cloudflare-tenant-isolation.md §4).
//
// The defect this closes was proven on real workerd: Durable Objects for different tenants share one
// isolate, one client and one capture ring, so tenant C's incident bundle carried tenant A's and B's
// secrets off the customer's infrastructure (docs/review/cloudflare.md SEV1 #2).
import { describe, expect, it, vi } from 'vitest';
import type { CaptureSnapshot, CaptureStore, StoredEntry } from './contracts';
import { createPartitionedCaptureStore } from './partitioned-capture-store';

/** A recording stand-in for one partition, so tests can see exactly what was routed where. */
function fakePartition(): CaptureStore & {
  added: StoredEntry[];
  cleared: number;
  ticks: number[];
} {
  const added: StoredEntry[] = [];
  const ticks: number[] = [];
  let cleared = 0;
  return {
    added,
    ticks,
    get cleared() {
      return cleared;
    },
    add: (r) => added.push(r),
    tick: (n) => ticks.push(n),
    clear: () => {
      cleared += 1;
    },
    snapshot: (): CaptureSnapshot => ({
      // eslint-disable-next-line require-yield
      stream: async function* () {
        for (const r of added) yield r;
      },
      drainAll: async () => {
        const m = new Map<StoredEntry['type'], StoredEntry[]>();
        for (const r of added) m.set(r.type, [...(m.get(r.type) ?? []), r]);
        return m;
      },
      release: () => {},
    }),
  } as CaptureStore & { added: StoredEntry[]; cleared: number; ticks: number[] };
}

const rec = (owner: string | undefined, serialized: string): StoredEntry => ({
  type: 'log',
  timestamp: 1,
  serialized,
  ...(owner !== undefined ? { owner } : {}),
});

describe('createPartitionedCaptureStore — routing', () => {
  it('routes entries with different owners into different partitions', () => {
    const made: Array<ReturnType<typeof fakePartition>> = [];
    const store = createPartitionedCaptureStore({
      createPartition: () => {
        const p = fakePartition();
        made.push(p);
        return p;
      },
    });
    store.add(rec('tenant-A', 'secret-A'));
    store.add(rec('tenant-B', 'secret-B'));
    expect(made).toHaveLength(2);
    expect(made[0]?.added.map((r) => r.serialized)).toEqual(['secret-A']);
    expect(made[1]?.added.map((r) => r.serialized)).toEqual(['secret-B']);
  });

  it('reuses one partition per owner rather than creating one per entry', () => {
    let created = 0;
    const store = createPartitionedCaptureStore({
      createPartition: () => {
        created += 1;
        return fakePartition();
      },
    });
    store.add(rec('tenant-A', '1'));
    store.add(rec('tenant-A', '2'));
    expect(created).toBe(1);
  });

  it('routes unowned entries to a default partition, kept separate from owned ones', () => {
    const made: Array<ReturnType<typeof fakePartition>> = [];
    const store = createPartitionedCaptureStore({
      createPartition: () => {
        const p = fakePartition();
        made.push(p);
        return p;
      },
    });
    store.add(rec(undefined, 'unowned'));
    store.add(rec('tenant-A', 'owned'));
    expect(made[0]?.added.map((r) => r.serialized)).toEqual(['unowned']);
    expect(made[1]?.added.map((r) => r.serialized)).toEqual(['owned']);
  });
});

describe('createPartitionedCaptureStore — snapshot isolation (THE fix)', () => {
  it('a snapshot for one owner contains that owner only — never another tenant', async () => {
    const store = createPartitionedCaptureStore({ createPartition: fakePartition });
    store.add(rec('tenant-A', 'SECRET-OF-A'));
    store.add(rec('tenant-B', 'SECRET-OF-B'));
    store.add(rec('tenant-C', 'INCIDENT-IN-C'));

    const seen: string[] = [];
    for await (const r of store.snapshot({ owner: 'tenant-C' }).stream()) seen.push(r.serialized);

    expect(seen).toEqual(['INCIDENT-IN-C']);
    expect(seen.join()).not.toContain('SECRET-OF-A');
    expect(seen.join()).not.toContain('SECRET-OF-B');
  });

  it('drainAll for one owner likewise excludes every other tenant', async () => {
    const store = createPartitionedCaptureStore({ createPartition: fakePartition });
    store.add(rec('tenant-A', 'SECRET-OF-A'));
    store.add(rec('tenant-C', 'INCIDENT-IN-C'));
    const drained = await store.snapshot({ owner: 'tenant-C' }).drainAll();
    const all = [...drained.values()].flat().map((r) => r.serialized);
    expect(all).toEqual(['INCIDENT-IN-C']);
  });

  it('EXCLUDES unattributed entries once any owner exists (fail closed)', async () => {
    // §4.4: once the isolate is known to be multi-tenant, an entry with no owner cannot be attributed and
    // must not be handed to any tenant. Losing it is the accepted cost of never leaking.
    const store = createPartitionedCaptureStore({ createPartition: fakePartition });
    store.add(rec(undefined, 'UNATTRIBUTED'));
    store.add(rec('tenant-A', 'OWNED-A'));
    const seen: string[] = [];
    for await (const r of store.snapshot({ owner: 'tenant-A' }).stream()) seen.push(r.serialized);
    expect(seen).toEqual(['OWNED-A']);
  });

  it('INCLUDES unattributed entries while no owner has ever been seen (single-tenant unchanged)', async () => {
    const store = createPartitionedCaptureStore({ createPartition: fakePartition });
    store.add(rec(undefined, 'a'));
    store.add(rec(undefined, 'b'));
    const seen: string[] = [];
    for await (const r of store.snapshot().stream()) seen.push(r.serialized);
    expect(seen).toEqual(['a', 'b']);
  });

  it('an UNSCOPED snapshot sees no tenant data at all (the leak that shipped in S2)', async () => {
    // Originally this returned every partition merged, and that was the whole bug: an owner-less report —
    // withBugsee's fetch wrapper and the on-by-default unhandledrejection net both produce one — took this
    // branch, so a front-handler incident carried every Durable Object's secrets. Reproduced on real
    // workerd by the adversarial review (docs/review/session-changes-review.md SEV1 #1).
    const store = createPartitionedCaptureStore({ createPartition: fakePartition });
    store.add(rec(undefined, 'UNATTRIBUTED'));
    store.add(rec('tenant-A', 'SECRET-OF-A'));
    store.add(rec('tenant-B', 'SECRET-OF-B'));
    const seen: string[] = [];
    for await (const r of store.snapshot().stream()) seen.push(r.serialized);
    expect(seen).toEqual(['UNATTRIBUTED']);
    expect(seen.join()).not.toContain('SECRET-OF-A');
    expect(seen.join()).not.toContain('SECRET-OF-B');
  });

  it('an unscoped snapshot on a single-tenant isolate still returns everything', async () => {
    // No owners ever seen → "default only" IS everything. This is the compatibility guarantee.
    const store = createPartitionedCaptureStore({ createPartition: fakePartition });
    store.add(rec(undefined, 'a'));
    store.add(rec(undefined, 'b'));
    const seen: string[] = [];
    for await (const r of store.snapshot().stream()) seen.push(r.serialized);
    expect(seen).toEqual(['a', 'b']);
  });

  it('reports through onError when an evicted tenant is later asked for', async () => {
    const errors: unknown[] = [];
    const store = createPartitionedCaptureStore({
      createPartition: fakePartition,
      maxPartitions: 1,
      onError: (e) => errors.push(e),
    });
    store.add(rec('a', '1'));
    store.add(rec('b', '2')); // evicts 'a'
    const seen: string[] = [];
    for await (const r of store.snapshot({ owner: 'a' }).stream()) seen.push(r.serialized);
    expect(seen).toEqual([]); // still fails closed — no other tenant's data
    expect(String(errors[0])).toContain('evicted');
    expect(String(errors[0])).toContain('"a"');
  });

  it('does not report eviction for an owner that simply never existed', () => {
    const errors: unknown[] = [];
    const store = createPartitionedCaptureStore({
      createPartition: fakePartition,
      onError: (e) => errors.push(e),
    });
    store.add(rec('a', '1'));
    store.snapshot({ owner: 'never-seen' });
    expect(errors).toEqual([]);
  });

  it('a snapshot for an owner with no entries is empty, not a leak of everything', async () => {
    const store = createPartitionedCaptureStore({ createPartition: fakePartition });
    store.add(rec('tenant-A', 'a'));
    const seen: string[] = [];
    for await (const r of store.snapshot({ owner: 'tenant-Z' }).stream()) seen.push(r.serialized);
    expect(seen).toEqual([]);
  });
});

describe('createPartitionedCaptureStore — lifecycle + bounds', () => {
  it('forwards tick to every partition', () => {
    const made: Array<ReturnType<typeof fakePartition>> = [];
    const store = createPartitionedCaptureStore({
      createPartition: () => {
        const p = fakePartition();
        made.push(p);
        return p;
      },
    });
    store.add(rec('a', '1'));
    store.add(rec('b', '2'));
    store.tick(1234);
    expect(made.map((p) => p.ticks)).toEqual([[1234], [1234]]);
  });

  it('clear() clears every partition', () => {
    const made: Array<ReturnType<typeof fakePartition>> = [];
    const store = createPartitionedCaptureStore({
      createPartition: () => {
        const p = fakePartition();
        made.push(p);
        return p;
      },
    });
    store.add(rec('a', '1'));
    store.add(rec('b', '2'));
    store.clear();
    expect(made.map((p) => p.cleared)).toEqual([1, 1]);
  });

  it('bounds partition count, reclaiming the least-recently-used tenant', () => {
    // A Durable Object evicted by Cloudflare must not leak its ring for the isolate's lifetime.
    const store = createPartitionedCaptureStore({
      createPartition: fakePartition,
      maxPartitions: 2,
    });
    store.add(rec('a', '1'));
    store.add(rec('b', '2'));
    store.add(rec('a', '3')); // touch 'a' → 'b' is now least-recently-used
    store.add(rec('c', '4')); // over the bound → evicts 'b'
    expect(store.ownerCount()).toBe(2);
    expect(store.owners().sort()).toEqual(['a', 'c']);
  });

  it('never reclaims the default (unowned) partition', () => {
    const store = createPartitionedCaptureStore({
      createPartition: fakePartition,
      maxPartitions: 1,
    });
    store.add(rec(undefined, 'unowned'));
    store.add(rec('a', '1'));
    store.add(rec('b', '2'));
    expect(store.owners()).toEqual(['b']); // owner partitions are bounded...
    expect(store.hasDefaultPartition()).toBe(true); // ...but the default survives
  });

  it('a throwing partition never propagates into the caller (capture must not break the app)', () => {
    const store = createPartitionedCaptureStore({
      createPartition: () => {
        const p = fakePartition();
        p.add = () => {
          throw new Error('partition boom');
        };
        return p;
      },
      onError: vi.fn(),
    });
    expect(() => store.add(rec('a', '1'))).not.toThrow();
  });
});
