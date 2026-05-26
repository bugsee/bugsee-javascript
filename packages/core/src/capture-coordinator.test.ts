import { describe, expect, it, vi } from 'vitest';
import { createCaptureCoordinator } from './capture-coordinator';
import type { CaptureProvider, Client } from './contracts';

const client = { tag: 'client' } as unknown as Client;
const enableAll = () => true;

function makeProvider(name: string, controllingOption?: string): CaptureProvider {
  return {
    name,
    wireFileType: 'network',
    filename: `${name}.json`,
    ...(controllingOption !== undefined ? { controllingOption } : {}),
    start: vi.fn(),
    stop: vi.fn(),
    serialize: () => '',
  };
}

describe('createCaptureCoordinator', () => {
  it('registers providers', () => {
    const co = createCaptureCoordinator();
    const p = makeProvider('a');
    co.addProvider(p);
    expect(co.providers).toContain(p);
  });

  it('throws on a duplicate provider name', () => {
    const co = createCaptureCoordinator();
    co.addProvider(makeProvider('a'));
    expect(() => co.addProvider(makeProvider('a'))).toThrow(/already registered/);
  });

  it('starts a provider without a controllingOption, passing the client', () => {
    const co = createCaptureCoordinator();
    const p = makeProvider('a');
    co.addProvider(p);
    co.start(client, enableAll);
    expect(p.start).toHaveBeenCalledTimes(1);
    expect(p.start).toHaveBeenCalledWith(client);
  });

  it('starts a no-controllingOption provider even when the gate denies everything', () => {
    // pins the `controllingOption === undefined` short-circuit: the gate must not be consulted
    const co = createCaptureCoordinator();
    const p = makeProvider('a'); // no controllingOption
    co.addProvider(p);
    co.start(client, () => false);
    expect(p.start).toHaveBeenCalledTimes(1);
  });

  it('starts a provider whose controllingOption is enabled', () => {
    const co = createCaptureCoordinator();
    const p = makeProvider('net', 'captureNetwork');
    co.addProvider(p);
    co.start(client, (opt) => opt === 'captureNetwork');
    expect(p.start).toHaveBeenCalledTimes(1);
  });

  it('skips a provider whose controllingOption is disabled', () => {
    const co = createCaptureCoordinator();
    const p = makeProvider('net', 'captureNetwork');
    co.addProvider(p);
    co.start(client, () => false);
    expect(p.start).not.toHaveBeenCalled();
  });

  it('throws if started twice', () => {
    const co = createCaptureCoordinator();
    co.start(client, enableAll);
    expect(() => co.start(client, enableAll)).toThrow(/already started/);
  });

  it('stops only the providers that were started', () => {
    const co = createCaptureCoordinator();
    const on = makeProvider('on');
    const off = makeProvider('off', 'disabled');
    co.addProvider(on);
    co.addProvider(off);
    co.start(client, (opt) => opt !== 'disabled');
    co.stop();
    expect(on.stop).toHaveBeenCalledTimes(1);
    expect(off.stop).not.toHaveBeenCalled();
  });

  it('stop is a no-op when not started', () => {
    const co = createCaptureCoordinator();
    const p = makeProvider('a');
    co.addProvider(p);
    expect(() => co.stop()).not.toThrow();
    expect(p.stop).not.toHaveBeenCalled();
  });

  it('can be restarted after stop', () => {
    const co = createCaptureCoordinator();
    const p = makeProvider('a');
    co.addProvider(p);
    co.start(client, enableAll);
    co.stop();
    co.start(client, enableAll);
    expect(p.start).toHaveBeenCalledTimes(2);
  });

  it('starts a provider added while running (if enabled)', () => {
    const co = createCaptureCoordinator();
    co.start(client, enableAll);
    const p = makeProvider('late');
    co.addProvider(p);
    expect(p.start).toHaveBeenCalledTimes(1);
    expect(p.start).toHaveBeenCalledWith(client);
  });

  it('does not start a disabled provider added while running', () => {
    const co = createCaptureCoordinator();
    co.start(client, () => false);
    const p = makeProvider('late', 'off');
    co.addProvider(p);
    expect(p.start).not.toHaveBeenCalled();
  });

  it('only registers (does not start) a provider added while not running', () => {
    const co = createCaptureCoordinator();
    const p = makeProvider('a');
    co.addProvider(p);
    expect(p.start).not.toHaveBeenCalled();
  });

  it('a provider added-while-running that was skipped is not stopped', () => {
    const co = createCaptureCoordinator();
    co.start(client, () => false);
    const p = makeProvider('late', 'off');
    co.addProvider(p);
    co.stop();
    expect(p.stop).not.toHaveBeenCalled();
  });

  it('providers getter returns a copy', () => {
    const co = createCaptureCoordinator();
    co.addProvider(makeProvider('a'));
    const snapshot = co.providers as CaptureProvider[];
    snapshot.push(makeProvider('injected'));
    expect(co.providers).toHaveLength(1);
  });
});
