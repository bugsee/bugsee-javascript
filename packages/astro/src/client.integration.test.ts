import { getCarrier, getCarrierClient, setCarrierClient, setCarrierLastLaunch } from '@bugsee/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The REAL hydration listeners (on real EventTargets) and the REAL core carrier; only the umbrella's launch/relaunch are stubbed, and they
// record on the real carrier the way core does. This is what the unit tests (mocked listen/stop) cannot see: which documents really
// still have a listener, and where an error really goes.
type Opts = Record<string, unknown> & { carrier?: object };
const state = {
  failNext: undefined as Error | undefined,
  gate: undefined as Promise<void> | undefined,
};
const clients: Array<{ logException: ReturnType<typeof vi.fn> }> = [];

vi.mock('@bugsee/bugsee', () => {
  const launch = async (appToken: string, options: Opts = {}) => {
    const host = options.carrier ?? globalThis;
    const existing = getCarrierClient(host);
    if (existing !== undefined) {
      return existing;
    }
    await state.gate;
    if (state.failNext !== undefined) {
      const failure = state.failNext;
      state.failNext = undefined;
      throw failure;
    }
    const client = { logException: vi.fn(() => Promise.resolve(undefined)) };
    clients.push(client);
    setCarrierClient(client, host);
    setCarrierLastLaunch(appToken, options, host);
    getCarrier().lastHost = host === globalThis ? undefined : host;
    return client;
  };
  const relaunch = async (options?: Opts) => {
    const host = options?.carrier ?? getCarrier().lastHost ?? globalThis;
    const last = getCarrier(host).lastLaunch;
    if (last === undefined) {
      throw new Error('relaunch before launch');
    }
    getCarrier(host).client = undefined; // relaunchWith stops the running client first
    return await launch(last.appToken, { ...(last.options as Opts), ...options });
  };
  return { launch, relaunch };
});

const hydrationError = (error: unknown): Event =>
  new CustomEvent('astro:hydration-error', { detail: { error }, bubbles: true });
const page = (): EventTarget => new EventTarget();

let registerClient: typeof import('./client').registerClient;
let relaunch: typeof import('./client').relaunch;

