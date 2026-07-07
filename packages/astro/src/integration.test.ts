import { describe, expect, it, vi } from 'vitest';
import { bugsee, clientInitScript, edgeServerInitScript, serverInitScript } from './integration';

/** Run the integration's astro:config:setup hook with spies, return what it injected/added. */
function runSetup(integration: ReturnType<typeof bugsee>) {
  const injectScript = vi.fn();
  const addMiddleware = vi.fn();
  const setup = integration.hooks['astro:config:setup'] as unknown as (arg: {
    injectScript: typeof injectScript;
    addMiddleware: typeof addMiddleware;
  }) => void;
  setup({ injectScript, addMiddleware });
  return { injectScript, addMiddleware };
}

describe('bugsee() integration', () => {
  it('has the integration name', () => {
    expect(bugsee({ appToken: 'tok' }).name).toBe('@bugsee/astro');
  });

  it('injects the client launch (page) + node server launch (page-ssr) + adds the node middleware', () => {
    const { injectScript, addMiddleware } = runSetup(bugsee({ appToken: 'tok' }));

    expect(injectScript).toHaveBeenCalledWith('page', clientInitScript('tok', {}));
    expect(injectScript).toHaveBeenCalledWith('page-ssr', serverInitScript('tok', {}));
    expect(addMiddleware).toHaveBeenCalledWith({
      entrypoint: '@bugsee/astro/middleware',
      order: 'pre',
    });
  });

  it('forwards the client + server option bags into the injected scripts', () => {
    const { injectScript } = runSetup(
      bugsee({
        appToken: 'tok',
        client: { captureLogs: false },
        server: { captureNetwork: false },
      }),
    );
    expect(injectScript).toHaveBeenCalledWith(
      'page',
      clientInitScript('tok', { captureLogs: false }),
    );
    expect(injectScript).toHaveBeenCalledWith(
      'page-ssr',
      serverInitScript('tok', { captureNetwork: false }),
    );
  });

  it('wires the EDGE server launch + edge middleware when runtime is "edge"', () => {
    const { injectScript, addMiddleware } = runSetup(bugsee({ appToken: 'tok', runtime: 'edge' }));

    expect(injectScript).toHaveBeenCalledWith('page-ssr', edgeServerInitScript('tok', {}));
    expect(injectScript).not.toHaveBeenCalledWith('page-ssr', serverInitScript('tok', {}));
    expect(addMiddleware).toHaveBeenCalledWith({ entrypoint: '@bugsee/astro/edge', order: 'pre' });
  });
});

describe('the injected script generators', () => {
  it('clientInitScript imports + calls registerClient with the appToken + opts', () => {
    const code = clientInitScript('tok', { captureLogs: false });
    expect(code).toContain("import { registerClient } from '@bugsee/astro/client';");
    expect(code).toContain('registerClient("tok", {"captureLogs":false});');
  });

  it('serverInitScript imports + calls registerServer', () => {
    expect(serverInitScript('tok', {})).toContain(
      "import { registerServer } from '@bugsee/astro/server';",
    );
    expect(serverInitScript('tok', {})).toContain('registerServer("tok", {});');
  });

  it('edgeServerInitScript imports + calls registerServerEdge', () => {
    expect(edgeServerInitScript('tok', {})).toContain(
      "import { registerServerEdge } from '@bugsee/astro/edge';",
    );
    expect(edgeServerInitScript('tok', {})).toContain('registerServerEdge("tok", {});');
  });
});
