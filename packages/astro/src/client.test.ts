import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { launch, relaunchUmbrella, listen, flush, order } = vi.hoisted(() => ({
  launch: vi.fn(),
  relaunchUmbrella: vi.fn(),
  listen: vi.fn(),
  flush: vi.fn(),
  order: [] as string[],
}));
vi.mock('@bugsee/bugsee', () => ({ launch, relaunch: relaunchUmbrella }));
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

  it("hands the page document the launch uses (an explicit one, else the bound window's) to the hydration listener as its target", async () => {
    launch.mockResolvedValue({});
    const doc = {} as Document;
    await registerClient('tok', { document: doc } as never);
    expect(listen).toHaveBeenLastCalledWith({ target: doc });
    const windowDoc = {} as Document;
    await registerClient('tok', { window: { document: windowDoc } } as never);
    expect(listen).toHaveBeenLastCalledWith({ target: windowDoc });
    const hostile = {
      get document(): never {
        throw new Error('sandboxed');
      },
    };
    await registerClient('tok', { window: hostile } as never);
    // nothing selectable this time: the earlier registration's document is KEPT (core's relaunch keeps `document` and `window` too)
    expect(listen).toHaveBeenLastCalledWith({ target: windowDoc });
  });

  it('a plain relaunch() keeps the earlier document, carrier and onError (core keeps them), and an explicit one wins', async () => {
    const doc = {} as Document;
    const carrier = {};
    const onError = vi.fn();
    launch.mockResolvedValue({});
    relaunchUmbrella.mockResolvedValue({});
    await registerClient('tok', { document: doc, carrier, onError } as never);
    await relaunch();
    expect(listen).toHaveBeenLastCalledWith({ target: doc, carrier, onError });
    expect(flush).toHaveBeenLastCalledWith({ target: doc, carrier, onError });
    const other = {} as Document;
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

  it('passes the onError sink to the hydration listener, and keeps it for a later call that gives none (core keeps onError)', async () => {
    const onError = vi.fn();
    await registerClient('tok', { onError });
    expect(listen).toHaveBeenCalledTimes(1);
    expect(listen).toHaveBeenCalledWith({ onError });
    await registerClient('tok');
    expect(listen).toHaveBeenLastCalledWith({ onError });
  });
});