describe('hydration listeners against the real registry', () => {
  beforeEach(async () => {
    vi.resetModules();
    ({ registerClient, relaunch } = await import('./client'));
  });
  afterEach(() => {
    const carrier = getCarrier();
    carrier.client = undefined;
    carrier.lastLaunch = undefined;
    carrier.lastHost = undefined;
    delete (globalThis as { document?: unknown }).document;
    clients.length = 0;
    state.failNext = undefined;
    state.gate = undefined;
  });

  const reported = (client: { logException: ReturnType<typeof vi.fn> }, error: unknown) =>
    client.logException.mock.calls.some(([thrown]) => thrown === error);

  it('a failed move releases the destination: its errors are not reported into the recovered session', async () => {
    const a = page();
    const b = page();
    const first = await registerClient('tok', { document: a } as never);
    state.failNext = new Error('launch failed');
    await expect(relaunch({ document: b } as never)).rejects.toThrow('launch failed');
    const recovered = (await relaunch()) as unknown as (typeof clients)[number]; // back on `a`, from core's record
    const lateB = new Error('b');
    b.dispatchEvent(hydrationError(lateB));
    expect(reported(recovered, lateB)).toBe(false);
    const onA = new Error('a');
    a.dispatchEvent(hydrationError(onA));
    expect(reported(recovered, onA)).toBe(true);
    expect(reported(first as never, onA)).toBe(false); // the first client is gone: one report, to the live one
  });

  it('the default page document is released when the client moves to an explicit one', async () => {
    const pageDocument = page();
    (globalThis as { document?: unknown }).document = pageDocument;
    await registerClient('tok');
    const moved = page();
    const client = (await relaunch({
      document: moved,
    } as never)) as unknown as (typeof clients)[number];
    const onPage = new Error('page');
    pageDocument.dispatchEvent(hydrationError(onPage));
    expect(reported(client, onPage)).toBe(false);
    const onMoved = new Error('moved');
    moved.dispatchEvent(hydrationError(onMoved));
    expect(reported(client, onMoved)).toBe(true);
  });

  it('two carriers on two documents each keep reporting; one moving does not silence the other', async () => {
    const carrierA = {};
    const carrierB = {};
    const docA = page();
    const docB = page();
    const clientA = (await registerClient('tok', {
      carrier: carrierA,
      document: docA,
    } as never)) as never as (typeof clients)[number];
    await registerClient('tok', {
      carrier: carrierB,
      document: docB,
    } as never);
    const movedB = page();
    await relaunch({ carrier: carrierB, document: movedB } as never);
    const onA = new Error('a');
    docA.dispatchEvent(hydrationError(onA));
    expect(reported(clientA, onA)).toBe(true);
    const onOldB = new Error('old b');
    docB.dispatchEvent(hydrationError(onOldB));
    expect(clients.some((client) => reported(client, onOldB))).toBe(false); // B left docB: no client gets its errors
    const onNewB = new Error('new b');
    movedB.dispatchEvent(hydrationError(onNewB));
    expect(clients.some((client) => reported(client, onNewB))).toBe(true);
  });

  it('a repeat for a client the umbrella launched is tracked, so moving it releases the document', async () => {
    const umbrellaDoc = page();
    const { launch } = await import('@bugsee/bugsee');
    await launch('tok', { document: umbrellaDoc } as never);
    await registerClient('tok'); // a repeat: attaches on the recorded document
    const moved = page();
    const client = (await relaunch({
      document: moved,
    } as never)) as unknown as (typeof clients)[number];
    const stale = new Error('stale');
    umbrellaDoc.dispatchEvent(hydrationError(stale));
    expect(reported(client, stale)).toBe(false);
  });

  it("a launch that fails on a document another carrier's client listens on leaves that client reporting", async () => {
    const carrierA = {};
    const carrierB = {};
    const shared = page();
    const sinkA = vi.fn();
    const clientA = (await registerClient('tok', {
      carrier: carrierA,
      document: shared,
      onError: sinkA,
    } as never)) as never as (typeof clients)[number];
    state.failNext = new Error('B failed');
    await expect(
      registerClient('tok', { carrier: carrierB, document: shared } as never),
    ).rejects.toThrow('B failed');
    const error = new Error('island');
    shared.dispatchEvent(hydrationError(error));
    expect(reported(clientA, error)).toBe(true); // not dropped: the listener still looks on A's carrier
  });

  it('after relaunch({ carrier: undefined }) a later move releases the document the client left', async () => {
    const custom = {};
    const docA = page();
    await registerClient('tok', { carrier: custom, document: docA } as never);
    await relaunch({ carrier: undefined } as never); // now on globalThis
    const docB = page();
    const client = (await relaunch({
      document: docB,
    } as never)) as unknown as (typeof clients)[number];
    const stale = new Error('stale');
    docA.dispatchEvent(hydrationError(stale));
    expect(reported(client, stale)).toBe(false);
    const fresh = new Error('fresh');
    docB.dispatchEvent(hydrationError(fresh));
    expect(reported(client, fresh)).toBe(true);
  });

  it("a relaunch of the host that owns a shared document's listener still queues errors during the restart", async () => {
    const carrierA = {};
    const carrierB = {};
    const shared = page();
    await registerClient('tok', { carrier: carrierB, document: shared } as never);
    await registerClient('tok', { carrier: carrierA, document: shared } as never); // A merged last: the listener routes to A
    let open: () => void = () => undefined;
    state.gate = new Promise((resolve) => (open = resolve));
    const relaunching = relaunch({ carrier: carrierA } as never); // A is stopped; its new client is not up yet
    await new Promise((resolve) => setTimeout(resolve, 0));
    const during = new Error('island, mid-restart');
    shared.dispatchEvent(hydrationError(during));
    state.gate = undefined;
    open();
    const restarted = (await relaunching) as unknown as (typeof clients)[number];
    expect(reported(restarted, during)).toBe(true); // queued, then reported to the new client: not dropped
  });
});
