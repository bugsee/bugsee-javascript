// @bugsee/astro — the Astro Integration (`bugsee()`), the package `.` entry. Users add it to
// `astro.config.mjs`: `integrations: [bugsee({ appToken })]`. At `astro:config:setup` it wires the three
// seams: a browser launch (`injectScript('page')`), a server launch (`injectScript('page-ssr')`), and the
// request middleware (`addMiddleware({ entrypoint, order: 'pre' })` — error capture + trace). The `runtime`
// option selects the node vs edge server SDK + middleware.
//
// BUILD-TIME only: imports `astro` TYPES only + generates the injected scripts as strings — the actual
// runtimes load through `@bugsee/astro/{client,server,edge}` (in the right build context), never eagerly here.
import type { AstroIntegration } from 'astro';

export interface BugseeAstroOptions {
  /** The Bugsee app token. */
  appToken: string;
  /** Extra browser (client) launch options. */
  client?: Record<string, unknown>;
  /** Extra server launch options. */
  server?: Record<string, unknown>;
  /** Server runtime: `'node'` (default, `@astrojs/node`) or `'edge'` (`@astrojs/vercel`/`cloudflare`). */
  runtime?: 'node' | 'edge';
}

/** The `injectScript('page', …)` source: launch the browser SDK on the client. */
export function clientInitScript(appToken: string, options: Record<string, unknown>): string {
  return `import { registerClient } from '@bugsee/astro/client';\nregisterClient(${JSON.stringify(appToken)}, ${JSON.stringify(options)});\n`;
}

/** The `injectScript('page-ssr', …)` source for the NODE runtime: launch the node SDK on the server. */
export function serverInitScript(appToken: string, options: Record<string, unknown>): string {
  return `import { registerServer } from '@bugsee/astro/server';\nregisterServer(${JSON.stringify(appToken)}, ${JSON.stringify(options)});\n`;
}

/** The `injectScript('page-ssr', …)` source for the EDGE runtime: launch the edge SDK on the server. */
export function edgeServerInitScript(appToken: string, options: Record<string, unknown>): string {
  return `import { registerServerEdge } from '@bugsee/astro/edge';\nregisterServerEdge(${JSON.stringify(appToken)}, ${JSON.stringify(options)});\n`;
}

/**
 * The Bugsee Astro Integration. `integrations: [bugsee({ appToken })]` in `astro.config.mjs`.
 */
export function bugsee(options: BugseeAstroOptions): AstroIntegration {
  const appToken = options.appToken;
  const clientOptions = options.client ?? {};
  const serverOptions = options.server ?? {};
  const isEdge = options.runtime === 'edge';
  return {
    name: '@bugsee/astro',
    hooks: {
      'astro:config:setup': ({ injectScript, addMiddleware }) => {
        // Client (browser) launch on every page.
        injectScript('page', clientInitScript(appToken, clientOptions));
        // Server launch (node or edge) — its per-request context is stitched to by the middleware.
        injectScript(
          'page-ssr',
          isEdge
            ? edgeServerInitScript(appToken, serverOptions)
            : serverInitScript(appToken, serverOptions),
        );
        // The request middleware (error capture + trace), running FIRST so it wraps the whole request.
        addMiddleware({
          entrypoint: isEdge ? '@bugsee/astro/edge' : '@bugsee/astro/middleware',
          order: 'pre',
        });
      },
    },
  };
}
