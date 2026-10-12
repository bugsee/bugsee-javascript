import { describe, expect, it, vi } from 'vitest';
import {
  claimCarrierBlackoutOwner,
  getCarrierBlackout,
  getCarrierBlackoutOwner,
  setCarrierBlackout,
} from './carrier';
import { createClient } from './client';
import { LifecycleEvents } from './lifecycle-events';

// Review round 3 (H1): R3L-4 / R3V-1. Only the client that currently owns the carrier may change the
// process-wide blackout flag; a stale handle's start/end is forwarded to the current client or reported.

const noScheduler = { setInterval: () => 'h', clearInterval: () => {} };
const build = (host: object, onError?: (e: unknown) => void) =>
  createClient({ carrier: host, scheduler: noScheduler, ...(onError ? { onError } : {}) });
const types = (events: Array<[string, unknown]>): string[] => events.map(([type]) => type);
const listen = (client: { setLifecycleEventsListener(l: never): void }) => {
  const events: Array<[string, unknown]> = [];
  client.setLifecycleEventsListener(((type: string, data: unknown) =>
    events.push([type, data])) as never);
  return events;
};

describe('carrier blackout owner', () => {
  it('starts without an owner and keeps the latest claim', () => {
    const host = {};
    expect(getCarrierBlackoutOwner(host)).toBeUndefined();
    const first = { start: () => {}, isLaunched: () => true };
    const second = { start: () => {}, isLaunched: () => true };
    claimCarrierBlackoutOwner(first, host);
    expect(getCarrierBlackoutOwner(host)).toBe(first);
    claimCarrierBlackoutOwner(second, host);
    expect(getCarrierBlackoutOwner(host)).toBe(second);
  });
});

describe('R3L-4 — a stale handle cannot change the process blackout', () => {
  it('A dark + stop, B launches dark, A.endBlackout(): B stays dark, the flag stays, the next launch is dark', async () => {
    const host = {};
    const errorsA: unknown[] = [];
    const a = build(host, (e) => errorsA.push(e));
    a.launch();
    a.startBlackout();
    await a.stop();
    const b = build(host);
    b.launch();
    expect(b.isBlackout()).toBe(true); // carried
    a.endBlackout();
    expect(b.isBlackout()).toBe(true);
    expect(getCarrierBlackout(host)).toBe(true);
    expect(errorsA).toHaveLength(1);
    expect(String((errorsA[0] as Error).message)).toMatch(/endBlackout/);
    await b.stop();
    expect(build(host).isBlackout()).toBe(true); // the next relaunch is still dark
  });

  it('a stale startBlackout() is forwarded to the current launched client', async () => {
    const host = {};
    const a = build(host);
    a.launch();
    await a.stop();
    const b = build(host);
    b.launch();
    const events = listen(b);
    a.startBlackout();
    expect(b.isBlackout()).toBe(true);
    expect(getCarrierBlackout(host)).toBe(true);
    expect(types(events)).toEqual([LifecycleEvents.BlackoutStarted]);
    expect(a.isBlackout()).toBe(true); // R4L-5: a stale handle answers with the process flag, not its own state
  });

  it('R4L-5: a stale handle reflects the carrier flag both ways', async () => {
    const host = {};
    const a = build(host);
    a.launch();
    await a.stop();
    const b = build(host);
    b.launch();
    expect(a.isBlackout()).toBe(false);
    b.startBlackout();
    expect(a.isBlackout()).toBe(true);
    b.endBlackout();
    expect(a.isBlackout()).toBe(false);
  });

  it('a stale startBlackout() with no launched current client is reported, and changes nothing', async () => {
    const host = {};
    const errors: unknown[] = [];
    const a = build(host, (e) => errors.push(e));
    a.launch();
    await a.stop();
    const b = build(host);
    b.launch();
    await b.stop(); // B owns the carrier but is stopped: nobody is current
    a.startBlackout();
    expect(errors).toHaveLength(1);
    expect(String((errors[0] as Error).message)).toMatch(/startBlackout/);
    expect(getCarrierBlackout(host)).toBe(false);
    expect(b.isBlackout()).toBe(false);
  });

  it('a stale handle never writes the carrier flag through its own state either', async () => {
    const host = {};
    const a = build(host);
    a.launch();
    await a.stop();
    const b = build(host);
    b.launch();
    // an internal hold on the stale client (the BlackoutToken service) must not leak into the process flag
    const { BlackoutToken } = await import('./blackout');
    a.getService(BlackoutToken).start({ silent: true });
    expect(getCarrierBlackout(host)).toBe(false);
    a.getService(BlackoutToken).end({ silent: true });
    setCarrierBlackout(true, host);
    a.getService(BlackoutToken).start({ silent: true });
    a.getService(BlackoutToken).end({ silent: true });
    expect(getCarrierBlackout(host)).toBe(true);
  });

  it('the last client to stop can still lift the carried flag quietly when nothing replaced it (R2L-7)', async () => {
    const host = {};
    const errors = vi.fn();
    const a = build(host, errors);
    a.launch();
    a.startBlackout();
    await a.stop();
    const events = listen(a);
    a.endBlackout();
    expect(events).toEqual([]);
    expect(getCarrierBlackout(host)).toBe(false);
    expect(errors).not.toHaveBeenCalled();
  });

  it('a client that never launched and has no rival still ends a carried blackout', () => {
    const host = {};
    setCarrierBlackout(true, host);
    const a = build(host);
    expect(a.isBlackout()).toBe(true);
    a.endBlackout();
    expect(getCarrierBlackout(host)).toBe(false);
  });

  it('a client built after another owns the carrier from creation (an unlaunched hold must reach the flag)', () => {
    const host = {};
    const a = build(host);
    a.launch();
    a.startBlackout();
    expect(getCarrierBlackout(host)).toBe(true);
    const errors: unknown[] = [];
    const b = createClient({
      carrier: host,
      scheduler: noScheduler,
      onError: (e) => errors.push(e),
    });
    a.endBlackout(); // a is stale now: nothing is lifted
    expect(getCarrierBlackout(host)).toBe(true);
    b.endBlackout(); // b owns the carrier: it lifts the carried flag
    expect(getCarrierBlackout(host)).toBe(false);
    expect(errors).toEqual([]);
  });

  it('launching re-claims the carrier for the launched client', () => {
    const host = {};
    const a = build(host);
    const b = build(host);
    a.launch(); // created before b, launched after: a is current again
    a.startBlackout();
    expect(a.isBlackout()).toBe(true);
    expect(getCarrierBlackout(host)).toBe(true);
    b.startBlackout(); // never launched, stale: forwarded to a (already dark), never applied to b itself
    expect(getCarrierBlackout(host)).toBe(true);
    expect(b.isBlackout()).toBe(true); // a stale handle answers with the process flag (R4L-5)
  });

  it('a client without a carrier is its own owner', () => {
    const client = createClient({ scheduler: noScheduler });
    client.launch();
    client.startBlackout();
    expect(client.isBlackout()).toBe(true);
    client.endBlackout();
    expect(client.isBlackout()).toBe(false);
  });
});
