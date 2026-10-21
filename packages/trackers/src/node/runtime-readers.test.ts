import { describe, expect, it } from 'vitest';
import {
  createDenoMemoryReader,
  createElectronMemoryReader,
  createMemoryLimitReader,
  createProcMeminfoReader,
  createSystemFreeReader,
  createV8HeapReader,
  firstAnswer,
  parseMemAvailable,
} from './runtime-readers';

const GiB = 1024 ** 3;

describe('createV8HeapReader', () => {
  const stats = {
    heap_size_limit: 4 * GiB,
    used_heap_size: 100,
    total_available_size: 4 * GiB - 100,
    malloced_memory: 7,
    peak_malloced_memory: 9,
  };

  it('maps v8.getHeapStatistics() onto limit / used / available / malloced / peakMalloced', () => {
    expect(createV8HeapReader(() => stats)()).toEqual({
      limit: 4 * GiB,
      used: 100,
      available: 4 * GiB - 100,
      malloced: 7,
      peakMalloced: 9,
    });
  });

  it('answers undefined when a field is missing or not a finite number (never a half-true row)', () => {
    for (const bad of [
      { ...stats, heap_size_limit: undefined },
      { ...stats, used_heap_size: Number.NaN },
      { ...stats, total_available_size: Number.POSITIVE_INFINITY },
      { ...stats, malloced_memory: 'x' },
      { ...stats, peak_malloced_memory: null },
    ]) {
      expect(createV8HeapReader(() => bad as never)()).toBeUndefined();
    }
  });

  it('reads the statistics fresh on every call', () => {
    let used = 1;
    const read = createV8HeapReader(() => ({ ...stats, used_heap_size: used }));
    expect(read()?.used).toBe(1);
    used = 2;
    expect(read()?.used).toBe(2);
  });
});

describe('createMemoryLimitReader', () => {
  const total = 16 * GiB;
  const mk = (value: unknown) =>
    createMemoryLimitReader({ constrainedMemory: () => value as number }, () => total);

  it('reports a real cgroup cap', () => {
    expect(mk(256 * 1024 * 1024)()).toBe(256 * 1024 * 1024);
    expect(mk(total - 1)()).toBe(total - 1);
  });

  it('omits 0 (macOS / unconstrained)', () => {
    expect(mk(0)()).toBeUndefined();
  });

  it('omits the 2^64 Linux "no limit" sentinel', () => {
    expect(mk(18446744073709552000)()).toBeUndefined();
    expect(mk(2 ** 63)()).toBeUndefined();
  });

  it('omits a value equal to total RAM (Bun reports totalmem when unconstrained) or above it', () => {
    expect(mk(total)()).toBeUndefined();
    expect(mk(total + 1)()).toBeUndefined();
  });

  it('omits negatives and non-finite or non-number answers', () => {
    for (const v of [-1, Number.NaN, Number.POSITIVE_INFINITY, undefined, '5', null]) {
      expect(mk(v)()).toBeUndefined();
    }
  });

  it('is undefined (feature-detected) where process.constrainedMemory does not exist', () => {
    expect(createMemoryLimitReader({}, () => total)()).toBeUndefined();
  });

  it('reads total RAM per call, not once', () => {
    let t = 100;
    const read = createMemoryLimitReader({ constrainedMemory: () => 50 }, () => t);
    expect(read()).toBe(50);
    t = 40;
    expect(read()).toBeUndefined();
  });
});

describe('parseMemAvailable', () => {
  const text =
    'MemTotal:       16384000 kB\nMemFree:          100000 kB\nMemAvailable:    8192000 kB\nBuffers: 1 kB\n';
  it('returns MemAvailable in BYTES (kB is KiB), not MemFree', () => {
    expect(parseMemAvailable(text)).toBe(8192000 * 1024);
  });
  it('is undefined when the field is absent, malformed or has no kB unit', () => {
    expect(parseMemAvailable('MemFree: 5 kB\n')).toBeUndefined();
    expect(parseMemAvailable('MemAvailable: lots kB\n')).toBeUndefined();
    expect(parseMemAvailable('MemAvailable: 5 MB\n')).toBeUndefined();
    expect(parseMemAvailable('')).toBeUndefined();
  });
  it('does not match a field that merely ends in MemAvailable', () => {
    expect(parseMemAvailable('XMemAvailable: 5 kB\n')).toBeUndefined();
  });
  it('is undefined for a value too large to be finite', () => {
    expect(parseMemAvailable(`MemAvailable: ${'9'.repeat(400)} kB\n`)).toBeUndefined();
  });
});

describe('createProcMeminfoReader', () => {
  it('reads /proc/meminfo on linux only', () => {
    const files: string[] = [];
    const read = (f: string) => (files.push(f), 'TEXT');
    expect(createProcMeminfoReader('linux', read)()).toBe('TEXT');
    expect(files).toEqual(['/proc/meminfo']);
    for (const p of ['darwin', 'win32']) {
      expect(createProcMeminfoReader(p, read)()).toBeUndefined();
    }
    expect(files).toHaveLength(1); // no read attempted off linux
  });
  it('is undefined when the read throws', () => {
    expect(
      createProcMeminfoReader('linux', () => {
        throw new Error('EACCES');
      })(),
    ).toBeUndefined();
  });
});

