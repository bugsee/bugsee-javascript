import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isBrowser,
  isBun,
  isCloudflareWorker,
  isDeno,
  isElectronMain,
  isElectronRenderer,
  isNode,
  isServiceWorker,
  isVercelEdge,
  isWebWorker,
} from './env';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isBun', () => {
  it('is false without a Bun global', () => expect(isBun()).toBe(false));
  it('is true with a Bun global', () => {
    vi.stubGlobal('Bun', {});
    expect(isBun()).toBe(true);
  });
});

describe('isDeno', () => {
  it('is false without a Deno global', () => expect(isDeno()).toBe(false));
  it('is true with a Deno global', () => {
    vi.stubGlobal('Deno', {});
    expect(isDeno()).toBe(true);
  });
});

describe('isNode', () => {
  it('is true in a Node process (default test env)', () => expect(isNode()).toBe(true));
  it('is false when Bun is present', () => {
    vi.stubGlobal('Bun', {});
    expect(isNode()).toBe(false);
  });
  it('is false when Deno is present', () => {
    vi.stubGlobal('Deno', {});
    expect(isNode()).toBe(false);
  });
  it('is false without a process global', () => {
    vi.stubGlobal('process', undefined);
    expect(isNode()).toBe(false);
  });
  it('is false when process.versions is missing', () => {
    vi.stubGlobal('process', {});
    expect(isNode()).toBe(false);
  });
  it('is false when process.versions.node is missing', () => {
    vi.stubGlobal('process', { versions: {} });
    expect(isNode()).toBe(false);
  });
});

describe('isBrowser', () => {
  it('is false without window (default)', () => expect(isBrowser()).toBe(false));
  it('is true with window.document', () => {
    vi.stubGlobal('window', { document: {} });
    expect(isBrowser()).toBe(true);
  });
  it('is false when window has no document', () => {
    vi.stubGlobal('window', {});
    expect(isBrowser()).toBe(false);
  });
});

describe('isWebWorker', () => {
  it('is false without importScripts (default)', () => expect(isWebWorker()).toBe(false));
  it('is true with an importScripts function', () => {
    vi.stubGlobal('importScripts', () => undefined);
    expect(isWebWorker()).toBe(true);
  });
});

describe('isServiceWorker', () => {
  it('is false without ServiceWorkerGlobalScope (default)', () =>
    expect(isServiceWorker()).toBe(false));
  it('is true with ServiceWorkerGlobalScope', () => {
    vi.stubGlobal('ServiceWorkerGlobalScope', {});
    expect(isServiceWorker()).toBe(true);
  });
});

describe('isCloudflareWorker', () => {
  it('is false with a non-Cloudflare navigator (default)', () =>
    expect(isCloudflareWorker()).toBe(false));
  it('is true with the Cloudflare userAgent', () => {
    vi.stubGlobal('navigator', { userAgent: 'Cloudflare-Workers' });
    expect(isCloudflareWorker()).toBe(true);
  });
  it('is false without navigator', () => {
    vi.stubGlobal('navigator', undefined);
    expect(isCloudflareWorker()).toBe(false);
  });
});

describe('isVercelEdge', () => {
  it('is false without EdgeRuntime (default)', () => expect(isVercelEdge()).toBe(false));
  it('is true when EdgeRuntime is a string', () => {
    vi.stubGlobal('EdgeRuntime', 'edge-runtime');
    expect(isVercelEdge()).toBe(true);
  });
  it('is false when EdgeRuntime is not a string', () => {
    vi.stubGlobal('EdgeRuntime', 1);
    expect(isVercelEdge()).toBe(false);
  });
});

describe('isElectronRenderer', () => {
  it('is false in a plain Node process (default)', () => expect(isElectronRenderer()).toBe(false));
  it('is true when process.type is renderer', () => {
    vi.stubGlobal('process', { type: 'renderer' });
    expect(isElectronRenderer()).toBe(true);
  });
  it('is false without process', () => {
    vi.stubGlobal('process', undefined);
    expect(isElectronRenderer()).toBe(false);
  });
});

describe('isElectronMain', () => {
  it('is false in a plain Node process (default)', () => expect(isElectronMain()).toBe(false));
  it('is true with an electron version and browser type', () => {
    vi.stubGlobal('process', { versions: { electron: '30.0.0' }, type: 'browser' });
    expect(isElectronMain()).toBe(true);
  });
  it('is false when type is renderer', () => {
    vi.stubGlobal('process', { versions: { electron: '30.0.0' }, type: 'renderer' });
    expect(isElectronMain()).toBe(false);
  });
  it('is false without process', () => {
    vi.stubGlobal('process', undefined);
    expect(isElectronMain()).toBe(false);
  });
});
