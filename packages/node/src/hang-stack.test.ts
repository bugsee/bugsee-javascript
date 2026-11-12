import { describe, expect, it } from 'vitest';
import type { CpuProfile } from './cpu-profiler';
import { hangCrashFromProfile } from './hang-stack';

interface N {
  id: number;
  fn: string;
  url?: string;
  line?: number;
  col?: number;
  children?: number[];
}

const node = (n: N) => ({
  id: n.id,
  callFrame: {
    functionName: n.fn,
    scriptId: '1',
    url: n.url ?? '',
    lineNumber: n.line ?? -1,
    columnNumber: n.col ?? -1,
  },
  ...(n.children !== undefined ? { children: n.children } : {}),
});

// A profile whose samples are 1ms apart. `samples` lists node ids oldest → newest.
const profile = (nodes: N[], samples: number[], deltaUs = 1000): CpuProfile => ({
  nodes: nodes.map(node),
  startTime: 0,
  // The first delta is the idle lead-in since the profile started, so it spans any window the tests use.
  endTime: 10_000_000 + (samples.length - 1) * deltaUs,
  samples,
  timeDeltas: samples.map((_, i) => (i === 0 ? 10_000_000 : deltaUs)),
});

// root → main(app.js) → parse(lib.js) ; main → render(app.js)
const TREE: N[] = [
  { id: 1, fn: '(root)', children: [2, 7, 8, 9] },
  { id: 2, fn: 'main', url: 'file:///srv/app.js', line: 9, col: 4, children: [3, 5] },
  { id: 3, fn: 'parse', url: 'file:///srv/lib.js', line: 0, col: 0 },
  { id: 5, fn: 'render', url: 'file:///srv/app.js', line: 19, col: 2 },
  { id: 7, fn: '(idle)' },
  { id: 8, fn: '(program)' },
  { id: 9, fn: '(garbage collector)' },
];

const opts = {
  windowMs: 1000,
  domain: 'AppHang::Severe',
  reason: 'Event loop blocked (AppHang::Severe)',
};

