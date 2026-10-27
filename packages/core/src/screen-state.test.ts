import { ScreenTracker } from '@bugsee/trackers';
import { describe, expect, it } from 'vitest';
import { getCarrier } from './carrier';
import { createClient } from './client';
import { BugseeError } from './errors';
import { createMemoryCaptureStore } from './memory-capture-store';
import { screenTrackerFor } from './screen-state';

// `client.setRoute` / `client.setView` feed the process-carrier-shared ScreenTracker, which the `route` / `view`
// trace producer (a platform tier) listens to. Sanitizing is protocol's (tested there); here: the wiring, the
// carrier sharing, the gating, and that nothing the caller passes can throw out of the client.

const make = (carrier: object = {}) => ({ carrier, client: createClient({ carrier }) });

describe('screenTrackerFor', () => {
  it('is one ScreenTracker per carrier', () => {
    const a = {};
    const b = {};
    expect(screenTrackerFor(a)).toBeInstanceOf(ScreenTracker);
    expect(screenTrackerFor(a)).toBe(screenTrackerFor(a));
    expect(screenTrackerFor(a)).not.toBe(screenTrackerFor(b));
  });

  it('lives in its own carrier slot, not the interceptor map (that map is one global patch per entry)', () => {
    const carrier = {};
    const tracker = screenTrackerFor(carrier);
    expect(getCarrier(carrier).screenTracker).toBe(tracker);
    expect(getCarrier(carrier).interceptors.size).toBe(0);
  });

  it('defaults to the global carrier', () => {
    expect(screenTrackerFor()).toBe(screenTrackerFor(globalThis));
  });

  it('hands the listener-error reporter to the tracker it creates', () => {
    const errors: unknown[] = [];
    const carrier = {};
    const tracker = screenTrackerFor(carrier, (e) => errors.push(e));
    tracker.on('route', () => {
      throw new Error('boom');
    });
    tracker.setRoute('/x');
    expect(errors).toHaveLength(1);
  });
});

describe('client.setRoute', () => {
  it('writes the sanitized pattern to the shared tracker, even before launch', () => {
    const { carrier, client } = make();
    client.setRoute('/orders/:id');
    expect(screenTrackerFor(carrier).currentRoute()).toBe('/orders/:id');
  });

  it('never carries a query or fragment', () => {
    const { carrier, client } = make();
    client.setRoute('/orders/42?token=abc#frag');
    expect(screenTrackerFor(carrier).currentRoute()).toBe('/orders/42');
  });

  it('ignores a route that is not a usable string (the held route stays)', () => {
    const { carrier, client } = make();
    client.setRoute('/a');
    for (const bad of ['', '?x=1', undefined, null, 5, {}]) client.setRoute(bad as never);
    expect(screenTrackerFor(carrier).currentRoute()).toBe('/a');
  });

  it('announces once per change', () => {
    const { carrier, client } = make();
    const seen: string[] = [];
    screenTrackerFor(carrier).on('route', (e) => seen.push(e.route));
    client.setRoute('/a');
    client.setRoute('/a');
    client.setRoute('/b');
    expect(seen).toEqual(['/a', '/b']);
  });

  it('is a no-op once the SDK has been killed (collector KILL_SDK), like every other capture entry point', async () => {
    const carrier = {};
    const client = createClient({
      carrier,
      appToken: 'tok',
      getEnvironment: () => ({
        platform: { type: 'web', version: '1' },
        runtime: { type: 'web', version: '' },
        sdk: { version: '0', type: 'javascript' },
      }),
      captureStore: createMemoryCaptureStore({ maxRecordingTimeMs: Number.POSITIVE_INFINITY }),
      scheduler: { setInterval: () => 'h', clearInterval: () => {} },
      onError: () => {},
      uploadPipeline: {
        enqueue: async () => ({
          ok: false,
          error: new BugseeError('off', 0, { fatal: true, serverCode: 99_099 }),
        }),
        flush: async () => true,
        drop: () => {},
      },
    });
    client.launch();
    client.setRoute('/before');
    await client.logException(new Error('boom'));
    client.setRoute('/after');
    client.setView('After');
    const t = screenTrackerFor(carrier);
    expect(t.currentRoute()).toBe('/before');
    expect(t.currentView()).toBeUndefined();
  });
});

describe('client.setRoute: errors', () => {
  it("a subscriber that throws is reported to the client's onError and does not break the call", () => {
    const errors: unknown[] = [];
    const carrier = {};
    const client = createClient({ carrier, onError: (e) => errors.push(e) });
    screenTrackerFor(carrier).on('route', () => {
      throw new Error('boom');
    });
    expect(() => client.setRoute('/x')).not.toThrow();
    expect((errors[0] as Error).message).toBe('boom');
  });
});

describe('client.setView', () => {
  it('accepts a string, an object and null', () => {
    const { carrier, client } = make();
    const t = screenTrackerFor(carrier);
    client.setView('OrderDetail');
    expect(t.currentView()).toEqual({ name: 'OrderDetail' });
    client.setView({ name: 'Cart', type: 'react' });
    expect(t.currentView()).toEqual({ name: 'Cart', type: 'react' });
    client.setView(null);
    expect(t.currentView()).toBe('$$none');
  });

  it('ignores an unusable view (the held view stays)', () => {
    const { carrier, client } = make();
    client.setView('A1');
    for (const bad of ['', '  ', {}, { name: '' }, 5, undefined]) client.setView(bad as never);
    expect(screenTrackerFor(carrier).currentView()).toEqual({ name: 'A1' });
  });

  it('is idempotent: repeating the current view announces nothing', () => {
    const { carrier, client } = make();
    const seen: unknown[] = [];
    screenTrackerFor(carrier).on('view', (e) => seen.push(e.view));
    client.setView({ name: 'A1', type: 'vue' });
    client.setView({ name: 'A1', type: 'vue' });
    client.setView(null);
    client.setView(null);
    expect(seen).toEqual([{ name: 'A1', type: 'vue' }, '$$none']);
  });

  it('clients on one carrier share the state (a relaunched client inherits it)', () => {
    const carrier = {};
    createClient({ carrier }).setView('First');
    createClient({ carrier }).setRoute('/r');
    expect(screenTrackerFor(carrier).currentView()).toEqual({ name: 'First' });
    expect(screenTrackerFor(carrier).currentRoute()).toBe('/r');
  });
});
