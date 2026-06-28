import * as edge from '@bugsee/vercel-edge';
import { describe, expect, it } from 'vitest';
import * as cf from './index';
import { launch as cloudflareLaunch } from './launch';

describe('@bugsee/cloudflare index', () => {
  it('re-exports the full edge composition surface', () => {
    expect(typeof cf.withBugseeFetch).toBe('function');
    expect(typeof cf.buildEdgeEnvironment).toBe('function');
    expect(typeof cf.launchEdge).toBe('function');
    expect(typeof cf.createEdgeRequestContextStore).toBe('function');
    expect(typeof cf.resolveWaitUntil).toBe('function');
    expect(typeof cf.createEdgeUnhandledRejectionProvider).toBe('function');
    expect(cf.EdgeContextStoreToken).toBeDefined();
  });

  it('exposes the Cloudflare workers launch, SHADOWING the re-exported edge-light one', () => {
    expect(cf.launch).toBe(cloudflareLaunch); // the explicit `export { launch }` wins over `export *`
    expect(cf.launch).not.toBe(edge.launch); // ...and is NOT vercel-edge's edge-light launch (= launchEdge)
  });
});