describe('hangCrashFromProfile', () => {
  it('builds a crash.json whose frames are the hottest stack (leaf first), 1-based, with the AppHang domain', () => {
    const crash = hangCrashFromProfile(profile(TREE, [3, 3, 3, 5]), opts);
    expect(crash).toBeDefined();
    expect(crash?.exception_type).toBe('error');
    expect(crash?.ndkCrash).toBe(false);
    expect(crash?.handled).toBe(true);
    expect(crash?.exception.name).toBe('AppHang');
    expect(crash?.exception.reason).toBe('Event loop blocked (AppHang::Severe)');
    expect(crash?.exception.domain).toBe('AppHang::Severe');
    expect(crash?.exception.frames.map((f) => f.data)).toEqual([
      { source: '/srv/lib.js', member: 'parse', line: 1, column: 1 },
      { source: '/srv/app.js', member: 'main', line: 10, column: 5 },
    ]);
    expect(crash?.exception.frames.every((f) => f.user)).toBe(true);
  });

  it('picks the node with the most self samples', () => {
    const crash = hangCrashFromProfile(profile(TREE, [3, 5, 5, 5]), opts);
    expect(crash?.exception.frames[0]?.data?.member).toBe('render');
  });

  it('ignores idle, program and GC samples however many there are', () => {
    const crash = hangCrashFromProfile(profile(TREE, [7, 7, 7, 8, 8, 9, 9, 3]), opts);
    expect(crash?.exception.frames[0]?.data?.member).toBe('parse');
  });

  it('only counts the trailing window (the stall), not older work', () => {
    // 1ms samples: the last 2 are 5, everything before is 3; a 2ms window sees only 5.
    const crash = hangCrashFromProfile(profile(TREE, [3, 3, 3, 3, 5, 5]), { ...opts, windowMs: 2 });
    expect(crash?.exception.frames[0]?.data?.member).toBe('render');
    const wide = hangCrashFromProfile(profile(TREE, [3, 3, 3, 3, 5, 5]), { ...opts, windowMs: 6 });
    expect(wide?.exception.frames[0]?.data?.member).toBe('parse');
  });

  it('the window ends exactly at its length (a tie goes to the newest sample)', () => {
    // 2ms window over [3,3,5]: sees 5 and one 3 (a 1-1 tie → newest wins). One sample more would make 3 win.
    const crash = hangCrashFromProfile(profile(TREE, [3, 3, 5]), { ...opts, windowMs: 2 });
    expect(crash?.exception.frames[0]?.data?.member).toBe('render');
  });

  it('is undefined when the profile does not span the window (a segment restarted after the stall)', () => {
    const short = { ...profile(TREE, [3, 3, 3]), endTime: 2999 };
    expect(hangCrashFromProfile(short, { ...opts, windowMs: 3 })).toBeUndefined();
    expect(
      hangCrashFromProfile({ ...short, endTime: 3000 }, { ...opts, windowMs: 3 }),
    ).toBeDefined();
  });

  it('is undefined when nothing but idle/program/GC ran in the window', () => {
    expect(hangCrashFromProfile(profile(TREE, [7, 8, 9]), opts)).toBeUndefined();
  });

  it('is undefined for a profile without samples, or with an empty sample list', () => {
    expect(hangCrashFromProfile({ nodes: [], startTime: 0, endTime: 0 }, opts)).toBeUndefined();
    expect(hangCrashFromProfile(profile(TREE, []), opts)).toBeUndefined();
  });

  it('skips samples that point at an unknown node and tolerates missing timeDeltas', () => {
    const p = profile(TREE, [99, 3]);
    delete (p as { timeDeltas?: number[] }).timeDeltas; // no deltas: the window cannot be placed, all samples count
    expect(hangCrashFromProfile(p, opts)?.exception.frames[0]?.data?.member).toBe('parse');
  });

  it('renders native and anonymous frames as V8 does, and classifies runtime internals as not the app', () => {
    const nodes: N[] = [
      { id: 1, fn: '(root)', children: [2] },
      { id: 2, fn: '', url: 'node:internal/main/run_main_module', line: 0, col: 0, children: [3] },
      { id: 3, fn: '', url: 'file:///srv/app.js', line: 4, col: 1, children: [4] },
      { id: 4, fn: 'parse' }, // a native builtin: no script
    ];
    const crash = hangCrashFromProfile(profile(nodes, [4]), opts);
    const frames = crash?.exception.frames ?? [];
    // The native leaf's time is attributed to the application frame that called it (see the next tests).
    expect(frames.map((f) => f.trace)).toEqual([
      'at <anonymous> (/srv/app.js:5:2)',
      'at <anonymous> (node:internal/main/run_main_module:1:1)',
    ]);
    expect(frames.map((f) => f.user)).toEqual([true, false]);
  });

  it("attributes a native builtin's time to its application caller, so different callers do not group together", () => {
    const nodes: N[] = [
      { id: 1, fn: '(root)', children: [2, 4] },
      { id: 2, fn: 'routeA', url: 'file:///srv/a.js', line: 0, col: 0, children: [3] },
      { id: 3, fn: 'parse' }, // JSON.parse
      { id: 4, fn: 'routeB', url: 'file:///srv/b.js', line: 0, col: 0, children: [5] },
      { id: 5, fn: 'parse' },
    ];
    const a = hangCrashFromProfile(profile(nodes, [3, 3, 3]), opts);
    const b = hangCrashFromProfile(profile(nodes, [5, 5, 5]), opts);
    expect(a?.exception.frames[0]?.data?.member).toBe('routeA');
    expect(b?.exception.frames[0]?.data?.member).toBe('routeB');
  });

  it("pools a builtin's samples with its caller's own, across different builtins", () => {
    const nodes: N[] = [
      { id: 1, fn: '(root)', children: [2, 5] },
      { id: 2, fn: 'busy', url: 'file:///srv/a.js', line: 0, col: 0, children: [3, 4] },
      { id: 3, fn: 'parse' },
      { id: 4, fn: 'sort' },
      { id: 5, fn: 'other', url: 'file:///srv/b.js', line: 0, col: 0 },
    ];
    // 2+2 samples under `busy` (self + builtins) beat 3 in `other`.
    const crash = hangCrashFromProfile(profile(nodes, [3, 3, 4, 4, 5, 5, 5]), opts);
    expect(crash?.exception.frames[0]?.data?.member).toBe('busy');
  });

  it('is undefined when the only time was in runtime internals or builtins with no application caller', () => {
    const nodes: N[] = [
      { id: 1, fn: '(root)', children: [2] },
      {
        id: 2,
        fn: 'tick',
        url: 'node:internal/process/task_queues',
        line: 0,
        col: 0,
        children: [3],
      },
      { id: 3, fn: 'parse' },
    ];
    expect(hangCrashFromProfile(profile(nodes, [2, 3]), opts)).toBeUndefined();
  });

  it('anchors the window at the profile END: samples older than the stall are not the stall', () => {
    // The last sample is 1ms in, and the profile runs on idle to 10s: a 3s window ending at 10s sees none.
    const p = { ...profile(TREE, [3]), timeDeltas: [1000], endTime: 10_000_000 };
    expect(hangCrashFromProfile(p, { ...opts, windowMs: 3000 })).toBeUndefined();
    // ...but a sample inside the trailing window counts.
    const recent = { ...profile(TREE, [3]), timeDeltas: [9_999_000], endTime: 10_000_000 };
    expect(hangCrashFromProfile(recent, { ...opts, windowMs: 3000 })).toBeDefined();
  });

  it("decodes the profiler's percent-encoded file URLs to the raw path an Error.stack would carry", () => {
    const nodes: N[] = [
      { id: 1, fn: '(root)', children: [2] },
      { id: 2, fn: 'spin', url: 'file:///srv/my%20dir/a.js', line: 0, col: 0 },
    ];
    const frames = hangCrashFromProfile(profile(nodes, [2]), opts)?.exception.frames ?? [];
    expect(frames[0]?.data?.source).toBe('/srv/my dir/a.js');
  });

  it('keeps a malformed file URL rather than losing the frame', () => {
    const nodes: N[] = [
      { id: 1, fn: '(root)', children: [2] },
      { id: 2, fn: 'spin', url: 'file://remote-host/srv/a.js', line: 0, col: 0 },
    ];
    const frames = hangCrashFromProfile(profile(nodes, [2]), opts)?.exception.frames ?? [];
    expect(frames).toHaveLength(1);
    expect(frames[0]?.data?.member).toBe('spin');
  });

  it('keeps a native builtin that sits BETWEEN application frames, rendered as V8 does', () => {
    const nodes: N[] = [
      { id: 1, fn: '(root)', children: [2] },
      { id: 2, fn: 'main', url: 'file:///srv/app.js', line: 0, col: 0, children: [3] },
      { id: 3, fn: 'map', children: [4] }, // Array.prototype.map calling back into the app
      { id: 4, fn: 'cb', url: 'file:///srv/app.js', line: 4, col: 2 },
    ];
    const frames = hangCrashFromProfile(profile(nodes, [4]), opts)?.exception.frames ?? [];
    expect(frames.map((f) => f.trace)).toEqual([
      'at cb (/srv/app.js:5:3)',
      'at map (<anonymous>)',
      'at main (/srv/app.js:1:1)',
    ]);
  });

  it('caps a pathologically deep stack, keeping the leaf end', () => {
    const nodes: N[] = [{ id: 1, fn: '(root)', children: [2] }];
    for (let i = 2; i <= 200; i += 1) {
      nodes.push({
        id: i,
        fn: `f${i}`,
        url: 'file:///srv/a.js',
        line: i,
        col: 0,
        ...(i < 200 ? { children: [i + 1] } : {}),
      });
    }
    const frames = hangCrashFromProfile(profile(nodes, [200]), opts)?.exception.frames ?? [];
    expect(frames).toHaveLength(64);
    expect(frames[0]?.data?.member).toBe('f200');
    expect(frames[63]?.data?.member).toBe('f137');
  });

  it('terminates on a parent cycle made of skipped pseudo frames', () => {
    const nodes: N[] = [
      { id: 1, fn: '(root)', children: [2] },
      { id: 2, fn: '(program)', children: [1, 3] },
      { id: 3, fn: 'parse', url: 'file:///srv/lib.js', line: 0, col: 0 },
    ];
    expect(hangCrashFromProfile(profile(nodes, [3]), opts)?.exception.frames).toHaveLength(1);
  });

  it('does not let a malformed node take the report down', () => {
    const p = profile(TREE, [3]);
    p.nodes.push(null, 5, { id: 'x' }, { id: 50 });
    expect(hangCrashFromProfile(p, opts)?.exception.frames[0]?.data?.member).toBe('parse');
  });
});
