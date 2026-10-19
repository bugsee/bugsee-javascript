import { describe, expect, it, vi } from 'vitest';
import { createGpuInfoCache, mapGpuInfo } from './gpu-info-cache';

const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const basic = (devices: unknown[]) => ({ gpuDevice: devices });

describe('mapGpuInfo', () => {
  it('uses the ACTIVE device strings', () => {
    expect(
      mapGpuInfo(
        basic([
          { vendorId: 1, deviceId: 2, active: false, vendorString: 'Intel', deviceString: 'UHD' },
          {
            vendorId: 4318,
            deviceId: 9,
            active: true,
            vendorString: 'NVIDIA',
            deviceString: 'RTX',
          },
        ]),
      ),
    ).toEqual({ vendor: 'NVIDIA', renderer: 'RTX' });
  });

  it('uses the only device when none is flagged active, but never guesses among several', () => {
    expect(mapGpuInfo(basic([{ vendorString: 'V', deviceString: 'R' }]))).toEqual({
      vendor: 'V',
      renderer: 'R',
    });
    expect(
      mapGpuInfo(
        basic([
          { vendorString: 'A', deviceString: 'a' },
          { vendorString: 'B', deviceString: 'b' },
        ]),
      ),
    ).toBeUndefined();
  });

  it('omits a field whose string is missing; never invents a vendor from a numeric id', () => {
    expect(mapGpuInfo(basic([{ active: true, vendorId: 4318, vendorString: 'NVIDIA' }]))).toEqual({
      vendor: 'NVIDIA',
    });
    expect(mapGpuInfo(basic([{ active: true, deviceString: 'RTX' }]))).toEqual({ renderer: 'RTX' });
    expect(mapGpuInfo(basic([{ active: true, vendorId: 4318, deviceId: 7 }]))).toBeUndefined();
    expect(
      mapGpuInfo(basic([{ active: true, vendorString: '  ', deviceString: 5 }])),
    ).toBeUndefined();
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'gpu'],
    ['no gpuDevice', {}],
    ['a non-array gpuDevice', { gpuDevice: 'x' }],
    ['an empty list', { gpuDevice: [] }],
    ['non-object devices', { gpuDevice: [1, null, 'x'] }],
  ])('returns undefined for %s', (_n, value) => {
    expect(mapGpuInfo(value)).toBeUndefined();
  });
});

