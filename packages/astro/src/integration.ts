// @bugsee/astro — the Astro Integration (`bugsee()`), the package `.` entry. Users add it to
// `astro.config.mjs`: `integrations: [bugsee({ appToken })]`. At `astro:config:setup` it wires:
//   • `injectScript('page', …)` → the browser SDK launch on the client;
//   • a generated SERVER MIDDLEWARE (a virtual module) that launches the server SDK AND exports `onRequest`,
//     added via `addMiddleware({ order: 'pre' })`. The launch lives IN the middleware (not a page-ssr script)
//     because Astro only prepends `injectScript('page-ssr')` to `.astro` PAGE modules — an endpoint-first
//     cold request (`/api/*` before any page renders) would otherwise never launch the SDK and its error
//     report would be dropped. The middleware runs for EVERY route, so its module-eval launch always fires
//     before the first request is handled.
//
// BUILD-TIME only: imports `astro` TYPES only + generates module source as strings — the runtimes load
// through `@bugsee/astro/{client,server,edge,middleware}` (in the right build context), never eagerly here.
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

/** The virtual module id the generated server middleware is served under. */
export const SERVER_MIDDLEWARE_ID = 'virtual:@bugsee/astro/server-middleware';
const RESOLVED_ID = `\0${SERVER_MIDDLEWARE_ID}`;

/** The `injectScript('page', …)` source: launch the browser SDK on the client. */
export function clientInitScript(appToken: string, options: Record<string, unknown>): string {
  return `import { registerClient } from '@bugsee/astro/client';\nregisterClient(${JSON.stringify(appToken)}, ${JSON.stringify(options)});\n`;
}

/** The generated SERVER MIDDLEWARE module: launch the server SDK (node or edge) at module-eval — which runs
 *  for the FIRST request of ANY route (page OR endpoint) — then export the Bugsee `onRequest`. */
export function serverMiddlewareModule(
  appToken: string,
  options: Record<string, unknown>,
  isEdge: boolean,
): string {
  const token = JSON.stringify(appToken);
  const opts = JSON.stringify(options);
  return isEdge
    ? `import { registerServerEdge, createEdgeMiddleware } from '@bugsee/astro/edge';\nregisterServerEdge(${token}, ${opts});\nexport const onRequest = createEdgeMiddleware();\n`
    : `import { registerServer } from '@bugsee/astro/server';\nimport { createBugseeMiddleware } from '@bugsee/astro/middleware';\nregisterServer(${token}, ${opts});\nexport const onRequest = createBugseeMiddleware();\n`;
}

/**
 * The Bugsee Astro Integration. `integrations: [bugsee({ appToken })]` in `astro.config.mjs`.
 */
export function bugsee(options: BugseeAstroOptions): AstroIntegration {
  const appToken = options.appToken;
  const clientOptions = options.client ?? {};
  const serverOptions = options.server ?? {};
  const moduleCode = serverMiddlewareModule(appToken, serverOptions, options.runtime === 'edge');
  return {
    name: '@bugsee/astro',
    hooks: {
      'astro:config:setup': ({ injectScript, addMiddleware, updateConfig }) => {
        // Client (browser) launch on every page.
        injectScript('page', clientInitScript(appToken, clientOptions));
        // Serve the generated server middleware as a virtual module.
        updateConfig({
          vite: {
            plugins: [
              {
                name: '@bugsee/astro:server-middleware',
                resolveId(id: string) {
                  return id === SERVER_MIDDLEWARE_ID ? RESOLVED_ID : undefined;
                },
                load(id: string) {
                  return id === RESOLVED_ID ? moduleCode : undefined;
                },
              },
            ],
          },
        });
        // Register it FIRST so it wraps the whole request chain (+ its module-eval launches the SDK).
        addMiddleware({ entrypoint: SERVER_MIDDLEWARE_ID, order: 'pre' });
      },
    },
  };
}
