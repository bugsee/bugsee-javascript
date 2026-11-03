import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A faithful stand-in for core's carrier: `launch` records the kept options on success only (setCarrierLastLaunch), returns the live client
// for a repeat (launchCore's alreadyLaunched), and `relaunch` merges `{ ...lastLaunch.options, ...options }` on the host relaunchWith picks.
const world = vi.hoisted(() => {
  type Slot = {
    pendingLaunch?: Promise<unknown>;
    client?: unknown;
    lastLaunch?: { appToken: string; options: Record<string, unknown> };
    lastHost?: object;
  };
  const slots = new Map<object, Slot>();
  const slot = (host: object): Slot => {
    let found = slots.get(host);
    if (found === undefined) {
      found = {};
      slots.set(host, found);
    }
    return found;
  };
  const state = {
    gate: undefined as Promise<void> | undefined,
    failNext: undefined as Error | undefined,
    count: 0,
  };
  const KEPT = ['document', 'window', 'onError', 'carrier'];
  function coreLaunch(appToken: string, options: Record<string, unknown> = {}): Promise<unknown> {
    const host = (options.carrier as object | undefined) ?? globalThis;
    const existing = slot(host).client;
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    // like core, a launch in flight is visible on the carrier (getCarrierPendingLaunch) until it settles
    const run = (async () => {
      await state.gate;
      if (state.failNext !== undefined) {
        const failure = state.failNext;
        state.failNext = undefined;
        throw failure;
      }
      const client = { id: ++state.count };
      const retained: Record<string, unknown> = {};
      for (const key of KEPT) {
        if (options[key] !== undefined) {
          retained[key] = options[key];
        }
      }
      slot(host).client = client;
      slot(host).lastLaunch = { appToken, options: retained };
      slot(globalThis).lastHost = host === globalThis ? undefined : host;
      return client;
    })();
    slot(host).pendingLaunch = run;
    const clear = () => {
      if (slot(host).pendingLaunch === run) {
        slot(host).pendingLaunch = undefined;
      }
    };
    run.then(clear, clear);
    return run;
  }
  async function coreRelaunch(options?: Record<string, unknown>) {
    const host =
      (options?.carrier as object | undefined) ?? slot(globalThis).lastHost ?? globalThis;
    const last = slot(host).lastLaunch;
    if (last === undefined) {
      throw new Error('relaunch before launch');
    }
    slot(host).client = undefined;
    return await coreLaunch(last.appToken, { ...last.options, ...options });
  }
  return {
    slots,
    slot,
    state,
    launch: vi.fn(coreLaunch),
    relaunchUmbrella: vi.fn(coreRelaunch),
    coreLaunch,
    listen: vi.fn(),
    flush: vi.fn(),
    stop: vi.fn(),
    order: [] as string[],
  };
});
const { launch, relaunchUmbrella, listen, flush, stop, order } = world;
vi.mock('@bugsee/bugsee', () => ({ launch, relaunch: relaunchUmbrella }));
vi.mock('@bugsee/core', () => ({
  getCarrier: (host: object = globalThis) => world.slot(host),
  getCarrierClient: (host: object = globalThis) => world.slot(host).client,
  getCarrierPendingLaunch: (host: object = globalThis) => world.slot(host).pendingLaunch,
}));
vi.mock('./hydration', () => ({
  listenForAstroHydrationErrors: world.listen,
  flushQueuedAstroHydrationErrors: world.flush,
  stopListeningForAstroHydrationErrors: world.stop,
}));

const doc = (id: string) => ({ id }) as unknown as Document;
const lastListen = () => listen.mock.lastCall?.[0] as Record<string, unknown>;

// The client module keeps the document it last listened on, so each test gets a fresh module.
let registerClient: typeof import('./client').registerClient;
let relaunch: typeof import('./client').relaunch;

