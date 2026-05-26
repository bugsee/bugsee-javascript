import { describe, expect, it, vi } from 'vitest';
import type { Client, DetectionProvider, TriggerHint } from './contracts';
import { createDetectionCoordinator } from './detection-coordinator';

const client = { tag: 'client' } as unknown as Client;
const enableAll = () => true;
const noTrigger: (h: TriggerHint) => void = () => {};

// A fake provider that captures the trigger callback so tests can fire it.
function makeProvider(name: string, controllingOption?: string) {
  let captured: ((hint: TriggerHint) => void) | undefined;
  const provider: DetectionProvider = {
    name,
    ...(controllingOption !== undefined ? { controllingOption } : {}),
    start: vi.fn((_client: Client, trigger: (hint: TriggerHint) => void) => {
      captured = trigger;
    }),
    stop: vi.fn(),
  };
  return { provider, fire: (hint: TriggerHint) => captured?.(hint) };
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

  it('starts an enabled provider with the client and a trigger callback', () => {
    const co = createDetectionCoordinator();
    const { provider } = makeProvider('crash', 'detectCrash');
    co.addProvider(provider);
    co.start(client, (opt) => opt === 'detectCrash', noTrigger);
    expect(provider.start).toHaveBeenCalledTimes(1);
    expect((provider.start as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toBe(client);
    expect(typeof (provider.start as ReturnType<typeof vi.fn>).mock.calls[0]?.[1]).toBe('function');
  });

  it('routes a fired trigger to onTrigger with the hint', () => {
    const co = createDetectionCoordinator();
    const { provider, fire } = makeProvider('crash');
    const onTrigger = vi.fn();
    co.addProvider(provider);
    co.start(client, enableAll, onTrigger);
    const hint: TriggerHint = { source: 'uncaught', summary: 'boom' };
    fire(hint);
    expect(onTrigger).toHaveBeenCalledWith(hint);
  });

  it('starts a no-controllingOption provider even when the gate denies everything', () => {
    const co = createDetectionCoordinator();
    const { provider } = makeProvider('crash');
    co.addProvider(provider);
    co.start(client, () => false, noTrigger);
    expect(provider.start).toHaveBeenCalledTimes(1);
  });

  it('skips a provider whose controllingOption is disabled', () => {
    const co = createDetectionCoordinator();
    const { provider } = makeProvider('http', 'detectHttpErrors');
    co.addProvider(provider);
    co.start(client, () => false, noTrigger);
    expect(provider.start).not.toHaveBeenCalled();
  });

  it('throws if started twice', () => {
    const co = createDetectionCoordinator();
    co.start(client, enableAll, noTrigger);
    expect(() => co.start(client, enableAll, noTrigger)).toThrow(/already started/);
  });

  it('stops only started providers; idempotent when not started', () => {
    const co = createDetectionCoordinator();
    const on = makeProvider('on');
    const off = makeProvider('off', 'disabled');
    co.addProvider(on.provider);
    co.addProvider(off.provider);
    co.start(client, (opt) => opt !== 'disabled', noTrigger);
    co.stop();
    expect(on.provider.stop).toHaveBeenCalledTimes(1);
    expect(off.provider.stop).not.toHaveBeenCalled();
    expect(() => co.stop()).not.toThrow();
  });

  it('can be restarted after stop', () => {
    const co = createDetectionCoordinator();
    const { provider } = makeProvider('crash');
    co.addProvider(provider);
    co.start(client, enableAll, noTrigger);
    co.stop();
    co.start(client, enableAll, noTrigger);
    expect(provider.start).toHaveBeenCalledTimes(2);
  });

  it('starts a provider added while running and wires its trigger', () => {
    const co = createDetectionCoordinator();
    const onTrigger = vi.fn();
    co.start(client, enableAll, onTrigger);
    const { provider, fire } = makeProvider('late');
    co.addProvider(provider);
    expect(provider.start).toHaveBeenCalledTimes(1);
    const hint: TriggerHint = { source: 'programmatic' };
    fire(hint);
    expect(onTrigger).toHaveBeenCalledWith(hint);
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
