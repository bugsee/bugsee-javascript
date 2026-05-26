import { describe, expect, it, vi } from 'vitest';
import type { Client, DetectionProvider } from './contracts';
import { createDetectionCoordinator } from './detection-coordinator';
import { createReportingRequest, type ReportingRequest } from './reporting';

const client = { tag: 'client' } as unknown as Client;
const enableAll = () => true;
const noReport: (request: ReportingRequest) => void = () => {};
const request = (id: string): ReportingRequest =>
  createReportingRequest({ source: { type: 'crash' }, id });

// A fake provider that captures the report callback so tests can submit a request through it.
function makeProvider(name: string, controllingOption?: string) {
  let captured: ((request: ReportingRequest) => void) | undefined;
  const provider: DetectionProvider = {
    name,
    ...(controllingOption !== undefined ? { controllingOption } : {}),
    start: vi.fn((_client: Client, report: (request: ReportingRequest) => void) => {
      captured = report;
    }),
    stop: vi.fn(),
  };
  return { provider, fire: (req: ReportingRequest) => captured?.(req) };
}

describe('createDetectionCoordinator', () => {
  it('registers providers', () => {
    const co = createDetectionCoordinator();
    const { provider } = makeProvider('crash');
    co.addProvider(provider);
    expect(co.providers).toContain(provider);
  });

  it('throws on a duplicate provider name', () => {
    const co = createDetectionCoordinator();
    co.addProvider(makeProvider('crash').provider);
    expect(() => co.addProvider(makeProvider('crash').provider)).toThrow(/already registered/);
  });

  it('starts an enabled provider with the client and a report callback', () => {
    const co = createDetectionCoordinator();
    const { provider } = makeProvider('crash', 'detectCrash');
    co.addProvider(provider);
    co.start(client, (opt) => opt === 'detectCrash', noReport);
    expect(provider.start).toHaveBeenCalledTimes(1);
    expect((provider.start as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(client);
    expect(typeof (provider.start as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toBe('function');
  });

  it('routes a submitted request to onReport', () => {
    const co = createDetectionCoordinator();
    const { provider, fire } = makeProvider('crash');
    const onReport = vi.fn();
    co.addProvider(provider);
    co.start(client, enableAll, onReport);
    const req = request('r1');
    fire(req);
    expect(onReport).toHaveBeenCalledWith(req);
  });

  it('starts a no-controllingOption provider even when the gate denies everything', () => {
    const co = createDetectionCoordinator();
    const { provider } = makeProvider('crash');
    co.addProvider(provider);
    co.start(client, () => false, noReport);
    expect(provider.start).toHaveBeenCalledTimes(1);
  });

  it('skips a provider whose controllingOption is disabled', () => {
    const co = createDetectionCoordinator();
    const { provider } = makeProvider('http', 'detectHttpErrors');
    co.addProvider(provider);
    co.start(client, () => false, noReport);
    expect(provider.start).not.toHaveBeenCalled();
  });

  it('throws if started twice', () => {
    const co = createDetectionCoordinator();
    co.start(client, enableAll, noReport);
    expect(() => co.start(client, enableAll, noReport)).toThrow(/already started/);
  });

  it('stops only started providers; idempotent when not started', () => {
    const co = createDetectionCoordinator();
    const on = makeProvider('on');
    const off = makeProvider('off', 'disabled');
    co.addProvider(on.provider);
    co.addProvider(off.provider);
    co.start(client, (opt) => opt !== 'disabled', noReport);
    co.stop();
    expect(on.provider.stop).toHaveBeenCalledTimes(1);
    expect(off.provider.stop).not.toHaveBeenCalled();
    expect(() => co.stop()).not.toThrow();
  });

  it('can be restarted after stop', () => {
    const co = createDetectionCoordinator();
    const { provider } = makeProvider('crash');
    co.addProvider(provider);
    co.start(client, enableAll, noReport);
    co.stop();
    co.start(client, enableAll, noReport);
    expect(provider.start).toHaveBeenCalledTimes(2);
  });

  it('starts a provider added while running and wires its report callback', () => {
    const co = createDetectionCoordinator();
    const onReport = vi.fn();
    co.start(client, enableAll, onReport);
    const { provider, fire } = makeProvider('late');
    co.addProvider(provider);
    expect(provider.start).toHaveBeenCalledTimes(1);
    const req = request('late-1');
    fire(req);
    expect(onReport).toHaveBeenCalledWith(req);
  });

  it('only registers (does not start) a provider added while not running', () => {
    const co = createDetectionCoordinator();
    const { provider } = makeProvider('crash');
    co.addProvider(provider);
    expect(provider.start).not.toHaveBeenCalled();
  });

  it('providers getter returns a copy', () => {
    const co = createDetectionCoordinator();
    co.addProvider(makeProvider('a').provider);
    const snapshot = co.providers as DetectionProvider[];
    snapshot.push(makeProvider('injected').provider);
    expect(co.providers).toHaveLength(1);
  });
});