describe('createGpuInfoCache', () => {
  const info = basic([{ active: true, vendorString: 'V', deviceString: 'R' }]);

  it('is undefined until the Promise settles, then serves the mapped gpu', async () => {
    const d = deferred<unknown>();
    const getGPUInfo = vi.fn(() => d.promise);
    const cache = createGpuInfoCache({ source: { getGPUInfo } });
    cache.start();
    expect(getGPUInfo).toHaveBeenCalledExactlyOnceWith('basic');
    expect(cache.current()).toBeUndefined();
    d.resolve(info);
    await flush();
    expect(cache.current()).toEqual({ gpu: { vendor: 'V', renderer: 'R' } });
  });

  it('kicks getGPUInfo once even when start() is called repeatedly', () => {
    const getGPUInfo = vi.fn(() => new Promise<unknown>(() => {}));
    const cache = createGpuInfoCache({ source: { getGPUInfo } });
    cache.start();
    cache.start();
    expect(getGPUInfo).toHaveBeenCalledTimes(1);
  });

  it('returns a copy, so a consumer cannot mutate the cache', async () => {
    const cache = createGpuInfoCache({ source: { getGPUInfo: async () => info } });
    cache.start();
    await flush();
    (cache.current() as { gpu: { vendor?: string } }).gpu.vendor = 'hacked';
    expect(cache.current()).toEqual({ gpu: { vendor: 'V', renderer: 'R' } });
  });

  it('a rejection becomes omit + onError, with NO unhandledRejection', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const boom = new Error('no acceleration');
      const onError = vi.fn();
      const cache = createGpuInfoCache({
        source: { getGPUInfo: () => Promise.reject(boom) },
        onError,
      });
      cache.start();
      await flush();
      await flush();
      expect(cache.current()).toBeUndefined();
      expect(onError).toHaveBeenCalledExactlyOnceWith(boom);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a rejection with no onError, and a throwing onError, stay silent', async () => {
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    try {
      createGpuInfoCache({ source: { getGPUInfo: () => Promise.reject(new Error('x')) } }).start();
      const c2 = createGpuInfoCache({
        source: { getGPUInfo: () => Promise.reject(new Error('y')) },
        onError: () => {
          throw new Error('sink');
        },
      });
      c2.start();
      await flush();
      await flush();
      expect(c2.current()).toBeUndefined();
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('a synchronous throw from getGPUInfo is reported, not propagated', () => {
    const boom = new Error('sync');
    const onError = vi.fn();
    const cache = createGpuInfoCache({
      source: {
        getGPUInfo: () => {
          throw boom;
        },
      },
      onError,
    });
    expect(() => cache.start()).not.toThrow();
    expect(onError).toHaveBeenCalledExactlyOnceWith(boom);
    expect(cache.current()).toBeUndefined();
  });

  it('a hostile result whose mapping throws is reported and omitted', async () => {
    const hostile = {
      get gpuDevice(): unknown {
        throw new Error('getter');
      },
    };
    const onError = vi.fn();
    const cache = createGpuInfoCache({ source: { getGPUInfo: async () => hostile }, onError });
    cache.start();
    await flush();
    expect(cache.current()).toBeUndefined();
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('a late resolve after stop() is ignored (no cache write) and a late reject is not reported', async () => {
    const d = deferred<unknown>();
    const onError = vi.fn();
    const cache = createGpuInfoCache({ source: { getGPUInfo: () => d.promise }, onError });
    cache.start();
    cache.stop();
    d.resolve(info);
    await flush();
    expect(cache.current()).toBeUndefined();

    const d2 = deferred<unknown>();
    const cache2 = createGpuInfoCache({ source: { getGPUInfo: () => d2.promise }, onError });
    cache2.start();
    cache2.stop();
    d2.reject(new Error('late'));
    await flush();
    expect(onError).not.toHaveBeenCalled();
  });

  it('stop() drops an already-cached value', async () => {
    const cache = createGpuInfoCache({ source: { getGPUInfo: async () => info } });
    cache.start();
    await flush();
    expect(cache.current()).toBeDefined();
    cache.stop();
    expect(cache.current()).toBeUndefined();
  });

  it('a start() after stop() begins afresh, and the OLD promise cannot write into the new run', async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const getGPUInfo = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    const cache = createGpuInfoCache({ source: { getGPUInfo } });
    cache.start();
    cache.stop();
    cache.start();
    expect(getGPUInfo).toHaveBeenCalledTimes(2);
    first.resolve(basic([{ active: true, vendorString: 'OLD' }]));
    await flush();
    expect(cache.current()).toBeUndefined();
    second.resolve(basic([{ active: true, vendorString: 'NEW' }]));
    await flush();
    expect(cache.current()).toEqual({ gpu: { vendor: 'NEW' } });
  });

  it.each([
    ['no source', undefined],
    ['a source without getGPUInfo', {}],
    ['a non-function getGPUInfo', { getGPUInfo: 5 as never }],
  ])('%s: nothing cached, no error', (_n, source) => {
    const onError = vi.fn();
    const cache = createGpuInfoCache({ source, onError });
    expect(() => {
      cache.start();
      cache.stop();
    }).not.toThrow();
    expect(cache.current()).toBeUndefined();
    expect(onError).not.toHaveBeenCalled();
  });

  it('tolerates being used with no options at all', () => {
    const cache = createGpuInfoCache();
    cache.start();
    expect(cache.current()).toBeUndefined();
  });
});
