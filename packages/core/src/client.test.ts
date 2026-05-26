import type { NetworkEvent } from '@bugsee/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createClient } from './client';
import type { Clock } from './clock';
import type { CaptureDataEntry, CaptureProvider, DetectionProvider } from './contracts';
import { createReportingRequest, type ReportingRequest } from './reporting';
import type { UploadPipeline } from './transport';
import type { TriggerPipeline } from './trigger-pipeline';

// Fixed-time clock so capture-entry timestamps are deterministic.
const fixedClock = (wall = 1000): Clock => ({ wallNow: () => wall, monotonicNow: () => 0 });
const firstEntry = async (
  client: ReturnType<typeof createClient>,
  type: CaptureDataEntry['type'],
) => (await client.captureAggregator.snapshot()).get(type)?.[0];

// Test-only extension typing so registerExt/ext can be exercised.
declare module '@bugsee/types' {
  interface NameExtensionMapping {
    demo: { ping(): string };
  }
}

const captureProvider = (name: string): CaptureProvider => ({
  name,
  start: vi.fn(),
  stop: vi.fn(),
});
const detectionProvider = (name: string): DetectionProvider => ({
  name,
  start: vi.fn(),
  stop: vi.fn(),
});

describe('createClient — wiring', () => {
  it('exposes a working network hub', () => {
    const client = createClient();
    const seen: NetworkEvent[] = [];
    client.hubs.network.subscribe((e) => seen.push(e));
    const event: NetworkEvent = {
      timestamp: 1,
      id: 'a',
      sequence: 'a',
      mechanism: 'fetch',
      url: 'u',
      method: 'GET',
      type: 'complete',
    };
    client.hubs.network.emit(event);
    expect(seen).toEqual([event]);
  });

  it('exposes a working operation dispatcher', () => {
    const client = createClient();
    const seen: string[] = [];
    client.operations.registerObserver((o) => seen.push(o.type));
    client.operations.onOperation({ type: 'http', timestamp: 1 });
    expect(seen).toEqual(['http']);
  });

  it('exposes a working capture aggregator', async () => {
    const client = createClient();
    client.captureAggregator.addEntry({ type: 'log', timestamp: 1, data: { msg: 'hi' } });
    expect((await client.captureAggregator.snapshot()).get('log')).toHaveLength(1);
  });
});

describe('createClient — registration seams', () => {
  it('registers a capture provider (delegates to the coordinator; duplicate name throws)', () => {
    const client = createClient();
    client.addCaptureProvider(captureProvider('network'));
    expect(() => client.addCaptureProvider(captureProvider('network'))).toThrow(
      /already registered/,
    );
  });

  it('registers a detection provider (duplicate name throws)', () => {
    const client = createClient();
    client.addDetectionProvider(detectionProvider('crash'));
    expect(() => client.addDetectionProvider(detectionProvider('crash'))).toThrow(
      /already registered/,
    );
  });

  it('registers and retrieves an extension API', () => {
    const client = createClient();
    const api = { ping: () => 'pong' };
    client.registerExt('demo', api);
    expect(client.ext('demo')).toBe(api);
    expect(client.ext('demo').ping()).toBe('pong');
  });
});

describe('createClient — identity & attributes', () => {
  it('round-trips and clears the user identifier', () => {
    const client = createClient();
    expect(client.getUserIdentifier()).toBeNull();
    client.setUserIdentifier('user-1');
    expect(client.getUserIdentifier()).toBe('user-1');
    client.clearUserIdentifier();
    expect(client.getUserIdentifier()).toBeNull();
  });

  it('round-trips, reads, and clears attributes', () => {
    const client = createClient();
    expect(client.getAttribute('k')).toBeUndefined();
    client.setAttribute('k', 1);
    client.setAttribute('j', 'x');
    expect(client.getAttribute('k')).toBe(1);
    expect(client.getAllAttributes()).toEqual({ k: 1, j: 'x' });
    client.clearAttribute('k');
    expect(client.getAttribute('k')).toBeUndefined();
    client.clearAllAttributes();
    expect(client.getAllAttributes()).toEqual({});
  });

  it('uses a separate environment per client instance', () => {
    const a = createClient();
    const b = createClient();
    a.setUserIdentifier('only-a');
    expect(b.getUserIdentifier()).toBeNull();
  });
});

