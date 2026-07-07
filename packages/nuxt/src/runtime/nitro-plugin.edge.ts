// @bugsee/nuxt — the shipped Nitro runtime plugin for EDGE presets. The U1 module `addServerPlugin`s THIS
// file instead of `nitro-plugin` when `nuxt.options.nitro.preset` is an edge preset — so the edge SDK gets
// bundled, never `bugsee/node`. Reads the private `bugsee` runtime config and hands it to the tested edge
// core `installBugseeNitroEdge` (launch edge SDK + report incidents via the `error` hook, flushed under
// `waitUntil`).
//
// Real-package auto-imports (`nitropack/runtime`) + the self-subpath `@bugsee/nuxt/edge` (external in both
// build formats — #172 parity) so tsup builds it and it stays executably testable.
import type { InstallBugseeNitroEdgeOptions } from '@bugsee/nuxt/edge';
import { installBugseeNitroEdge } from '@bugsee/nuxt/edge';
import { defineNitroPlugin, useRuntimeConfig } from 'nitropack/runtime';

export default defineNitroPlugin((nitroApp) => {
  const options = useRuntimeConfig().bugsee as InstallBugseeNitroEdgeOptions;
  installBugseeNitroEdge(nitroApp as never, options);
});