describe('registerClient', () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ registerClient, relaunch } = await import('./client'));
  });

  afterEach(() => {
    delete (globalThis as { document?: unknown }).document;
    world.slots.clear();
    world.state.gate = undefined;
    world.state.failNext = undefined;
    world.state.count = 0;
    launch.mockClear();
    relaunchUmbrella.mockClear();
    listen.mockReset();
    flush.mockReset();
    stop.mockReset();
    order.length = 0;
  });

  it('launches the browser SDK with the appToken + options, returns the client', async () => {
    const client = await registerClient('tok', { captureLogs: false });
    expect(client).toBe(world.slot(globalThis).client);
    expect(launch).toHaveBeenCalledWith('tok', { captureLogs: false });
  });

  it('defaults options to an empty object', async () => {
    await registerClient('tok');
    expect(launch).toHaveBeenCalledWith('tok', {});
  });

  it('listens BEFORE the launch (an island error during launch is queued) and flushes the queue once the client exists', async () => {
    listen.mockImplementation(() => order.push('listen'));
    launch.mockImplementationOnce(async (token, options) => {
      order.push('launch');
      return await world.coreLaunch(token, options as Record<string, unknown>);
    });
    flush.mockImplementation(() => order.push('flush'));
    await registerClient('tok');
    expect(order).toEqual(['listen', 'launch', 'flush']);
  });

  it('relaunch() is wrapped in the same window: listen first, flush in a finally (the carrier client is cleared during the restart)', async () => {
    await registerClient('tok');
    listen.mockImplementation(() => order.push('listen'));
    flush.mockImplementation(() => order.push('flush'));
    await relaunch({ replay: false } as never);
    expect(order).toEqual(['listen', 'flush']);
    expect(relaunchUmbrella).toHaveBeenCalledWith({ replay: false });
    world.state.failNext = new Error('relaunch failed');
    order.length = 0;
    await expect(relaunch()).rejects.toThrow('relaunch failed');
    expect(order).toEqual(['listen', 'flush']);
  });

  it("a fresh registration takes its document from its OWN options: an explicit one, else the bound window's", async () => {
    await registerClient('tok', { document: doc('explicit') } as never);
    expect(listen).toHaveBeenLastCalledWith({ target: doc('explicit') });
    world.slot(globalThis).client = undefined; // stopped: the next registration is a fresh launch
    const carrier = {};
    await registerClient('tok', { window: { document: doc('window') }, carrier } as never);
    expect(listen).toHaveBeenLastCalledWith({ target: doc('window'), carrier });
  });

  it('a failed launch or relaunch leaves what the next relaunch builds on untouched (core records last-launch options only on success)', async () => {
    await registerClient('tok', { document: doc('explicit') } as never);
    world.state.failNext = new Error('boom');
    await expect(relaunch({ document: doc('failed') } as never)).rejects.toThrow('boom');
    await relaunch();
    expect(listen).toHaveBeenLastCalledWith({ target: doc('explicit') });
  });

  it('an explicit undefined on a relaunch overwrites the kept value, as core spreads it', async () => {
    await registerClient('tok', { document: doc('explicit') } as never);
    await relaunch({ document: undefined, window: { document: doc('window') } } as never);
    expect(listen).toHaveBeenLastCalledWith({ target: doc('window') });
  });

  it('a sandboxed window whose document getter throws leaves the listener on its default target', async () => {
    const hostile = {
      get document(): never {
        throw new Error('sandboxed');
      },
    };
    await registerClient('tok', { window: hostile } as never);
    expect(listen).toHaveBeenLastCalledWith({});
  });

  it('a plain relaunch() keeps the earlier document, carrier and onError (core keeps them), and an explicit one wins', async () => {
    const carrier = {};
    const onError = vi.fn();
    await registerClient('tok', { document: doc('explicit'), carrier, onError } as never);
    await relaunch();
    expect(listen).toHaveBeenLastCalledWith({ target: doc('explicit'), carrier, onError });
    expect(flush).toHaveBeenLastCalledWith({ target: doc('explicit'), carrier, onError });
    await relaunch({ document: doc('other') } as never);
    expect(listen).toHaveBeenLastCalledWith({ target: doc('other'), carrier, onError });
  });

  it("a plain relaunch() after a bound WINDOW listens and flushes on that window's document (the same EventTarget as registerClient)", async () => {
    await registerClient('tok', { window: { document: doc('window') } } as never);
    await relaunch({ replay: false } as never);
    expect(listen).toHaveBeenLastCalledWith({ target: doc('window') });
    expect(flush).toHaveBeenLastCalledWith({ target: doc('window') });
  });

  it("a relaunch({ window }) after an explicit document keeps that document, because launch prefers `document` over the window's", async () => {
    await registerClient('tok', { document: doc('explicit') } as never);
    await relaunch({ window: { document: doc('window') } } as never);
    expect(listen).toHaveBeenLastCalledWith({ target: doc('explicit') });
    expect(flush).toHaveBeenLastCalledWith({ target: doc('explicit') });
    await relaunch({ document: doc('other') } as never);
    expect(listen).toHaveBeenLastCalledWith({ target: doc('other') });
  });

  it('hands a custom carrier to the hydration listener, so it looks where the client lives', async () => {
    const carrier = {};
    await registerClient('tok', { carrier } as never);
    expect(listen).toHaveBeenCalledWith({ carrier });
    expect(flush).toHaveBeenCalledWith({ carrier });
  });

  it('ends the queueing window even when the launch fails, and still rejects with the launch error', async () => {
    world.state.failNext = new Error('launch failed');
    await expect(registerClient('tok')).rejects.toThrow('launch failed');
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('always states the carrier and sink, so an explicit undefined replaces what the listener kept (core relaunches on the global carrier)', async () => {
    await registerClient('tok', { carrier: {}, onError: vi.fn() } as never);
    await relaunch({ carrier: undefined, onError: undefined } as never);
    const passed = lastListen();
    expect(Object.hasOwn(passed, 'carrier') && passed.carrier === undefined).toBe(true);
    expect(Object.hasOwn(passed, 'onError') && passed.onError === undefined).toBe(true);
  });

  it('a relaunch started while a registration is still launching waits for it and builds on its options (core awaits the pending launch)', async () => {
    let open: () => void = () => undefined;
    world.state.gate = new Promise((resolve) => (open = resolve));
    const registering = registerClient('tok', { document: doc('explicit') } as never);
    const relaunching = relaunch();
    open();
    await Promise.all([registering, relaunching]);
    expect(listen).toHaveBeenLastCalledWith({ target: doc('explicit') });
  });

  it('a relaunch still goes ahead when the launch it waited for failed', async () => {
    await registerClient('tok', { document: doc('explicit') } as never);
    world.state.failNext = new Error('nope');
    const failing = relaunch(); // the restart fails ...
    const following = relaunch(); // ... and the next one still runs, on what the last SUCCESSFUL launch recorded
    await expect(failing).rejects.toThrow('nope');
    await expect(following).resolves.toBeDefined();
    expect(listen).toHaveBeenLastCalledWith({ target: doc('explicit') });
  });

  it("only OWN option properties count, as in core's spread: an inherited document is not the launch's document", async () => {
    await registerClient('tok', { document: doc('own') } as never);
    await relaunch(Object.create({ document: doc('inherited') }) as never);
    expect(listen).toHaveBeenLastCalledWith({ target: doc('own') });
  });

  it('a repeat registration (a client is live) merges only its DEFINED options onto the listener, wherever the client was launched', async () => {
    const carrier = {};
    const sink = vi.fn();
    await registerClient('tok', { document: doc('explicit'), carrier } as never);
    // the realistic late call: only a sink (functions cannot ride the injected script); a stated undefined was discarded by core
    await registerClient('tok', { carrier, onError: sink, document: undefined } as never);
    const passed = lastListen();
    expect(passed).toEqual({ target: doc('explicit'), carrier, onError: sink });
    expect(Object.hasOwn(passed, 'document')).toBe(false);
    expect(flush).toHaveBeenLastCalledWith(passed); // settled at once: the client exists
    expect(launch).toHaveBeenLastCalledWith('tok', { carrier, onError: sink, document: undefined });
    // core recorded nothing for the repeat, so a relaunch is back on the first launch's options
    await relaunch();
    expect(listen).toHaveBeenLastCalledWith({ target: doc('explicit'), carrier });
    expect(Object.hasOwn(lastListen(), 'onError') && lastListen().onError).toBe(undefined);
  });

  it('a repeat registration with no options keeps the listener on the recorded carrier and sink (it never states undefined)', async () => {
    const carrier = {};
    const sink = vi.fn();
    await registerClient('tok', { carrier, onError: sink } as never);
    await registerClient('tok', { carrier } as never);
    expect(listen).toHaveBeenCalledTimes(2);
    expect(lastListen()).toEqual({ carrier, onError: sink });
    expect(Object.keys(lastListen()).sort()).toEqual(['carrier', 'onError']);
  });

  it('registrations overlapping a launch in flight wait for it, then see the live client (the carrier is set only at the end of a launch)', async () => {
    const carrier = {};
    const sink = vi.fn();
    let open: () => void = () => undefined;
    world.state.gate = new Promise((resolve) => (open = resolve));
    const first = registerClient('tok', { carrier, onError: sink } as never);
    const second = registerClient('tok', { carrier } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(launch).toHaveBeenCalledTimes(1); // the second has not started: it waits
    open();
    await Promise.all([first, second]);
    expect(launch).toHaveBeenCalledTimes(2);
    expect(lastListen()).toEqual({ carrier, onError: sink }); // not wiped by the second call
  });

  it('asks the carrier the launch would use: the option, else the global', async () => {
    const carrier = {};
    await registerClient('tok', { carrier } as never);
    // a client lives on `carrier` only: a registration on the global carrier is a FRESH launch (its own slot) and states undefined
    await registerClient('tok');
    expect(world.slot(globalThis).client).toBeDefined();
    expect(Object.hasOwn(lastListen(), 'carrier')).toBe(true);
    expect(lastListen().carrier).toBe(undefined);
  });

  it('passes the onError sink to the hydration listener, and a relaunch that gives none keeps it (core keeps onError)', async () => {
    const onError = vi.fn();
    await registerClient('tok', { onError });
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith({ onError });
    await relaunch();
    expect(listen).toHaveBeenLastCalledWith({ onError });
  });

  it('a relaunch builds on what CORE recorded, so a client launched through the umbrella directly is followed too', async () => {
    await world.coreLaunch('tok', { document: doc('umbrella') }); // not through registerClient
    await relaunch({ window: { document: doc('window') } } as never);
    expect(listen).toHaveBeenLastCalledWith({ target: doc('umbrella') });
    expect(flush).toHaveBeenLastCalledWith({ target: doc('umbrella') });
  });

  it('a relaunch follows the host core would pick: the carrier option, else the one the last launch remembered', async () => {
    const carrier = {};
    await registerClient('tok', { document: doc('on-carrier'), carrier } as never);
    await relaunch(); // core: slot(globalThis).lastHost === carrier
    expect(listen).toHaveBeenLastCalledWith({ target: doc('on-carrier'), carrier });
    const other = {};
    await world.coreLaunch('tok', { document: doc('on-other'), carrier: other });
    await relaunch({ carrier: other } as never); // an explicit carrier wins
    expect(lastListen().target).toEqual(doc('on-other'));
  });

  it('when the client moves to another document, the old document stops listening', async () => {
    await registerClient('tok', { document: doc('first') } as never);
    expect(stop).not.toHaveBeenCalled();
    await relaunch({ document: doc('second') } as never);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenLastCalledWith(doc('first'));
    await relaunch(); // same document again: nothing to remove
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('a failed move leaves the old listener alone (nothing moved)', async () => {
    await registerClient('tok', { document: doc('first') } as never);
    world.state.failNext = new Error('boom');
    await expect(relaunch({ document: doc('failed') } as never)).rejects.toThrow('boom');
    expect(stop).not.toHaveBeenCalledWith(doc('first'));
    // ... but the document the failed launch had started listening on is released, not leaked
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenLastCalledWith(doc('failed'));
  });

  it('a repeat registration (core ignores its document) leaves the old listener alone', async () => {
    await registerClient('tok', { document: doc('first') } as never);
    await registerClient('tok', { document: doc('repeat') } as never);
    expect(stop).not.toHaveBeenCalled();
    // core ignored that document, so nothing listens on it: the listener stays on the document the client uses
    expect(lastListen().target).toEqual(doc('first'));
    expect(
      listen.mock.calls.some(([passed]) => (passed as { target?: unknown }).target === undefined),
    ).toBe(false);
  });

  it('a launch with no document at all leaves the old listener alone (it stays on its default target)', async () => {
    await registerClient('tok', { document: doc('first') } as never);
    world.slot(globalThis).client = undefined; // stopped
    await registerClient('tok');
    expect(stop).not.toHaveBeenCalled();
  });

  it('the default page document counts as the launch document: default then explicit stops listening on it', async () => {
    const page = doc('page');
    (globalThis as { document?: unknown }).document = page;
    await registerClient('tok'); // listens on globalThis.document by default
    await relaunch({ document: doc('second') } as never);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenLastCalledWith(page);
  });

  it('explicit then default: the client is back on the page document, so the explicit one stops', async () => {
    const page = doc('page');
    (globalThis as { document?: unknown }).document = page;
    await registerClient('tok', { document: doc('first') } as never);
    world.slot(globalThis).client = undefined; // stopped
    await registerClient('tok'); // no document: the default one
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenLastCalledWith(doc('first'));
  });

  it('a failed first launch releases the listener it opened', async () => {
    world.state.failNext = new Error('boom');
    await expect(registerClient('tok', { document: doc('first') } as never)).rejects.toThrow(
      'boom',
    );
    expect(stop).toHaveBeenCalledWith(doc('first'));
  });

  it("a relaunch waits for a launch in flight that Astro did not start (core's relaunchWith awaits the carrier's pending launch)", async () => {
    let open: () => void = () => undefined;
    world.state.gate = new Promise((resolve) => (open = resolve));
    const external = world.coreLaunch('tok', { document: doc('umbrella') }); // through the umbrella, not registerClient
    const relaunching = relaunch({ window: { document: doc('window') } } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(relaunchUmbrella).not.toHaveBeenCalled(); // not started: it waits for the pending launch
    open();
    await Promise.all([external, relaunching]);
    expect(listen).toHaveBeenLastCalledWith({ target: doc('umbrella') });
  });

  it('a pending launch that fails does not stop the relaunch from going ahead', async () => {
    await registerClient('tok', { document: doc('explicit') } as never);
    world.slot(globalThis).client = undefined;
    let open: () => void = () => undefined;
    world.state.gate = new Promise((resolve) => (open = resolve));
    world.state.failNext = new Error('external failed');
    const external = world.coreLaunch('tok', {}); // pending on the carrier, and about to fail
    external.catch(() => undefined);
    const relaunching = relaunch();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(relaunchUmbrella).not.toHaveBeenCalled(); // it is waiting for the pending launch
    world.state.gate = undefined;
    open();
    await expect(relaunching).resolves.toBeDefined();
    expect(listen).toHaveBeenLastCalledWith({ target: doc('explicit') });
  });

  it('two carriers on two documents: a launch on one never stops the other (core keeps its state per carrier)', async () => {
    const a = {};
    const b = {};
    await registerClient('tok', { carrier: a, document: doc('docA') } as never);
    await registerClient('tok', { carrier: b, document: doc('docB') } as never);
    expect(stop).not.toHaveBeenCalled();
    await relaunch({ carrier: b, document: doc('docB2') } as never); // B moves; A is untouched
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenLastCalledWith(doc('docB'));
  });

  it('two carriers sharing one document: it stops only when the last of them has left it', async () => {
    const a = {};
    const b = {};
    const shared = doc('shared');
    await registerClient('tok', { carrier: a, document: shared } as never);
    await registerClient('tok', { carrier: b, document: shared } as never);
    await relaunch({ carrier: b, document: doc('elsewhere') } as never); // A is still on it
    expect(stop).not.toHaveBeenCalled();
    await relaunch({ carrier: a, document: doc('also-elsewhere') } as never); // now nobody is
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenLastCalledWith(shared);
  });

  it('a failed launch on a carrier does not release a document another carrier still uses', async () => {
    const a = {};
    const b = {};
    const shared = doc('shared');
    await registerClient('tok', { carrier: a, document: shared } as never);
    world.state.failNext = new Error('boom');
    await expect(registerClient('tok', { carrier: b, document: shared } as never)).rejects.toThrow(
      'boom',
    );
    expect(stop).not.toHaveBeenCalled();
  });

  it('a repeat that states onError undefined (core discarded it) keeps the recorded sink', async () => {
    const sink = vi.fn();
    await registerClient('tok', { onError: sink });
    await registerClient('tok', { onError: undefined });
    expect(lastListen()).toEqual({ onError: sink });
    expect(lastListen().onError).toBe(sink);
  });

  it('a failed relaunch onto the document the host is already on does not stop it', async () => {
    const same = doc('same');
    await registerClient('tok', { document: same } as never);
    world.state.failNext = new Error('boom');
    await expect(relaunch({ document: same } as never)).rejects.toThrow('boom');
    expect(stop).not.toHaveBeenCalled();
  });

  it('a repeat registration on a client Astro never launched still tracks the document it listens on, so a later move releases it', async () => {
    await world.coreLaunch('tok', { document: doc('umbrella') }); // through the umbrella, not registerClient
    await registerClient('tok'); // a repeat: listens on the recorded document
    expect(lastListen().target).toEqual(doc('umbrella'));
    await relaunch({ document: doc('moved') } as never);
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenLastCalledWith(doc('umbrella'));
  });

  it('a repeat never moves or releases what is already tracked for its host', async () => {
    await registerClient('tok', { document: doc('first') } as never);
    await registerClient('tok', { onError: vi.fn() });
    await relaunch(); // still the first document: nothing stops
    expect(stop).not.toHaveBeenCalled();
  });

  it('a repeat after the umbrella moved the client to another document releases the one Astro knew', async () => {
    await registerClient('tok', { document: doc('first') } as never);
    world.slot(globalThis).lastLaunch = {
      appToken: 'tok',
      options: { document: doc('moved-by-umbrella') },
    };
    await registerClient('tok'); // a repeat: the live client is now recorded on another document
    expect(lastListen().target).toEqual(doc('moved-by-umbrella'));
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenLastCalledWith(doc('first'));
  });
});
