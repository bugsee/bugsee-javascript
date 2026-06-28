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