describe('createSystemFreeReader', () => {
  const meminfo = () => 'MemAvailable: 10 kB\n'; // 10240 bytes
  const make = (over: Partial<Parameters<typeof createSystemFreeReader>[0]> = {}) =>
    createSystemFreeReader({
      platform: 'linux',
      freemem: () => 111,
      total: () => 1_000_000,
      ...over,
    });
  const boom = () => {
    throw new Error('boom');
  };

  it('default: os.freemem() alone', () => {
    expect(make()()).toBe(111);
    expect(make({ platform: 'win32' })()).toBe(111);
  });

  it('order: native, then meminfo (when supplied), then os.freemem()', () => {
    expect(make({ native: () => 5, meminfo })()).toBe(5);
    expect(make({ native: () => undefined, meminfo })()).toBe(10240);
    expect(make({ meminfo })()).toBe(10240);
    expect(make({ meminfo: () => undefined })()).toBe(111);
    expect(make({ meminfo: () => 'nothing here' })()).toBe(111);
    expect(make({ meminfo: boom, native: boom })()).toBe(111);
  });

  it('macOS: os.freemem() is never a source (free pages only), native and meminfo still are', () => {
    expect(make({ platform: 'darwin' })()).toBeUndefined();
    expect(make({ platform: 'darwin', native: () => 7 })()).toBe(7);
    expect(make({ platform: 'darwin', meminfo })()).toBe(10240);
  });

  it('skips a source that answers an implausible value (NaN, Infinity, negative, > total)', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 1_000_001]) {
      expect(make({ freemem: () => bad })()).toBeUndefined();
      expect(make({ native: () => bad, freemem: () => 111 })()).toBe(111);
    }
    expect(make({ meminfo: () => 'MemAvailable: 999999999 kB\n' })()).toBe(111);
    expect(make({ freemem: boom })()).toBeUndefined();
  });

  it('accepts zero and a value equal to total, rejects total + 1 (boundaries)', () => {
    expect(make({ freemem: () => 0 })()).toBe(0);
    expect(make({ freemem: () => 1_000_000 })()).toBe(1_000_000);
    expect(make({ freemem: () => 1_000_001 })()).toBeUndefined();
  });

  it('re-reads total on every call (it may change)', () => {
    let total = 1000;
    const read = make({ total: () => total });
    expect(read()).toBe(111);
    total = 10;
    expect(read()).toBeUndefined();
  });
});

describe('createElectronMemoryReader (KiB -> bytes)', () => {
  const read = (platform: string, info: object | undefined) =>
    createElectronMemoryReader(
      info === undefined ? {} : { getSystemMemoryInfo: () => info },
      platform,
    )();

  it('macOS: free + fileBacked + purgeable', () => {
    expect(read('darwin', { free: 1, fileBacked: 10, purgeable: 100, available: 9999 })).toBe(
      111 * 1024,
    );
    expect(read('darwin', { free: 1, fileBacked: 10 })).toBeUndefined();
    expect(read('darwin', { free: 1, fileBacked: 'x', purgeable: 3 })).toBeUndefined();
  });

  it('Linux: available (not free). Windows: free', () => {
    expect(read('linux', { free: 1, available: 7 })).toBe(7 * 1024);
    expect(read('linux', { free: 1 })).toBeUndefined();
    expect(read('win32', { free: 5, available: 9 })).toBe(5 * 1024);
    expect(read('win32', { available: 9 })).toBeUndefined();
  });

  it('is undefined on another platform, without the API, or for non-finite/negative values', () => {
    expect(read('freebsd', { free: 1, available: 1 })).toBeUndefined();
    expect(read('linux', undefined)).toBeUndefined();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(read('linux', { available: bad })).toBeUndefined();
    }
  });
});

describe('createDenoMemoryReader (bytes)', () => {
  const deno = { systemMemoryInfo: () => ({ available: 4096 }) };
  it('reports available on macOS only', () => {
    expect(createDenoMemoryReader(deno, 'darwin')()).toBe(4096);
    expect(createDenoMemoryReader(deno, 'linux')()).toBeUndefined();
    expect(createDenoMemoryReader(deno, 'win32')()).toBeUndefined();
  });
  it('is undefined without Deno/the API or for implausible values', () => {
    expect(createDenoMemoryReader(undefined, 'darwin')()).toBeUndefined();
    expect(createDenoMemoryReader({}, 'darwin')()).toBeUndefined();
    for (const bad of [Number.NaN, -1, '5']) {
      expect(
        createDenoMemoryReader({ systemMemoryInfo: () => ({ available: bad }) }, 'darwin')(),
      ).toBeUndefined();
    }
  });
});

describe('firstAnswer', () => {
  it('returns the first defined answer, skipping undefined and throwing readers', () => {
    const boom = () => {
      throw new Error('x');
    };
    expect(firstAnswer([() => undefined, boom, () => 0, () => 5])()).toBe(0);
    expect(firstAnswer([boom, () => undefined])()).toBeUndefined();
    expect(firstAnswer([])()).toBeUndefined();
  });
});
