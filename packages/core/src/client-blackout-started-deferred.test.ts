import { describe, expect, it } from 'vitest';
import { BlackoutToken } from './blackout';
import { asInternalClient, createClient } from './client';
import { LifecycleEvents } from './lifecycle-events';

// A blackout raised silently before launch (`startInBlackout`) owes the application
// ONE BlackoutStarted, after Launching: but never after a client that is no longer launched, and never AFTER an
// Ended that a Launching listener caused.

const noScheduler = { setInterval: () => 'h', clearInterval: () => {} };
const make = () => {
  const client = createClient({ scheduler: noScheduler });
  const seen: string[] = [];
  client.getService(BlackoutToken).start({ silent: true }); // the pre-launch hold
  asInternalClient(client).deferBlackoutStarted();
  return {
    client,
    seen,
    listen: (l: (type: string) => void) => client.setLifecycleEventsListener(l as never),
  };
};

describe('deferBlackoutStarted — the BlackoutStarted owed by a silent pre-launch blackout', () => {
  it('is announced once, after Launching and Launched, when the blackout is still in force', () => {
    const { client, seen, listen } = make();
    listen((type) => seen.push(type));
    client.launch();
    expect(seen).toEqual([
      LifecycleEvents.Launching,
      LifecycleEvents.Launched,
      LifecycleEvents.BlackoutStarted,
    ]);
  });

  it('a Launching listener that ends the blackout still sees Started BEFORE Ended', () => {
    const { client, seen, listen } = make();
    listen((type) => {
      seen.push(type);
      if (type === LifecycleEvents.Launching) {
        client.endBlackout();
      }
    });
    client.launch();
    expect(seen).toEqual([
      LifecycleEvents.Launching,
      LifecycleEvents.BlackoutStarted,
      LifecycleEvents.BlackoutEnded,
      LifecycleEvents.Launched,
    ]);
    expect(client.isBlackout()).toBe(false);
  });

  it('a Launching listener that ends and restarts the blackout sees exactly one Started per real start', () => {
    const { client, seen, listen } = make();
    listen((type) => {
      seen.push(type);
      if (type === LifecycleEvents.Launching) {
        client.endBlackout();
        client.startBlackout();
      }
    });
    client.launch();
    expect(seen.filter((t) => t === LifecycleEvents.BlackoutStarted)).toHaveLength(2);
    expect(seen.filter((t) => t === LifecycleEvents.BlackoutEnded)).toHaveLength(1);
    expect(seen.indexOf(LifecycleEvents.BlackoutStarted)).toBeLessThan(
      seen.indexOf(LifecycleEvents.BlackoutEnded),
    );
    expect(client.isBlackout()).toBe(true);
  });

  it('a client stopped by its Launching listener announces nothing (it is no longer launched)', () => {
    const { client, seen, listen } = make();
    listen((type) => {
      seen.push(type);
      if (type === LifecycleEvents.Launching) {
        void client.stop();
      }
    });
    client.launch();
    expect(seen).not.toContain(LifecycleEvents.BlackoutStarted);
  });

  it('a client stopped by its Launched listener does not announce either', () => {
    const { client, seen, listen } = make();
    listen((type) => {
      seen.push(type);
      if (type === LifecycleEvents.Launched) {
        void client.stop();
      }
    });
    client.launch();
    expect(seen).not.toContain(LifecycleEvents.BlackoutStarted);
  });

  it('nothing is owed when the blackout was ended silently before the launch finished', () => {
    const { client, seen, listen } = make();
    listen((type) => seen.push(type));
    client.getService(BlackoutToken).end({ silent: true });
    client.launch();
    expect(seen).toEqual([LifecycleEvents.Launching, LifecycleEvents.Launched]);
  });

  it('without deferBlackoutStarted a silent hold never announces itself', () => {
    const client = createClient({ scheduler: noScheduler });
    const seen: string[] = [];
    client.setLifecycleEventsListener(((type: string) => seen.push(type)) as never);
    client.getService(BlackoutToken).start({ silent: true });
    client.launch();
    expect(seen).toEqual([LifecycleEvents.Launching, LifecycleEvents.Launched]);
  });

  it('is internal: the public surface does not carry it', () => {
    const client = createClient({ scheduler: noScheduler });
    expect((client as unknown as Record<string, unknown>).deferBlackoutStarted).toBeUndefined();
  });
});
