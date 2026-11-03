import { getCarrier, getCarrierClient, setCarrierClient, setCarrierLastLaunch } from '@bugsee/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The REAL hydration listeners (on real EventTargets) and the REAL core carrier; only the umbrella's launch/relaunch are stubbed, and they
// record on the real carrier the way core does. This is what the unit tests (mocked listen/stop) cannot see: which documents really
// still have a listener, and where an error really goes.
type Opts = Record<string, unknown> & { carrier?: object };
const state = { failNext: undefined as Error | undefined };
const clients: Array<{ logException: ReturnType<typeof vi.fn> }> = [];

vi.mock('@bugsee/bugsee', () => {
  const launch = async (appToken: string, options: Opts = {}) => {
    const host = options.carrier ?? globalThis;
    const existing = getCarrierClient(host);
    if (existing !== undefined) {
      return existing;
    }
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
});
