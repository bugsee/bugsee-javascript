import { describe, expect, it, vi } from 'vitest';
import {
  bugsee,
  clientInitScript,
  SERVER_MIDDLEWARE_ID,
  serverMiddlewareModule,
} from './integration';

interface VitePluginLike {
  name: string;
  resolveId: (id: string) => string | undefined;
  load: (id: string) => string | undefined;
}

/** Run the integration's astro:config:setup hook with spies, return what it wired. */
function runSetup(integration: ReturnType<typeof bugsee>) {
  const injectScript = vi.fn();
  const addMiddleware = vi.fn();
  const updateConfig = vi.fn();
  const setup = integration.hooks['astro:config:setup'] as unknown as (arg: {
    injectScript: typeof injectScript;
    addMiddleware: typeof addMiddleware;
    updateConfig: typeof updateConfig;
  }) => void;
  setup({ injectScript, addMiddleware, updateConfig });
  const plugin = (updateConfig.mock.calls[0]?.[0] as { vite: { plugins: VitePluginLike[] } }).vite
    .plugins[0] as VitePluginLike;
  return { injectScript, addMiddleware, updateConfig, plugin };
}

describe('bugsee() integration', () => {
  it('has the integration name', () => {
    expect(bugsee({ appToken: 'tok' }).name).toBe('@bugsee/astro');
  });

  // These two ids are not free-form labels — Vite's contract is what makes the generated middleware
  // loadable at all. A virtual module id must be a bare specifier that no file resolution can claim (hence
  // the `virtual:` convention), and Vite warns on / mishandles an unnamed plugin.
  it('follows Vite’s virtual-module + named-plugin conventions', () => {
    expect(SERVER_MIDDLEWARE_ID.startsWith('virtual:')).toBe(true);
    expect(SERVER_MIDDLEWARE_ID.length).toBeGreaterThan('virtual:'.length);
    const { plugin } = runSetup(bugsee({ appToken: 'tok' }));
    expect(plugin.name.length).toBeGreaterThan(0);
  });

  it('injects the client launch (page) + adds the generated server middleware FIRST', () => {
    const { injectScript, addMiddleware } = runSetup(bugsee({ appToken: 'tok' }));
    expect(injectScript).toHaveBeenCalledWith('page', clientInitScript('tok', {}));
    // The launch lives in the middleware (runs for EVERY route), not a page-gated page-ssr script.
    expect(injectScript).not.toHaveBeenCalledWith('page-ssr', expect.anything());
    expect(addMiddleware).toHaveBeenCalledWith({
      entrypoint: SERVER_MIDDLEWARE_ID,
      order: 'pre',
    });
  });

  it('serves the NODE server-middleware module via a vite virtual module', () => {
    const { plugin } = runSetup(bugsee({ appToken: 'tok', server: { captureNetwork: false } }));
    // resolveId maps the virtual id to the \0-prefixed resolved id; ignores others.
    const resolved = plugin.resolveId(SERVER_MIDDLEWARE_ID) as string;
    expect(resolved).toBe(`\0${SERVER_MIDDLEWARE_ID}`);
    expect(plugin.resolveId('some-other-id')).toBeUndefined();
    // load returns the generated module for the resolved id; ignores others.
    expect(plugin.load(resolved)).toBe(
      serverMiddlewareModule('tok', { captureNetwork: false }, false),
    );
    expect(plugin.load('some-other-id')).toBeUndefined();
  });

  it('serves the EDGE server-middleware module when runtime is "edge"', () => {
    const { plugin } = runSetup(bugsee({ appToken: 'tok', runtime: 'edge' }));
    expect(plugin.load(`\0${SERVER_MIDDLEWARE_ID}`)).toBe(serverMiddlewareModule('tok', {}, true));
  });

  it('forwards the client option bag into the injected client script', () => {
    const { injectScript } = runSetup(bugsee({ appToken: 'tok', client: { captureLogs: false } }));
    expect(injectScript).toHaveBeenCalledWith(
      'page',
      clientInitScript('tok', { captureLogs: false }),
    );
  });
});

describe('the generated module sources', () => {
  it('clientInitScript imports + calls registerClient with the appToken + opts', () => {
    const code = clientInitScript('tok', { captureLogs: false });
    expect(code).toContain("import { registerClient } from '@bugsee/astro/client';");
    expect(code).toContain('registerClient("tok", {"captureLogs":false});');
  });

  it('serverMiddlewareModule (node) launches registerServer + exports the node onRequest', () => {
    const code = serverMiddlewareModule('tok', { captureNetwork: false }, false);
    expect(code).toContain("import { registerServer } from '@bugsee/astro/server';");
    expect(code).toContain("import { createBugseeMiddleware } from '@bugsee/astro/middleware';");
    expect(code).toContain('registerServer("tok", {"captureNetwork":false});');
    expect(code).toContain('export const onRequest = createBugseeMiddleware();');
  });

  it('serverMiddlewareModule (edge) launches registerServerEdge + exports the edge onRequest', () => {
    const code = serverMiddlewareModule('tok', {}, true);
    expect(code).toContain(
      "import { registerServerEdge, createEdgeMiddleware } from '@bugsee/astro/edge';",
    );
    expect(code).toContain('registerServerEdge("tok", {});');
    expect(code).toContain('export const onRequest = createEdgeMiddleware();');
  });
});