describe('createClient — capture entry points', () => {
  it('addBreadcrumb pushes a breadcrumbs entry stamped from the clock', async () => {
    const client = createClient({ clock: fixedClock(1000) });
    client.addBreadcrumb({ message: 'clicked', category: 'ui' });
    const entry = await firstEntry(client, 'breadcrumbs');
    expect(entry?.timestamp).toBe(1000);
    expect(entry?.data).toEqual({ message: 'clicked', category: 'ui', timestamp: 1000 });
  });

  it('addBreadcrumb honors an explicit timestamp', async () => {
    const client = createClient({ clock: fixedClock(1000) });
    client.addBreadcrumb({ message: 'x', timestamp: 42 });
    const entry = await firstEntry(client, 'breadcrumbs');
    expect(entry?.timestamp).toBe(42);
    expect((entry?.data as { timestamp: number }).timestamp).toBe(42);
  });

  it('log pushes a log entry with default level info and clock timestamp', async () => {
    const client = createClient({ clock: fixedClock(1000) });
    client.log('hello');
    expect((await firstEntry(client, 'log'))?.data).toEqual({
      timestamp: 1000,
      level: 'info',
      source: 'logger',
      message: 'hello',
    });
  });

  it('log honors an explicit level and timestamp', async () => {
    const client = createClient({ clock: fixedClock(1000) });
    client.log('boom', 'error', 7);
    expect((await firstEntry(client, 'log'))?.data).toEqual({
      timestamp: 7,
      level: 'error',
      source: 'logger',
      message: 'boom',
    });
  });

  it('event pushes an events.user entry with params', async () => {
    const client = createClient({ clock: fixedClock(1000) });
    client.event('checkout', { total: 9 });
    expect((await firstEntry(client, 'events.user'))?.data).toEqual({
      timestamp: 1000,
      name: 'checkout',
      params: { total: 9 },
    });
  });

  it('event omits params when not provided', async () => {
    const client = createClient({ clock: fixedClock(1000) });
    client.event('opened');
    expect((await firstEntry(client, 'events.user'))?.data).toEqual({
      timestamp: 1000,
      name: 'opened',
    });
  });

  it('trace pushes a traces.user entry with name and value', async () => {
    const client = createClient({ clock: fixedClock(1000) });
    client.trace('fps', 60);
    expect((await firstEntry(client, 'traces.user'))?.data).toEqual({
      timestamp: 1000,
      name: 'fps',
      value: 60,
    });
  });

  it('routes each entry to its own file type', async () => {
    const client = createClient({ clock: fixedClock(1000) });
    client.addBreadcrumb({ message: 'b' });
    client.log('l');
    client.event('e');
    client.trace('t', 1);
    const snap = await client.captureAggregator.snapshot();
    expect([...snap.keys()].sort()).toEqual(['breadcrumbs', 'events.user', 'log', 'traces.user']);
  });
});

const gatedCaptureProvider = (name: string, controllingOption?: string): CaptureProvider => ({
  name,
  ...(controllingOption !== undefined ? { controllingOption } : {}),
  start: vi.fn(),
  stop: vi.fn(),
});

function capturingDetector(name: string) {
  let captured: ((request: ReportingRequest) => void) | undefined;
  const provider: DetectionProvider = {
    name,
    start: vi.fn((_client, report: (request: ReportingRequest) => void) => {
      captured = report;
    }),
    stop: vi.fn(),
  };
  return { provider, fire: (request: ReportingRequest) => captured?.(request) };
}

function fakeUpload() {
  const flush = vi.fn(async () => true);
  const uploadPipeline: UploadPipeline = {
    enqueue: vi.fn(async () => ({ ok: true })),
    flush,
    drop: vi.fn(),
  };
  return { uploadPipeline, flush };
}

