import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { launch, relaunchUmbrella, listen, flush, order, liveClient } = vi.hoisted(() => ({
  liveClient: vi.fn(),
  launch: vi.fn(),
  relaunchUmbrella: vi.fn(),
  listen: vi.fn(),
  flush: vi.fn(),
  order: [] as string[],
}));
vi.mock('@bugsee/bugsee', () => ({ launch, relaunch: relaunchUmbrella }));
vi.mock('@bugsee/core', () => ({ getCarrierClient: liveClient }));
vi.mock('./hydration', () => ({
  listenForAstroHydrationErrors: listen,
  flushQueuedAstroHydrationErrors: flush,
}));

// The client module remembers the last registration's hydration options (like core's relaunch keeps them), so each test gets a fresh one.
let registerClient: typeof import('./client').registerClient;
let relaunch: typeof import('./client').relaunch;

describe('registerClient', () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ registerClient, relaunch } = await import('./client'));
  });

  afterEach(() => {
    launch.mockReset();
    relaunchUmbrella.mockReset();
    listen.mockReset();
    flush.mockReset();
    liveClient.mockReset();
    order.length = 0;
  });

  it('launches the browser SDK with the appToken + options, returns the client', async () => {
    const client = { id: 'browser' };
    launch.mockReturnValue(client);
    await expect(registerClient('tok', { captureLogs: false })).resolves.toBe(client);
    expect(launch).toHaveBeenCalledWith('tok', { captureLogs: false });
  });

  it('defaults options to an empty object', async () => {
    await registerClient('tok');
    expect(launch).toHaveBeenCalledWith('tok', {});
  });

  it('listens BEFORE the launch (an island error during launch is queued) and flushes the queue once the client exists', async () => {
    listen.mockImplementation(() => order.push('listen'));
    launch.mockImplementation(async () => {
      order.push('launch');
      return {};
    });
    flush.mockImplementation(() => order.push('flush'));
    await registerClient('tok');
    expect(order).toEqual(['listen', 'launch', 'flush']);
  });

  it('relaunch() is wrapped in the same window: listen first, flush in a finally (the carrier client is cleared during the restart)', async () => {
    listen.mockImplementation(() => order.push('listen'));
    relaunchUmbrella.mockImplementation(async () => {
      order.push('relaunch');
      return {};
    });
    flush.mockImplementation(() => order.push('flush'));
    await relaunch({ replay: false });
    expect(order).toEqual(['listen', 'relaunch', 'flush']);
    expect(relaunchUmbrella).toHaveBeenCalledWith({ replay: false });
    relaunchUmbrella.mockRejectedValue(new Error('relaunch failed'));
    order.length = 0;
    await expect(relaunch()).rejects.toThrow('relaunch failed');
    expect(order).toEqual(['listen', 'flush']);
  });

  it("a fresh registration takes its document from its OWN options: an explicit one, else the bound window's", async () => {
    const doc = { id: 'explicit' } as unknown as Document;
    const windowDoc = { id: 'window' } as unknown as Document;
    launch.mockResolvedValueOnce({ id: 1 });
    await registerClient('tok', { document: doc } as never);
    expect(listen).toHaveBeenLastCalledWith({ target: doc });
    // a client that was stopped (or never came up) gives a NEW client: core launches afresh with only these options, so the old document,
    // carrier and sink are not carried into it
    const carrier = {};
    launch.mockResolvedValueOnce({ id: 2 });
    await registerClient('tok', { window: { document: windowDoc }, carrier } as never);
    expect(listen).toHaveBeenLastCalledWith({ target: windowDoc, carrier });
  });

  it('a failed launch or relaunch does not become the remembered state (core records last-launch options only on success)', async () => {
    const doc = { id: 'explicit' } as unknown as Document;
    launch.mockResolvedValueOnce({ id: 1 });
    relaunchUmbrella.mockRejectedValueOnce(new Error('boom'));
    relaunchUmbrella.mockResolvedValue({ id: 2 });
    await registerClient('tok', { document: doc } as never);
    await expect(relaunch({ document: { id: 'failed' } } as never)).rejects.toThrow('boom');
    await relaunch();
    expect(listen).toHaveBeenLastCalledWith({ target: doc });
    launch.mockRejectedValueOnce(new Error('nope'));
    await expect(registerClient('tok', { document: { id: 'failed2' } } as never)).rejects.toThrow(
      'nope',
    );
    await relaunch();
    expect(listen).toHaveBeenLastCalledWith({ target: doc });
  });

  it('an explicit undefined on a relaunch overwrites the kept value, as core spreads it', async () => {
    const windowDoc = { id: 'window' } as unknown as Document;
    launch.mockResolvedValue({ id: 1 });
    relaunchUmbrella.mockResolvedValue({ id: 2 });
    await registerClient('tok', { document: { id: 'explicit' } } as never);
    await relaunch({ document: undefined, window: { document: windowDoc } } as never);
    expect(listen).toHaveBeenLastCalledWith({ target: windowDoc });
  });

  it('a sandboxed window whose document getter throws leaves the listener on its default target', async () => {
    launch.mockResolvedValue({});
    const hostile = {
      get document(): never {
        throw new Error('sandboxed');
      },
    };
    await registerClient('tok', { window: hostile } as never);
    expect(listen).toHaveBeenLastCalledWith({});
  });

  it('a plain relaunch() keeps the earlier document, carrier and onError (core keeps them), and an explicit one wins', async () => {
    const doc = { id: 'explicit' } as unknown as Document;
    const carrier = {};
    const onError = vi.fn();
    launch.mockResolvedValue({});
    relaunchUmbrella.mockResolvedValue({});
    await registerClient('tok', { document: doc, carrier, onError } as never);
    await relaunch();
    expect(listen).toHaveBeenLastCalledWith({ target: doc, carrier, onError });
    expect(flush).toHaveBeenLastCalledWith({ target: doc, carrier, onError });
    const other = { id: 'other' } as unknown as Document;
    await relaunch({ document: other } as never);
    expect(listen).toHaveBeenLastCalledWith({ target: other, carrier, onError });
  });

  it("a plain relaunch() after a bound WINDOW listens and flushes on that window's document (the same EventTarget as registerClient)", async () => {
    const windowDoc = {} as Document;
    launch.mockResolvedValue({});
    relaunchUmbrella.mockResolvedValue({});
    await registerClient('tok', { window: { document: windowDoc } } as never);
    await relaunch({ replay: false });
    expect(listen).toHaveBeenLastCalledWith({ target: windowDoc });
    expect(flush).toHaveBeenLastCalledWith({ target: windowDoc });
  });

  it("a relaunch({ window }) after an explicit document keeps that document, because launch prefers `document` over the window's", async () => {
    const doc = { id: 'explicit' } as unknown as Document;
    const windowDoc = { id: 'window' } as unknown as Document;
    launch.mockResolvedValue({});
    relaunchUmbrella.mockResolvedValue({});
    await registerClient('tok', { document: doc } as never);
    await relaunch({ window: { document: windowDoc } } as never);
    expect(listen).toHaveBeenLastCalledWith({ target: doc });
    expect(flush).toHaveBeenLastCalledWith({ target: doc });
    // and an explicit document on the relaunch still wins over the kept one
    const other = { id: 'other' } as unknown as Document;
    await relaunch({ document: other } as never);
    expect(listen).toHaveBeenLastCalledWith({ target: other });
  });

  it('hands a custom carrier to the hydration listener, so it looks where the client lives', async () => {
    const carrier = {};
    launch.mockResolvedValue({});
    await registerClient('tok', { carrier } as never);
    expect(listen).toHaveBeenCalledWith({ carrier });
    expect(flush).toHaveBeenCalledWith({ carrier });
  });

  it('ends the queueing window even when the launch fails, and still rejects with the launch error', async () => {
    const failure = new Error('launch failed');
    launch.mockRejectedValue(failure);
    await expect(registerClient('tok')).rejects.toBe(failure);
    expect(flush).toHaveBeenCalledTimes(1);
  });

  it('always states the carrier and sink, so an explicit undefined replaces what the listener kept (core relaunches on the global carrier)', async () => {
    launch.mockResolvedValue({ id: 1 });
    relaunchUmbrella.mockResolvedValue({ id: 2 });
    await registerClient('tok', { carrier: {}, onError: vi.fn() } as never);
    await relaunch({ carrier: undefined, onError: undefined } as never);
    const passed = listen.mock.lastCall?.[0] as Record<string, unknown>;
    expect(Object.hasOwn(passed, 'carrier') && passed.carrier === undefined).toBe(true);
    expect(Object.hasOwn(passed, 'onError') && passed.onError === undefined).toBe(true);
  });

  it('a relaunch started while a registration is still launching waits for it and builds on its options (core awaits the pending launch)', async () => {
    const doc = { id: 'explicit' } as unknown as Document;
    let finish: (client: unknown) => void = () => undefined;
    launch.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    relaunchUmbrella.mockResolvedValue({ id: 2 });
    const registering = registerClient('tok', { document: doc } as never);
    const relaunching = relaunch();
    finish({ id: 1 });
    await Promise.all([registering, relaunching]);
    expect(listen).toHaveBeenLastCalledWith({ target: doc });
    await relaunch();
    expect(listen).toHaveBeenLastCalledWith({ target: doc });
  });

  it('a relaunch still goes ahead when the launch it waited for failed', async () => {
    launch.mockRejectedValue(new Error('nope'));
    relaunchUmbrella.mockResolvedValue({ id: 2 });
    const registering = registerClient('tok');
    const relaunching = relaunch();
    await expect(registering).rejects.toThrow('nope');
    await expect(relaunching).resolves.toEqual({ id: 2 });
  });

  it("only OWN option properties count, as in core's spread: an inherited document is not the launch's document", async () => {
    const own = { id: 'own' } as unknown as Document;
    const inherited = { id: 'inherited' } as unknown as Document;
    launch.mockResolvedValue({ id: 1 });
    relaunchUmbrella.mockResolvedValue({ id: 2 });
    await registerClient('tok', { document: own } as never);
    await relaunch(Object.create({ document: inherited }) as never);
    expect(listen).toHaveBeenLastCalledWith({ target: own });
  });

  it('a repeat registration (a client is live) merges only its DEFINED options onto the listener and remembers nothing, wherever the client was launched', async () => {
    const doc = { id: 'explicit' } as unknown as Document;
    const carrier = {};
    const sink = vi.fn();
    const live = { id: 'live' };
    launch.mockResolvedValueOnce(live);
    relaunchUmbrella.mockResolvedValue({ id: 2 });
    await registerClient('tok', { document: doc, carrier } as never);
    liveClient.mockImplementation((host: unknown) => (host === carrier ? live : undefined));
    launch.mockResolvedValueOnce(live);
    // the realistic late call: only a sink (functions cannot ride the injected script), a stated undefined is core-discarded
    await registerClient('tok', { carrier, onError: sink, document: undefined } as never);
    const passed = listen.mock.lastCall?.[0] as Record<string, unknown>;
    expect(passed).toEqual({ target: doc, carrier, onError: sink });
    expect(Object.hasOwn(passed, 'document')).toBe(false);
    expect(flush).toHaveBeenLastCalledWith(passed); // the listen is settled at once: the client exists
    expect(launch).toHaveBeenLastCalledWith('tok', { carrier, onError: sink, document: undefined });
    // nothing was remembered from the repeat: a plain relaunch is back on the first launch's options
    await relaunch();
    expect(listen).toHaveBeenLastCalledWith({ target: doc, carrier });
    expect(
      Object.hasOwn(listen.mock.lastCall?.[0] as object, 'onError') &&
        (listen.mock.lastCall?.[0] as { onError?: unknown }).onError,
    ).toBe(undefined);
  });

  it('a repeat registration with no options keeps the listener on the remembered carrier and sink (it never states undefined)', async () => {
    const carrier = {};
    const sink = vi.fn();
    const live = { id: 'live' };
    launch.mockResolvedValue(live);
    await registerClient('tok', { carrier, onError: sink } as never);
    liveClient.mockReturnValue(live);
    await registerClient('tok', { carrier } as never);
    expect(listen).toHaveBeenCalledTimes(2);
    const passed = listen.mock.lastCall?.[0] as Record<string, unknown>;
    expect(passed).toEqual({ carrier, onError: sink });
    expect(Object.keys(passed).sort()).toEqual(['carrier', 'onError']);
  });

  it('registrations overlapping a launch in flight wait for it, then see the live client (the carrier is set only at the end of a launch)', async () => {
    const carrier = {};
    const sink = vi.fn();
    const live = { id: 'live' };
    let finish: (client: unknown) => void = () => undefined;
    launch.mockReturnValueOnce(new Promise((resolve) => (finish = resolve)));
    launch.mockResolvedValueOnce(live);
    const first = registerClient('tok', { carrier, onError: sink } as never);
    const second = registerClient('tok', { carrier } as never);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(launch).toHaveBeenCalledTimes(1); // the second has not started: it waits
    liveClient.mockReturnValue(live); // the first launch ends: the carrier now holds the client
    finish(live);
    await Promise.all([first, second]);
    expect(launch).toHaveBeenCalledTimes(2);
    const passed = listen.mock.lastCall?.[0] as Record<string, unknown>;
    expect(passed).toEqual({ carrier, onError: sink }); // not wiped by the second call
  });

  it('asks the carrier the launch would use: the option, else the global', async () => {
    const carrier = {};
    launch.mockResolvedValue({ id: 1 });
    await registerClient('tok', { carrier } as never);
    expect(liveClient).toHaveBeenLastCalledWith(carrier);
    await registerClient('tok');
    expect(liveClient).toHaveBeenLastCalledWith(globalThis);
  });

  it('passes the onError sink to the hydration listener, and a relaunch that gives none keeps it (core keeps onError)', async () => {
    const onError = vi.fn();
    launch.mockResolvedValue({ id: 1 });
    relaunchUmbrella.mockResolvedValue({ id: 2 });
    await registerClient('tok', { onError });
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith({ onError });
    await relaunch();
    expect(listen).toHaveBeenLastCalledWith({ onError });
  });
});
