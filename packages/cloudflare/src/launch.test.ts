import * as edge from '@bugsee/vercel-edge';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { launch } from './launch';

// The Cloudflare launch is a thin wrapper over @bugsee/vercel-edge's launchEdge — spy on launchEdge and assert
// the delegation contract (platformType default 'workers' + option threading + return). The full edge behavior
// (capture → bundle → upload, platformType reaching the environment) is covered in @bugsee/vercel-edge.
afterEach(() => vi.restoreAllMocks());

describe('launch (Cloudflare)', () => {
  it('delegates to launchEdge with platformType "workers" by default', () => {
    const spy = vi.spyOn(edge, 'launchEdge').mockReturnValue({} as edge.Bugsee);
    launch('tok');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith('tok', expect.objectContaining({ platformType: 'workers' }));
  });

  it('threads the caller options through to launchEdge', () => {
    const spy = vi.spyOn(edge, 'launchEdge').mockReturnValue({} as edge.Bugsee);
    launch('tok', { appId: 'com.acme.worker', captureNetwork: false });
    expect(spy).toHaveBeenCalledWith(
      'tok',
      expect.objectContaining({
        platformType: 'workers',
        appId: 'com.acme.worker',
        captureNetwork: false,
      }),
    );
  });

  it('lets a caller override platformType (the workers default spreads BEFORE the options)', () => {
    const spy = vi.spyOn(edge, 'launchEdge').mockReturnValue({} as edge.Bugsee);
    launch('tok', { platformType: 'edge-light' });
    expect(spy).toHaveBeenCalledWith(
      'tok',
      expect.objectContaining({ platformType: 'edge-light' }),
    );
  });

  it('returns the client that launchEdge returns', () => {
    const fake = { stop: () => Promise.resolve(true) } as unknown as edge.Bugsee;
    vi.spyOn(edge, 'launchEdge').mockReturnValue(fake);
    expect(launch('tok')).toBe(fake);
  });
});

// S0 (docs/design/cloudflare-tenant-isolation.md §7): AsyncLocalStorage is wired AUTOMATICALLY.
//
// `globalThis.AsyncLocalStorage` does not exist on workerd under any compatibility flag — ALS is reachable
// only via `node:async_hooks` (verified on real workerd; docs/review/cloudflare.md SEV1 #3). Without this,
// per-request context silently degrades to a single slot, `contextId`/`owner` are never stamped, and the
// Durable Object tenant fix (S1-S5) is inert. The user must write NO code for this.
describe('launch (Cloudflare) — automatic AsyncLocalStorage', () => {
  it('supplies a run()-scoped store by default, without the caller passing one', () => {
    const spy = vi.spyOn(edge, 'launchEdge').mockReturnValue({} as edge.Bugsee);
    launch('tok');
    const options = spy.mock.calls[0]?.[1] as { asyncLocalStorage?: unknown } | undefined;
    const als = options?.asyncLocalStorage as
      | { run: (s: unknown, fn: () => unknown) => unknown; getStore: () => unknown }
      | undefined;
    expect(als).toBeDefined();
    // Not merely present — it must actually behave as a run()-scoped store.
    expect(typeof als?.run).toBe('function');
    expect(typeof als?.getStore).toBe('function');
    const marker = { contextId: 'c-s0' };
    const inside = als?.run(marker, () => als?.getStore());
    expect(inside).toBe(marker);
    expect(als?.getStore()).toBeUndefined(); // scoped: nothing leaks outside run()
  });

  it('propagates context across an await — the property the single-slot fallback cannot provide', async () => {
    const spy = vi.spyOn(edge, 'launchEdge').mockReturnValue({} as edge.Bugsee);
    launch('tok');
    const als = (
      spy.mock.calls[0]?.[1] as {
        asyncLocalStorage: {
          run: <R>(s: unknown, fn: () => R) => R;
          getStore: () => unknown;
        };
      }
    ).asyncLocalStorage;
    const marker = { contextId: 'c-async' };
    const seen = await als.run(marker, async () => {
      await Promise.resolve();
      return als.getStore();
    });
    expect(seen).toBe(marker);
  });

  it('lets an explicit caller-supplied store win over the automatic one', () => {
    const spy = vi.spyOn(edge, 'launchEdge').mockReturnValue({} as edge.Bugsee);
    const mine = { run: <R>(_s: unknown, fn: () => R): R => fn(), getStore: () => undefined };
    launch('tok', { asyncLocalStorage: mine });
    const options = spy.mock.calls[0]?.[1] as { asyncLocalStorage?: unknown };
    expect(options.asyncLocalStorage).toBe(mine);
  });
});