describe('createClient — lifecycle', () => {
  it('is not launched initially', () => {
    expect(createClient().isLaunched()).toBe(false);
  });

  it('launch starts capture providers and marks the client launched', () => {
    const client = createClient();
    const provider = gatedCaptureProvider('net');
    client.addCaptureProvider(provider);
    client.launch();
    expect(client.isLaunched()).toBe(true);
    expect(provider.start).toHaveBeenCalledTimes(1);
  });

  it('launch starts detection providers', () => {
    const client = createClient();
    const { provider } = capturingDetector('crash');
    client.addDetectionProvider(provider);
    client.launch();
    expect(provider.start).toHaveBeenCalledTimes(1);
  });

  it('launch is idempotent', () => {
    const client = createClient();
    const provider = gatedCaptureProvider('net');
    client.addCaptureProvider(provider);
    client.launch();
    client.launch();
    expect(provider.start).toHaveBeenCalledTimes(1);
  });

  it('routes a detection submission to the trigger pipeline', () => {
    const report = vi.fn(async () => ({ ok: true }));
    const triggerPipeline = { report } as TriggerPipeline;
    const client = createClient({ triggerPipeline });
    const { provider, fire } = capturingDetector('crash');
    client.addDetectionProvider(provider);
    client.launch();
    const request = createReportingRequest({ source: { type: 'crash' }, id: 'r1' });
    fire(request);
    expect(report).toHaveBeenCalledWith(request);
  });

  it('respects the option gate (a disabled capture provider is not started)', () => {
    const client = createClient({ isEnabled: (opt) => opt !== 'captureNetwork' });
    const provider = gatedCaptureProvider('net', 'captureNetwork');
    client.addCaptureProvider(provider);
    client.launch();
    expect(provider.start).not.toHaveBeenCalled();
  });

  it('uses an all-enabled gate by default (a gated provider still starts)', () => {
    const client = createClient(); // no isEnabled -> default all-enabled gate
    const provider = gatedCaptureProvider('net', 'captureNetwork');
    client.addCaptureProvider(provider);
    client.launch();
    expect(provider.start).toHaveBeenCalledTimes(1);
  });

  it('stop stops providers, drains uploads, and clears launched', async () => {
    const { uploadPipeline, flush } = fakeUpload();
    const client = createClient({ uploadPipeline });
    const provider = gatedCaptureProvider('net');
    client.addCaptureProvider(provider);
    client.launch();
    const drained = await client.stop(50);
    expect(drained).toBe(true);
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(flush).toHaveBeenCalledWith(50);
    expect(client.isLaunched()).toBe(false);
  });

  it('stop is a no-op when not launched (does not flush)', async () => {
    const { uploadPipeline, flush } = fakeUpload();
    const client = createClient({ uploadPipeline });
    expect(await client.stop()).toBe(true);
    expect(flush).not.toHaveBeenCalled();
  });

  it('stop without an upload pipeline stops providers and resolves true', async () => {
    const client = createClient(); // no uploadPipeline
    const provider = gatedCaptureProvider('net');
    client.addCaptureProvider(provider);
    client.launch();
    expect(await client.stop()).toBe(true);
    expect(provider.stop).toHaveBeenCalledTimes(1);
    expect(client.isLaunched()).toBe(false);
  });

  it('flush delegates to the upload pipeline', async () => {
    const { uploadPipeline, flush } = fakeUpload();
    const client = createClient({ uploadPipeline });
    await client.flush(99);
    expect(flush).toHaveBeenCalledWith(99);
  });

  it('flush without an upload pipeline resolves true', async () => {
    expect(await createClient().flush()).toBe(true);
  });

  it('can relaunch after stop', () => {
    const client = createClient();
    const provider = gatedCaptureProvider('net');
    client.addCaptureProvider(provider);
    client.launch();
    void client.stop();
    client.launch();
    expect(provider.start).toHaveBeenCalledTimes(2);
  });
});
